import { describe, it, expect } from 'vitest';
import { readRows } from '../../../src/snapshot/readers/rows.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../../src/contract/historical-read/dto.js';

function row(minute_ts: number): CanonicalRowV2 {
  return {
    schema_version: 2,
    minute_ts,
    symbol: 'BTCUSDT',
    open: 1,
    high: 2,
    low: 0,
    close: 1.5,
    volume: 10,
    turnover: 15,
    oi_total_usd: null,
    funding_rate: null,
    liq_long_usd: null,
    liq_short_usd: null,
    has_oi: false,
    has_funding: false,
    has_liquidations: false,
    taker_buy_volume_usd: null,
    taker_sell_volume_usd: null,
    has_taker_flow: false,
  };
}

const t0 = 60_000;
const t1 = 120_000;
const t2 = 180_000;

const bundle = {
  historical: {
    rowsBySymbol: { BTCUSDT: [row(t0), row(t1), row(t2)] },
  },
} as unknown as SnapshotBundle;

describe('readRows', () => {
  it('returns all rows for a known symbol with no bounds', () => {
    expect(readRows(bundle, { symbol: 'BTCUSDT' })).toHaveLength(3);
  });

  // Range is half-open [fromMs, toMs) — platform parity with
  // storage/historical/reader/query_filters (ts < from || ts >= to → skip).
  // An inclusive upper bound double-counts the boundary bar across adjacent
  // walk-forward folds (control-center audit P0-1).
  it('adjacent bars: [t0, t1) contains only the fromMs bar', () => {
    const out = readRows(bundle, { symbol: 'BTCUSDT', fromMs: t0, toMs: t1 });
    expect(out.map((r) => r.minute_ts)).toEqual([t0]);
  });

  it('excludes the bar at minute_ts === toMs', () => {
    const out = readRows(bundle, { symbol: 'BTCUSDT', fromMs: t0, toMs: t2 });
    expect(out.map((r) => r.minute_ts)).toEqual([t0, t1]);
    expect(out.map((r) => r.minute_ts)).not.toContain(t2);
  });

  it('degenerate range [t, t) is empty', () => {
    expect(readRows(bundle, { symbol: 'BTCUSDT', fromMs: t1, toMs: t1 })).toEqual([]);
  });

  it('includes the bar at minute_ts === fromMs (lower bound stays inclusive)', () => {
    const out = readRows(bundle, { symbol: 'BTCUSDT', fromMs: t1, toMs: t2 });
    expect(out.map((r) => r.minute_ts)).toEqual([t1]);
  });

  it('treats an undefined upper bound as open-ended', () => {
    const out = readRows(bundle, { symbol: 'BTCUSDT', fromMs: t1 });
    expect(out.map((r) => r.minute_ts)).toEqual([t1, t2]);
  });

  it('returns [] for an unknown symbol', () => {
    expect(readRows(bundle, { symbol: 'ETHUSDT' })).toEqual([]);
  });
});
