#!/bin/bash
# tools/autodeploy.sh — explore.block.space follows GitHub.
#
# Run every minute by blockspace-explorer-deploy.timer. Fetches origin/master
# (the repo is public, so no key is needed), fast-forwards the checkout, and
# rebuilds whichever half changed:
#
#   backend/   tsc into backend/dist-next, swap into place, restart mempool-api,
#              wait until its chain tip is within 3 blocks of bitcoind.
#   frontend/  the full localized production build into frontend/dist-next
#              (34 s, ~4 GB, on the E-cores), themes and resources copied the
#              way `npm run sync-assets` does minus its network downloads,
#              swap into place, restart mempool-web, smoke-check.
#   frontend/serve-native.js alone  → just restart mempool-web.
#
# A failed build leaves the live dist untouched. A failed smoke check swaps the
# previous dist back, restarts, stashes any local edits and resets the checkout
# to the previous commit, so a bad push costs one restart, not the site.
# Refuses a checkout with uncommitted tracked edits or a non-fast-forward origin.
#
# Manual runs: tools/autodeploy.sh --force-frontend | --force-backend rebuilds
# that half even when nothing changed. Pool logos and other downloaded assets
# are carried over from the previous dist; refresh them by hand with
# `cd frontend && npm run sync-assets` when needed.
#
# Whole body in a function so bash parses it before a pull can rewrite it.

