import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Runestone, Etching } from '@app/shared/ord/rune.utils';
import { Inscription } from '@app/shared/ord/inscription.utils';
import { OrdApiService } from '@app/services/ord-api.service';
import { isSvgUrl } from '@app/shared/image.utils';

export interface InscriptionPreview {
  ordId: string | null;
  contentType: string;
  src: SafeUrl | string | null;
  blobUrl?: string;
  number?: number;
  fallbackTried?: boolean;
  native?: boolean;
}

@Component({
  selector: 'app-ord-data',
  templateUrl: './ord-data.component.html',
  styleUrls: ['./ord-data.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OrdDataComponent implements OnChanges, OnDestroy {
  @Input() inscriptions: Inscription[];
  @Input() runestone: Runestone;
  @Input() runeInfo: { [id: string]: { etching: Etching; txid: string } };
  @Input() type: 'vin' | 'vout';
  // Genesis id parts: an inscription revealed by this tx has id `${txid}i${indexOffset + i}`
  @Input() txid: string;
  @Input() indexOffset: number = 0;

  toNumber = (value: bigint): number => Number(value);

  // Inscriptions
  inscriptionsData: { [key: string]: { count: number, totalSize: number, text?: string; json?: JSON; tag?: string; delegate?: string } };
  previews: InscriptionPreview[] = [];
  private blobUrls: string[] = [];
  // Rune mints
  minted: number;
  // Rune transfers
  transferredRunes: { key: string; etching: Etching; txid: string }[] = [];

  constructor(
    private ordApiService: OrdApiService,
    private sanitizer: DomSanitizer,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.runestone && this.runestone) {
      if (this.runestone.mint && this.runeInfo[this.runestone.mint.toString()]) {
        const mint = this.runestone.mint.toString();
        const terms = this.runeInfo[mint].etching.terms;
        const amount = terms?.amount;
        const divisibility = this.runeInfo[mint].etching.divisibility;
        if (amount) {
          this.minted = this.getAmount(amount, divisibility);
        }
      }

      this.runestone.edicts.forEach(edict => {
        if (this.runeInfo[edict.id.toString()]) {
          this.transferredRunes.push({ key: edict.id.toString(), ...this.runeInfo[edict.id.toString()] });
        }
      });
    }

    if (changes.inscriptions && this.inscriptions) {

      if (this.inscriptions?.length) {
        this.inscriptionsData = {};
        this.inscriptions.forEach((inscription) => {
          // General: count, total size, delegate
          const key = inscription.content_type_str || 'undefined';
          if (!this.inscriptionsData[key]) {
            this.inscriptionsData[key] = { count: 0, totalSize: 0 };
          }
          this.inscriptionsData[key].count++;
          this.inscriptionsData[key].totalSize += inscription.body_length;
          if (inscription.delegate_txid && !this.inscriptionsData[key].delegate) {
            this.inscriptionsData[key].delegate = inscription.delegate_txid;
          }

          // Text / JSON data
          if ((key.includes('text') || key.includes('json')) && !inscription.is_cropped && !this.inscriptionsData[key].text && !this.inscriptionsData[key].json) {
            const decoder = new TextDecoder('utf-8');
            // cap the DOM cost: only the first 100kB of huge text bodies
            const text = decoder.decode(inscription.body.slice(0, 100_000));
            try {
              this.inscriptionsData[key].json = JSON.parse(text);
              if (this.inscriptionsData[key].json['p']) {
                this.inscriptionsData[key].tag = this.inscriptionsData[key].json['p'].toUpperCase();
              }
            } catch (e) {
              this.inscriptionsData[key].text = text;
            }
          }
        });

        this.buildPreviews();
      }
    }
  }

  ngOnDestroy(): void {
    this.clearPreviews();
  }

  // Visible media previews inside the transaction box. Bodies decoded from the
  // witness render locally via blob URLs (works for unconfirmed txs too);
  // cropped / compressed / delegate inscriptions fall back to the local ord
  // server's /content endpoint.
  private buildPreviews(): void {
    this.clearPreviews();
    this.inscriptions.slice(0, 8).forEach((inscription, i) => {
      const ordId = this.txid ? `${this.txid}i${(this.indexOffset || 0) + i}` : null;
      const contentType = inscription.content_type_str || '';
      let preview: InscriptionPreview = null;

      // svg = native margin extension (the vector paints its own letterbox);
      // delegates have an unknown type until the content server answers
      const native = contentType.includes('svg') ? true : undefined;
      if (inscription.delegate_txid) {
        preview = { ordId, contentType, native: undefined, src: `/ord-api/content/${inscription.delegate_txid}i${inscription.delegate_index || 0}` };
      } else if (contentType.startsWith('image/')) {
        if (inscription.body?.length && !inscription.is_cropped && !inscription.content_encoding_str) {
          const blobUrl = URL.createObjectURL(new Blob([inscription.body as BlobPart], { type: contentType }));
          this.blobUrls.push(blobUrl);
          preview = { ordId, contentType, native, src: this.sanitizer.bypassSecurityTrustUrl(blobUrl), blobUrl };
        } else if (ordId) {
          preview = { ordId, contentType, native, src: `/ord-api/content/${ordId}` };
        }
      }

      if (preview) {
        this.previews.push(preview);
        if (ordId) {
          this.ordApiService.getInscriptionInfo$(ordId).subscribe((info) => {
            if (info && typeof info.number === 'number') {
              preview.number = info.number;
              this.cd.markForCheck();
            }
          });
        }
      }
    });
  }

  onPreviewLoaded(preview: InscriptionPreview, event: Event): void {
    // unknown type (delegate content): ask the server whether it's an SVG,
    // which re-renders natively at the full box and paints its own margins
    if (preview.native === undefined && typeof preview.src === 'string') {
      isSvgUrl(preview.src).then((svg) => {
        preview.native = svg;
        this.cd.markForCheck();
      });
    }
  }

  onPreviewError(preview: InscriptionPreview): void {
    // A body that the browser refuses to render (or a stale blob) gets one
    // retry through the ord server, then the preview is dropped.
    if (!preview.fallbackTried && preview.ordId && preview.blobUrl) {
      preview.fallbackTried = true;
      preview.src = `/ord-api/content/${preview.ordId}`;
    } else {
      preview.src = null;
    }
    this.cd.markForCheck();
  }

  private clearPreviews(): void {
    this.blobUrls.forEach((url) => URL.revokeObjectURL(url));
    this.blobUrls = [];
    this.previews = [];
  }

  getAmount(amount: bigint, divisibility: number): number {
    const divisor = BigInt(10) ** BigInt(divisibility);
    const result = amount / divisor;

    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : Number.MAX_SAFE_INTEGER;
  }
}
