import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, forkJoin, map, Observable, of, switchMap, tap } from 'rxjs';
import { Inscription } from '@app/shared/ord/inscription.utils';
import { Transaction } from '@interfaces/electrs.interface';
import { getNextInscriptionMark, hexToBytes, extractInscriptionData } from '@app/shared/ord/inscription.utils';
import { decipherRunestone, Runestone, Etching, UNCOMMON_GOODS } from '@app/shared/ord/rune.utils';
import { ElectrsApiService } from '@app/services/electrs-api.service';


@Injectable({
  providedIn: 'root'
})
export class OrdApiService {

  constructor(
    private electrsApiService: ElectrsApiService,
    private httpClient: HttpClient,
  ) { }

  // Inscription metadata (number, timestamp, sat...) from the local ord server,
  // proxied same-origin at /ord-api by serve-native.js. Null when unindexed
  // (e.g. unconfirmed tx) or when ord is unreachable.
  // All inscriptions revealed in a block, as a txid -> content URL map
  // (first inscription per transaction). Empty map when ord is unreachable.
  getBlockOrdContentUrls$(height: number): Observable<{ [txid: string]: string }> {
    return this.httpClient.get<any>(`/ord-api/block/${height}`, { headers: { accept: 'application/json' } }).pipe(
      map((block) => {
        const urls: { [txid: string]: string } = {};
        for (const id of block?.inscriptions || []) {
          const txid = id.slice(0, 64);
          if (!urls[txid]) {
            urls[txid] = `/ord-api/content/${id}`;
          }
        }
        return urls;
      }),
      catchError(() => of({})),
    );
  }

  getInscriptionInfo$(inscriptionId: string): Observable<any> {
    return this.httpClient.get(`/ord-api/inscription/${inscriptionId}`, { headers: { accept: 'application/json' } }).pipe(
      catchError(() => of(null)),
    );
  }

  decodeRunestone$(tx: Transaction): Observable<{ runestone: Runestone, runeInfo: { [id: string]: { etching: Etching; txid: string; } } }> {
    const runestone = decipherRunestone(tx);
    const runeInfo: { [id: string]: { etching: Etching; txid: string; } } = {};

    if (runestone) {
      const runesToFetch: Set<string> = new Set();

      if (runestone.mint) {
        runesToFetch.add(runestone.mint.toString());
      }

      if (runestone.edicts.length) {
        runestone.edicts.forEach(edict => {
          runesToFetch.add(edict.id.toString());
        });
      }

      if (runesToFetch.size) {
        const runeEtchingObservables = Array.from(runesToFetch).map(runeId => this.getEtchingFromRuneId$(runeId));

        return forkJoin(runeEtchingObservables).pipe(
          map((etchings) => {
            etchings.forEach((el) => {
              if (el) {
                runeInfo[el.runeId] = { etching: el.etching, txid: el.txid };
              }
            });
            return { runestone: runestone, runeInfo };
          })
        );
      }
      return of({ runestone: runestone, runeInfo });
    } else {
      return of({ runestone: null, runeInfo: {} });
    }
  }

  // Get etching from runeId by looking up the transaction that etched the rune
  getEtchingFromRuneId$(runeId: string): Observable<{ runeId: string; etching: Etching; txid: string; }> {
    if (runeId === '1:0') {
      return of({ runeId, etching: UNCOMMON_GOODS, txid: '0000000000000000000000000000000000000000000000000000000000000000' });
    } else {
      const [blockNumber, txIndex] = runeId.split(':');
      return this.electrsApiService.getBlockHashFromHeight$(parseInt(blockNumber)).pipe(
        switchMap(blockHash => this.electrsApiService.getBlockTxId$(blockHash, parseInt(txIndex))),
        switchMap(txId => this.electrsApiService.getTransaction$(txId)),
        switchMap(tx => {
          const runestone = decipherRunestone(tx);
          if (runestone) {
            const etching = runestone.etching;
            if (etching) {
              return of({ runeId, etching, txid: tx.txid });
            }
          }
          return of(null);
        }),
        catchError(() => of(null))
      );
    }
  }

  decodeInscriptions(witness: string): Inscription[] | null {

    const inscriptions: Inscription[] = [];
    const raw = hexToBytes(witness);
    let startPosition = 0;

    while (true) {
      const pointer = getNextInscriptionMark(raw, startPosition);
      if (pointer === -1) {break;}

      const inscription = extractInscriptionData(raw, pointer);
      if (inscription) {
        inscriptions.push(inscription);
      }

      startPosition = pointer;
    }

    return inscriptions;
  }
}
