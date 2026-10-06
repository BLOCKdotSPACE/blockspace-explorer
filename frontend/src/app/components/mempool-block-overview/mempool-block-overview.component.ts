import { Component, ViewChild, Input, Output, EventEmitter,
  OnInit, OnDestroy, OnChanges, ChangeDetectionStrategy, ChangeDetectorRef, AfterViewInit } from '@angular/core';
import { StateService } from '@app/services/state.service';
import { MempoolBlockDelta, isMempoolDelta } from '@interfaces/websocket.interface';
import { TransactionStripped } from '@interfaces/node-api.interface';
import { BlockOverviewGraphComponent } from '@components/block-overview-graph/block-overview-graph.component';
import { Subscription, BehaviorSubject } from 'rxjs';
import { WebsocketService } from '@app/services/websocket.service';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { Router } from '@angular/router';
import { Color } from '@components/block-overview-graph/sprite-types';
import TxView from '@components/block-overview-graph/tx-view';
import { FilterMode, GradientMode, TransactionFlags } from '@app/shared/filters.utils';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { OrdApiService } from '@app/services/ord-api.service';
import { parseTaproot } from '@app/shared/transaction.utils';

@Component({
  selector: 'app-mempool-block-overview',
  templateUrl: './mempool-block-overview.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class MempoolBlockOverviewComponent implements OnInit, OnDestroy, OnChanges, AfterViewInit {
  @Input() index: number;
  @Input() resolution = 86;
  @Input() showFilters: boolean = false;
  @Input() overrideColors: ((tx: TxView) => Color) | null = null;
  @Input() filterFlags: bigint | undefined = undefined;
  @Input() filterMode: FilterMode = 'and';
  @Input() gradientMode: GradientMode = 'fee';
  @Output() txPreviewEvent = new EventEmitter<TransactionStripped | void>();

  @ViewChild('blockGraph') blockGraph: BlockOverviewGraphComponent;

  lastBlockHeight: number;
  blockIndex: number;
  isLoading$ = new BehaviorSubject<boolean>(false);
  timeLtrSubscription: Subscription;
  timeLtr: boolean;
  chainDirection: string = 'right';
  poolDirection: string = 'left';

  blockSub: Subscription;
  firstLoad: boolean = true;

  // txid -> blob URL of witness-decoded inscription content: unconfirmed txs
  // are unknown to ord, so the projected block decodes envelopes client-side
  ordContentUrls: { [txid: string]: string | SafeUrl } = {};
  private ordChecked: Set<string> = new Set();
  private ordBlobUrls: string[] = [];

  constructor(
    public stateService: StateService,
    private websocketService: WebsocketService,
    private router: Router,
    private cd: ChangeDetectorRef,
    private sanitizer: DomSanitizer,
    private electrsApiService: ElectrsApiService,
    private ordApiService: OrdApiService,
  ) { }

  ngOnInit(): void {
    this.timeLtrSubscription = this.stateService.timeLtr.subscribe((ltr) => {
      this.timeLtr = !!ltr;
      this.chainDirection = ltr ? 'left' : 'right';
      this.poolDirection = ltr ? 'right' : 'left';
      this.cd.markForCheck();
    });
  }

  ngAfterViewInit(): void {
    this.blockSub = this.stateService.mempoolBlockUpdate$.subscribe((update) => {
      // process update
      if (isMempoolDelta(update)) {
        // delta
        this.updateBlock(update);
      } else {
        const transactionsStripped = update.transactions;
        // new transactions
        if (this.firstLoad) {
          this.replaceBlock(transactionsStripped);
        } else {
          const inOldBlock = {};
          const inNewBlock = {};
          const added: TransactionStripped[] = [];
          const changed: { txid: string, rate: number | undefined, flags: number, acc: boolean | undefined }[] = [];
          const removed: string[] = [];
          for (const tx of transactionsStripped) {
            inNewBlock[tx.txid] = true;
          }
          for (const txid of Object.keys(this.blockGraph?.scene?.txs || {})) {
            inOldBlock[txid] = true;
            if (!inNewBlock[txid]) {
              removed.push(txid);
            }
          }
          for (const tx of transactionsStripped) {
            if (!inOldBlock[tx.txid]) {
              added.push(tx);
            } else {
              changed.push({
                txid: tx.txid,
                rate: tx.rate,
                flags: tx.flags,
                acc: tx.acc
              });
            }
          }
          this.updateBlock({
            block: this.blockIndex,
            removed,
            changed,
            added
          });
        }
      }
    });
  }

  ngOnChanges(changes): void {
    if (changes.index) {
      this.firstLoad = true;
      if (this.blockGraph) {
        this.blockGraph.clear(changes.index.currentValue > changes.index.previousValue ? this.chainDirection : this.poolDirection);
      }
      if (!this.websocketService.startTrackMempoolBlock(changes.index.currentValue) && this.stateService.mempoolBlockState && this.stateService.mempoolBlockState.block === changes.index.currentValue) {
        this.resumeBlock(Object.values(this.stateService.mempoolBlockState.transactions));
      } else {
        this.isLoading$.next(true);
      }
    }
  }

  ngOnDestroy(): void {
    this.blockGraph?.destroy();
    this.blockSub.unsubscribe();
    this.timeLtrSubscription.unsubscribe();
    this.websocketService.stopTrackMempoolBlock();
    this.ordBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  }

  // fetch + decode the largest inscription-flagged txs in this projected
  // block so their content shows inside the transaction squares
  private refreshOrdContent(txs: TransactionStripped[], removed: string[] = []): void {
    let changed = false;
    for (const txid of removed) {
      if (this.ordContentUrls[txid]) {
        delete this.ordContentUrls[txid];
        changed = true;
      }
    }
    if (changed) {
      this.ordContentUrls = { ...this.ordContentUrls };
      this.cd.markForCheck();
    }
    const candidates = (txs || [])
      .filter((tx) => tx.flags && (BigInt(tx.flags) & TransactionFlags.inscription) && !this.ordChecked.has(tx.txid))
      .sort((a, b) => b.vsize - a.vsize)
      .slice(0, 24);
    for (const tx of candidates) {
      this.ordChecked.add(tx.txid);
      this.electrsApiService.getTransaction$(tx.txid).subscribe((fullTx) => {
        for (const vin of fullTx.vin || []) {
          const script = vin.witness ? parseTaproot(vin.witness)?.scriptPath?.script : null;
          if (!script || !script.includes('0063036f7264')) {
            continue;
          }
          const inscriptions = this.ordApiService.decodeInscriptions(script) || [];
          const insc = inscriptions.find((i) =>
            (i.content_type_str || '').startsWith('image/') && i.body?.length && !i.is_cropped && !i.content_encoding_str);
          if (insc) {
            const blobUrl = URL.createObjectURL(new Blob([insc.body as BlobPart], { type: insc.content_type_str }));
            this.ordBlobUrls.push(blobUrl);
            this.ordContentUrls = { ...this.ordContentUrls, [tx.txid]: this.sanitizer.bypassSecurityTrustUrl(blobUrl) };
            this.cd.markForCheck();
            break;
          }
        }
      });
    }
  }

  replaceBlock(transactionsStripped: TransactionStripped[]): void {
    const blockMined = (this.stateService.latestBlockHeight > this.lastBlockHeight);
    if (this.blockIndex !== this.index) {
      const direction = (this.blockIndex == null || this.index < this.blockIndex) ? this.poolDirection : this.chainDirection;
      this.blockGraph.enter(transactionsStripped, direction);
    } else {
      this.blockGraph.replace(transactionsStripped, blockMined ? this.chainDirection : this.poolDirection);
    }

    this.lastBlockHeight = this.stateService.latestBlockHeight;
    this.blockIndex = this.index;
    this.isLoading$.next(false);
    this.refreshOrdContent(transactionsStripped);
  }

  updateBlock(delta: MempoolBlockDelta): void {
    const blockMined = (this.stateService.latestBlockHeight > this.lastBlockHeight);
    if (this.blockIndex !== this.index) {
      const direction = (this.blockIndex == null || this.index < this.blockIndex) ? this.poolDirection : this.chainDirection;
      this.blockGraph.replace(delta.added, direction);
    } else {
      if (blockMined) {
        this.blockGraph.update(delta.added, delta.removed, delta.changed || [], blockMined ? this.chainDirection : this.poolDirection, blockMined);
      } else {
        this.blockGraph.deferredUpdate(delta.added, delta.removed, delta.changed || [], this.poolDirection);
      }
    }

    this.lastBlockHeight = this.stateService.latestBlockHeight;
    this.blockIndex = this.index;
    this.isLoading$.next(false);
    this.refreshOrdContent(delta.added as TransactionStripped[], delta.removed);
  }

  resumeBlock(transactionsStripped: TransactionStripped[]): void {
    if (this.blockGraph) {
      this.firstLoad = false;
      this.blockGraph.setup(transactionsStripped, true);
      this.blockIndex = this.index;
      this.isLoading$.next(false);
      this.refreshOrdContent(transactionsStripped);
    } else {
      requestAnimationFrame(() => {
        this.resumeBlock(transactionsStripped);
      });
    }
  }

  onTxClick(event: { tx: TransactionStripped, keyModifier: boolean }): void {
    const url = new RelativeUrlPipe(this.stateService).transform(`/tx/${event.tx.txid}`);
    if (!event.keyModifier) {
      this.router.navigate([url]);
    } else {
      window.open(url, '_blank');
    }
  }
}
