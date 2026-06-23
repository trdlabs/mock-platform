import { describe, it, expect } from 'vitest';
import { parquetColumnsFor } from '../../tools/fetch-snapshot/fetch-snapshot.js';

describe('parquetColumnsFor', () => {
  it('requests the taker columns for schema_version=2 parts', () => {
    const cols = parquetColumnsFor(2);
    expect(cols).toContain('taker_buy_volume_usd');
    expect(cols).toContain('taker_sell_volume_usd');
  });

  it('does NOT request taker columns for schema_version=1 parts', () => {
    const cols = parquetColumnsFor(1);
    expect(cols).not.toContain('taker_buy_volume_usd');
    expect(cols).not.toContain('taker_sell_volume_usd');
  });

  it('always includes the base canonical columns', () => {
    for (const sv of [1, 2] as const) {
      expect(parquetColumnsFor(sv)).toEqual(
        expect.arrayContaining(['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd']),
      );
    }
  });
});
