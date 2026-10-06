#!/usr/bin/env node
//
// explore.block.space frontend server — replaces the nginx inside
// mempool/frontend:latest (docker-web-1) as part of the 2026-08-04 move off
// Docker. Plain Node, no dependencies, matching the *-lite services already on
// 4086/4087/4088 rather than adding nginx (which would need root to install).
//
// It reproduces exactly what the container's nginx-mempool.conf did. The route
// ORDER matters and mirrors nginx's longest-prefix-wins matching:
//
//   /api/v1/ws        -> ws://backend/            (websocket upgrade)
//   /api/v1/services  -> https://mempool.space    (external; accelerator etc.)
//   /api/v1           -> http://backend/api/v1    (path preserved)
//   /api/             -> http://backend/api/v1/   (REWRITTEN, /api/x -> /api/v1/x)
//   everything else   -> static, SPA-fallback to index.html
//
// Getting /api/ vs /api/v1 backwards silently breaks half the explorer, so the
// rewrite is spelled out rather than inferred.

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT    = path.join(__dirname, 'dist/mempool/browser');
const PORT    = parseInt(process.env.FRONTEND_HTTP_PORT || '4080', 10);
const BACKEND = { host: process.env.BACKEND_HOST || '127.0.0.1',
                  port: parseInt(process.env.BACKEND_PORT || '8999', 10) };
const SERVICES_HOST = 'mempool.space';

// Local BLOCKSPACE services surfaced through the explorer origin so the
// Angular app can fetch inscription/counter content same-origin:
//   /ord-api/*      -> ord server (OPI fleet) — /content/<id>, /inscription/<id> (JSON)
//   /counters-api/* -> Bitcoin Counters prod server — /counters, /content/<n>
const LOCAL_UPSTREAMS = [
  { prefix: '/ord-api/',      host: process.env.ORD_HOST      || '127.0.0.1', port: parseInt(process.env.ORD_PORT      || '80', 10) },
  { prefix: '/counters-api/', host: process.env.COUNTERS_HOST || '127.0.0.1', port: parseInt(process.env.COUNTERS_PORT || '8081', 10) },
];

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.mjs':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.eot':'application/vnd.ms-fontobject',
  '.map':'application/json; charset=utf-8', '.txt':'text/plain; charset=utf-8',
  '.webmanifest':'application/manifest+json', '.wasm':'application/wasm',
};

function proxy(req, res, targetPath) {
  const opts = { host: BACKEND.host, port: BACKEND.port, method: req.method,
                 path: targetPath, headers: { ...req.headers, host: `${BACKEND.host}:${BACKEND.port}` } };
  const up = http.request(opts, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, {'content-type':'text/plain'});
    res.end(`backend unreachable: ${e.message}\n`);
  });
  req.pipe(up);
}

function proxyServices(req, res) {
  const opts = { host: SERVICES_HOST, port: 443, method: req.method, path: req.url,
                 headers: { ...req.headers, host: SERVICES_HOST } };
  const up = https.request(opts, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', (e) => {
    // Upstream is the internet; the local explorer must not 500 when it is down.
    if (!res.headersSent) res.writeHead(502, {'content-type':'application/json'});
    res.end(JSON.stringify({ error: 'services upstream unreachable', detail: e.message }));
  });
  req.pipe(up);
}

function proxyLocal(req, res, target, targetPath) {
  const opts = { host: target.host, port: target.port, method: req.method,
                 path: targetPath, headers: { ...req.headers, host: `${target.host}:${target.port}` } };
  const up = http.request(opts, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, {'content-type':'application/json'});
    res.end(JSON.stringify({ error: 'local upstream unreachable', detail: e.message }));
  });
  req.pipe(up);
}

// The Angular build is LOCALISED: dist/mempool/browser/<locale>/index.html, 33
// locales plus a shared resources/. There is NO top-level index.html, so a naive
// flat static server 404s on literally every page. The container's nginx did:
//
//   try_files /$lang/$uri /$lang/$uri/ $uri $uri/ /en-US/$uri @index-redirect
//
// with $lang mapped from Accept-Language, falling back to /en-US/index.html.
// This reproduces that: explicit /<locale>/ prefix wins, else Accept-Language if
// we built that locale, else en-US.
const LOCALES = new Set(
  fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'resources')
    .map((d) => d.name)
);
const DEFAULT_LOCALE = LOCALES.has('en-US') ? 'en-US' : [...LOCALES][0];

