import { formatNumber } from '@angular/common';
import { Inject, LOCALE_ID, Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'feeRounding',
  standalone: false,
})
export class FeeRoundingPipe implements PipeTransform {
  constructor(
    @Inject(LOCALE_ID) private locale: string,
  ) {}

  transform(fee: number, rounding = null, dp = 3): string {
    // SUB-1 sat/vB RATES (block.space, 2026-10-21): the block views ask for
    // whole numbers ('1.0-0'), which printed a 0.14 sat/vB median — the
    // common rate since sub-1 relay — as "~0 sat/vB", and 53 of a day's full
    // blocks read 0. A whole-number request for a rate strictly between 0 and
    // 1 shows two decimals instead; rates of 1 and above keep their rounding.
    if (rounding === '1.0-0' && fee > 0 && fee < 1) {
      return formatNumber(fee, this.locale, '1.2-2');
    }
    if (rounding) {
      return formatNumber(fee, this.locale, rounding);
    }

    if (fee >= Math.pow(10, (dp || 3) - 1)) {
      return formatNumber(fee, this.locale, '1.0-0');
    } else if (fee < Math.pow(10, (dp || 3) - 2)) {
      return formatNumber(fee, this.locale, '1.2-2');
    }
    return formatNumber(fee, this.locale, '1.1-1');
  }
}
