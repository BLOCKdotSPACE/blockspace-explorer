import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, map, Observable, of, shareReplay } from 'rxjs';

// Bitcoin Counters — numbered inscriptions stored in witness data and owned
// through Counterparty assets. Served by the local counters server (:8081),
// proxied same-origin at /counters-api by serve-native.js.
export interface Counter {
  number: number;
  asset: string;
  kind: string;
  content_type: string;
  size: number;
  owner: string;
  txid: string;
  block: number;
  supply: number;
  divisible: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class CountersApiService {
  private countersByTxid$: Observable<Map<string, Counter[]>>;

  constructor(
    private httpClient: HttpClient,
  ) { }

  getCountersByTxid$(): Observable<Map<string, Counter[]>> {
    if (!this.countersByTxid$) {
      // the server caps the default page at 120 — ask for everything
      this.countersByTxid$ = this.httpClient.get<{ counters: Counter[] }>('/counters-api/counters?limit=10000').pipe(
        map((response) => {
          const byTxid = new Map<string, Counter[]>();
          for (const counter of response?.counters || []) {
            if (!counter?.txid) {
              continue;
            }
            const list = byTxid.get(counter.txid) || [];
            list.push(counter);
            byTxid.set(counter.txid, list);
          }
          return byTxid;
        }),
        catchError(() => of(new Map<string, Counter[]>())),
        shareReplay(1),
      );
    }
    return this.countersByTxid$;
  }

  contentUrl(counter: Counter): string {
    return `/counters-api/content/${counter.number}`;
  }
}