function pickLocale(req) {
  const header = req.headers['accept-language'] || '';
  for (const part of header.split(',')) {
    const tag = part.split(';')[0].trim();
    if (!tag) continue;
    if (LOCALES.has(tag)) return tag;                 // exact, e.g. en-US
    const base = tag.split('-')[0];
    if (LOCALES.has(base)) return base;               // e.g. de-DE -> de
    const hit = [...LOCALES].find((l) => l.split('-')[0] === base);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const segs = urlPath.split('/').filter(Boolean);
  const explicit = segs.length && LOCALES.has(segs[0]) ? segs[0] : null;
  const locale = explicit || pickLocale(req);
  const rest = explicit ? '/' + segs.slice(1).join('/') : urlPath;

  // Candidates in nginx's order. resources/ is shared across locales and must
  // resolve from the root, not from inside a locale dir.
  const candidates = urlPath.startsWith('/resources/')
    ? [path.join(ROOT, urlPath)]
    : [path.join(ROOT, locale, rest), path.join(ROOT, urlPath), path.join(ROOT, DEFAULT_LOCALE, rest)];

  const fallback = path.join(ROOT, locale, 'index.html');

  (function tryNext(i) {
    if (i >= candidates.length) return sendFile(fallback, true);
    let file = path.normalize(candidates[i]);
    // Contain the path: never let ../ escape ROOT.
    if (!file.startsWith(ROOT)) return tryNext(i + 1);
    fs.stat(file, (err, st) => {
      if (err) return tryNext(i + 1);
      if (st.isDirectory()) file = path.join(file, 'index.html');
      sendFile(file, false, () => tryNext(i + 1));
    });
  })(0);

  function sendFile(file, isFallback, onMissing) {
    fs.readFile(file, (err2, buf) => {
      if (err2) {
        if (onMissing) return onMissing();
        // SPA fallback: Angular routes like /block/123 are not files on disk.
        return fs.readFile(path.join(ROOT, DEFAULT_LOCALE, 'index.html'), (e3, idx) => {
          if (e3) { res.writeHead(404, {'content-type':'text/plain'}); return res.end('not found'); }
          res.writeHead(200, {'content-type':'text/html; charset=utf-8', 'cache-control':'no-cache'});
          res.end(idx);
        });
      }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
      // Hashed build assets are immutable; index.html must never be cached or
      // clients pin to a stale bundle after a deploy.
      headers['cache-control'] = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
      res.writeHead(200, headers);
      res.end(buf);
    });
  }
}

const server = http.createServer((req, res) => {
  const u = req.url || '/';
  // Temporary access log (2026-08-14): diagnosing whether public traffic
  // reaches this box and which bundle files clients pull. Remove when done.
  console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${u.slice(0, 120)} "${(req.headers['user-agent'] || '').slice(0, 60)}"`);
  if (u.startsWith('/api/v1/services')) return proxyServices(req, res);
  if (u.startsWith('/api/v1'))          return proxy(req, res, u);
  if (u.startsWith('/api/'))            return proxy(req, res, '/api/v1/' + u.slice('/api/'.length));
  if (u === '/api')                     return proxy(req, res, '/api/v1');
  for (const t of LOCAL_UPSTREAMS) {
    if (u.startsWith(t.prefix)) return proxyLocal(req, res, t, '/' + u.slice(t.prefix.length));
  }
  return serveStatic(req, res);
});

// Websocket: /api/v1/ws -> backend '/'. Without this the mempool visualisation
// never updates and the block list sits frozen at page load.
server.on('upgrade', (req, socket, head) => {
  const target = (req.url || '').startsWith('/api/v1/ws') ? '/' : req.url;
  const up = http.request({ host: BACKEND.host, port: BACKEND.port, path: target,
                            headers: { ...req.headers, host: `${BACKEND.host}:${BACKEND.port}` } });
  up.end();
  up.on('upgrade', (r, upSocket, upHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.unshift(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`explore.block.space frontend on 0.0.0.0:${PORT}`);
  console.log(`  static  ${ROOT}`);
  console.log(`  backend http://${BACKEND.host}:${BACKEND.port}`);
});
