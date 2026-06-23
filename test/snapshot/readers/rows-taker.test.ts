import { describe, it, expect } from 'vitest';
import { readRows } from '../../../src/snapshot/readers/rows.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../../src/contract/historical-read/dto.js';

const takerRow: CanonicalRowV2 = {
  schema_version: 2,
  minute_ts: 1_781_220_000_000,
  symbol: 'ESPORTSUSDT',
  open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, turnover: 150,
  oi_total_usd: null, funding_rate: null, liq_long_usd: null, liq_short_usd: null,
  has_oi: false, has_funding: false, has_liquidations: false,
  taker_buy_volume_usd: 600, taker_sell_volume_usd: 400, has_taker_flow: true,
};

describe('readRows + taker', () => {
  it('returns rowsBySymbol verbatim including taker when present', () => {
    const bundle = { historical: { rowsBySymbol: { ESPORTSUSDT: [takerRow] } } } as unknown as SnapshotBundle;
    const out = readRows(bundle, { symbol: 'ESPORTSUSDT' });
    expect(out).toHaveLength(1);
    expect(out[0]!.has_taker_flow).toBe(true);
    expect(out[0]!.taker_buy_volume_usd).toBe(600);
    expect(out[0]!.taker_sell_volume_usd).toBe(400);
  });

  it('synth fallback (no rowsBySymbol) reports has_taker_flow=false', () => {
    const bundle = {
      historical: {
        barsBySymbolAndTimeframe: { ESPORTSUSDT: { '1h': [{ tsMs: 1_781_220_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }] } },
        fundingBySymbol: {}, openInterestBySymbol: {}, liquidationsBySymbol: {},
      },
    } as unknown as SnapshotBundle;
    const out = readRows(bundle, { symbol: 'ESPORTSUSDT' });
    expect(out).toHaveLength(1);
    expect(out[0]!.has_taker_flow).toBe(false);
    expect(out[0]!.taker_buy_volume_usd).toBeNull();
  });
});