main() {
  set -u
  local repo=${REPO:-/home/noderunner/BLOCKSPACE/blockspace-explorer}
  local branch=${BRANCH:-master}
  local node_bin=${NODE_BIN:-/home/noderunner/.nvm/versions/node/v24.13.0/bin}
  local build_cpus=${BUILD_CPUS:-16-27}      # E-cores; builds never steal from the indexers (BTI/tools/cpu-plan.sh)
  local web_unit=mempool-web.service api_unit=mempool-api.service
  local web_port=4080 api_port=8999
  local force=${1:-}
  export PATH="$node_bin:$PATH"

  log()   { echo "autodeploy: $*"; }
  build() { nice -n 10 taskset -c "$build_cpus" "$@"; }
  node_height() {
    python3 - "$repo/backend/mempool-config.json" <<'PY' 2>/dev/null
import json,sys,urllib.request,base64
c=json.load(open(sys.argv[1]))["CORE_RPC"]
req=urllib.request.Request(f"http://{c['HOST']}:{c['PORT']}/",data=b'{"method":"getblockcount"}',
  headers={"Authorization":"Basic "+base64.b64encode(f"{c['USERNAME']}:{c['PASSWORD']}".encode()).decode()})
print(json.load(urllib.request.urlopen(req,timeout=10))["result"])
PY
  }
  http() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1"; }
  api_ok() {   # process up and its in-memory tip following the node
    [ "$(http http://127.0.0.1:$api_port/api/v1/backend-info)" = 200 ] || return 1
    local tip node; tip=$(curl -s --max-time 10 http://127.0.0.1:$api_port/api/v1/blocks/tip/height | grep -E '^[0-9]+$'); node=$(node_height)
    [ -n "$tip" ] && [ -n "$node" ] && [ $(( node - tip )) -le 3 ]
  }
  web_ok() {
    [ "$(http http://127.0.0.1:$web_port/)" = 200 ] && [ "$(http http://127.0.0.1:$web_port/en-US/index.html)" = 200 ] \
      && [ "$(http http://127.0.0.1:$web_port/api/v1/blocks/tip/height)" = 200 ]
  }
  settle() {   # $1 = check function, $2 = seconds of wall clock to allow
    local deadline=$(( $(date +%s) + $2 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do "$1" && return 0; sleep 3; done
    return 1
  }
  swap_in()  { rm -rf "$1/dist.prev"; mv "$1/dist" "$1/dist.prev" && mv "$1/dist-next" "$1/dist"; }
  swap_back(){ rm -rf "$1/dist-next"; mv "$1/dist" "$1/dist-next" && mv "$1/dist.prev" "$1/dist"; }

  cd "$repo" || { log "no checkout at $repo"; return 1; }
  git fetch -q origin "$branch" || { log "fetch failed"; return 1; }
  local old new deployed marker=.git/autodeploy-deployed
  old=$(git rev-parse HEAD); new=$(git rev-parse "origin/$branch")
  # The marker is the commit the units were last (re)built and restarted on;
  # the deploy is the diff from it, so a commit made in this checkout and
  # pushed (HEAD already equal to origin) still deploys (2026-10-07 lesson
  # from blockspace-site).
  deployed=$(cat "$marker" 2>/dev/null)
  if [ -z "$deployed" ]; then echo "$old" > "$marker"; deployed=$old; fi
  [ "$old" = "$new" ] && [ "$deployed" = "$old" ] && [ -z "$force" ] && return 0

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "REFUSING ${new:0:7}: the checkout has uncommitted edits; commit, stash or discard them"; return 1
  fi
  if ! git merge-base --is-ancestor "$old" "$new"; then
    log "REFUSING ${new:0:7}: origin/$branch is not a fast-forward of ${old:0:7}"; return 1
  fi

  local changed=""
  if [ "$old" != "$new" ]; then
    git merge -q --ff-only "origin/$branch" || { log "fast-forward failed"; return 1; }
    log "updated ${old:0:7} -> ${new:0:7}"
  fi
  if [ "$deployed" != "$new" ]; then
    changed=$(git diff --name-only "$deployed" "$new")
    log "deploying ${deployed:0:7} -> ${new:0:7} ($(echo "$changed" | grep -c .) files): $(echo "$changed" | head -5 | tr '\n' ' ')"
  fi

  local do_be=0 do_fe=0 do_web=0
  echo "$changed" | grep -E '^backend/'  | grep -qvE '\.md$'                        && do_be=1
  echo "$changed" | grep -E '^frontend/' | grep -qvE '(\.md$|^frontend/serve-native\.js$)' && do_fe=1
  echo "$changed" | grep -qE '^frontend/serve-native\.js$'                            && do_web=1
  [ "$force" = --force-backend ]  && do_be=1
  [ "$force" = --force-frontend ] && do_fe=1
  if [ $do_be = 0 ] && [ $do_fe = 0 ] && [ $do_web = 0 ]; then log "nothing served changed; no rebuild"; echo "$new" > "$marker"; return 0; fi

  rollback() {   # $1 = which half to swap back (or "none")
    [ "$1" = backend ]  && { swap_back backend;  systemctl --user restart "$api_unit"; }
    [ "$1" = frontend ] && { swap_back frontend; systemctl --user restart "$web_unit"; }
    if [ "$deployed" != "$new" ]; then
      if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        git stash push -q -m "autodeploy rollback $(date +%FT%T): local edits found while reverting ${new:0:7}" \
          && log "local edits found during rollback — saved as the newest 'git stash' entry, NOT discarded"
      fi
      git reset -q --hard "$deployed"
    fi
    echo "$deployed" > "$marker"
    log "rolled back to ${deployed:0:7}"
  }

  if [ $do_be = 1 ]; then
    if echo "$changed" | grep -q '^backend/package-lock.json$'; then
      log "backend lockfile changed: npm ci (this runs the rust/gbt preinstall; minutes)"
      (cd backend && build env CI=true npm ci --no-audit --no-fund --silent) || { log "backend npm ci failed; nothing deployed"; rollback none; return 1; }
    fi
    rm -rf backend/dist-next
    (cd backend && build ./node_modules/typescript/bin/tsc -p tsconfig.build.json --outDir dist-next) \
      || { log "backend build failed; live backend untouched"; rollback none; return 1; }
    mkdir -p backend/dist-next/tasks && cp backend/src/tasks/price-feeds/mtgox-weekly.json backend/dist-next/tasks/
    (cd backend && node dist-next/api/fetch-version.js >/dev/null 2>&1) || true
    swap_in backend && systemctl --user restart "$api_unit"
    if settle api_ok 180; then log "backend restarted at ${new:0:7}; tip following the node"
    else log "backend at ${new:0:7} failed its check"; rollback backend; return 1; fi
  fi

  if [ $do_fe = 1 ]; then
    if echo "$changed" | grep -q '^frontend/package-lock.json$'; then
      log "frontend lockfile changed: npm ci"
      (cd frontend && build env CI=true npm ci --no-audit --no-fund --silent) || { log "frontend npm ci failed; nothing deployed"; rollback none; return 1; }
    fi
    rm -rf frontend/dist-next
    (cd frontend && build bash -c 'npm run -s generate-themes && npm run -s generate-config && ./node_modules/@angular/cli/bin/ng.js build --configuration production --localize --output-path dist-next/mempool/browser' >/tmp/autodeploy-frontend-build.log 2>&1) \
      || { log "frontend build failed (see /tmp/autodeploy-frontend-build.log); live frontend untouched"; rollback none; return 1; }
    local d
    for d in frontend/dist-next/mempool/browser/*/; do cp frontend/.theme-build/*.css "$d" 2>/dev/null; done
    mkdir -p frontend/dist-next/mempool/browser/resources
    rsync -a frontend/src/resources/ frontend/dist-next/mempool/browser/resources/
    [ -d frontend/dist/mempool/browser/resources ] && rsync -a --ignore-existing frontend/dist/mempool/browser/resources/ frontend/dist-next/mempool/browser/resources/
    swap_in frontend && systemctl --user restart "$web_unit"
    if settle web_ok 60; then log "frontend rebuilt and serving at ${new:0:7} ($(ls frontend/dist/mempool/browser | wc -l) locale dirs)"
    else log "frontend at ${new:0:7} failed its check"; rollback frontend; return 1; fi
  elif [ $do_web = 1 ]; then
    systemctl --user restart "$web_unit"
    if settle web_ok 60; then log "serve-native restarted at ${new:0:7}"; else log "serve-native failed after restart"; rollback none; return 1; fi
  fi
  echo "$new" > "$marker"
  return 0
}

main "$@"
exit $?
