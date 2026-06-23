import { describe, it, expect } from 'vitest';
import type { HistoricalBundle } from '../../../src/contract/snapshot/bundle.js';
import { synthesizeRowsFromPerKind } from '../../../src/snapshot/readers/rows-from-perkind.js';
import { readRows } from '../../../src/snapshot/readers/rows.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';

const HOUR = 3_600_000;

/** Minimal historical bundle: two 1h bars + minute-granular oi/funding + one liq event in bar 0's window. */
function hist(): HistoricalBundle {
  const t0 = 1_700_000_000_000; // some hour-aligned ms
  return {
    barsBySymbolAndTimeframe: {
      AAAUSDT: {
        '1h': [
          { tsMs: t0, open: 10, high: 12, low: 9, close: 11, volume: 100 },
          { tsMs: t0 + HOUR, open: 11, high: 13, low: 10, close: 12, volume: 200 },
        ],
        '1d': [{ tsMs: t0, open: 10, high: 13, low: 9, close: 12, volume: 300 }],
      },
    },
    fundingBySymbol: {
      AAAUSDT: [
        { tsMs: t0 - 60_000, symbol: 'AAAUSDT', rate: 0.0001 },
        { tsMs: t0 + HOUR, symbol: 'AAAUSDT', rate: 0.0002 },
      ],
    },
    openInterestBySymbol: {
      AAAUSDT: [
        { tsMs: t0, symbol: 'AAAUSDT', openInterestUsd: 1_000_000 },
        { tsMs: t0 + HOUR, symbol: 'AAAUSDT', openInterestUsd: 2_000_000 },
      ],
    },
    liquidationsBySymbol: {
      AAAUSDT: [
        { tsMs: t0 + 60_000, symbol: 'AAAUSDT', side: 'long', sizeUsd: 500 },
        { tsMs: t0 + 120_000, symbol: 'AAAUSDT', side: 'short', sizeUsd: 300 },
        { tsMs: t0 + HOUR + 60_000, symbol: 'AAAUSDT', side: 'long', sizeUsd: 700 },
      ],
    },
  };
}

describe('synthesizeRowsFromPerKind', () => {
  it('emits one CanonicalRowV2 per bar of the finest timeframe (1h, not 1d)', () => {
    const rows = synthesizeRowsFromPerKind(hist(), 'AAAUSDT');
    expect(rows.length).toBe(2); // two 1h bars (NOT the 1d bar)
    const t0 = 1_700_000_000_000;
    expect(rows.map((r) => r.minute_ts)).toEqual([t0, t0 + HOUR]);
  });

  it('carries OHLCV verbatim from the bar + computes turnover = volume*close', () => {
    const r0 = synthesizeRowsFromPerKind(hist(), 'AAAUSDT')[0]!;
    expect(r0.schema_version).toBe(2);
    expect([r0.open, r0.high, r0.low, r0.close, r0.volume]).toEqual([10, 12, 9, 11, 100]);
    expect(r0.turnover).toBe(100 * 11);
  });

  it('forward-fills oi + funding (last value at-or-before the bar) and flags presence', () => {
    const [r0, r1] = synthesizeRowsFromPerKind(hist(), 'AAAUSDT');
    expect(r0!.has_oi).toBe(true);
    expect(r0!.oi_total_usd).toBe(1_000_000);
    expect(r1!.oi_total_usd).toBe(2_000_000);
    expect(r0!.has_funding).toBe(true);
    expect(r0!.funding_rate).toBe(0.0001); // the t0-60s value carried forward to t0
    expect(r1!.funding_rate).toBe(0.0002);
  });

  it('sums liquidations within each bar window by side', () => {
    const [r0, r1] = synthesizeRowsFromPerKind(hist(), 'AAAUSDT');
    expect(r0!.has_liquidations).toBe(true);
    expect(r0!.liq_long_usd).toBe(500); // long in [t0, t0+1h)
    expect(r0!.liq_short_usd).toBe(300);
    expect(r1!.liq_long_usd).toBe(700); // the t0+1h+60s long
    expect(r1!.liq_short_usd).toBe(0);
  });

  it('marks taker absent (no taker series in per-kind data)', () => {
    const r0 = synthesizeRowsFromPerKind(hist(), 'AAAUSDT')[0]!;
    expect(r0.has_taker_flow).toBe(false);
    expect(r0.taker_buy_volume_usd).toBeNull();
    expect(r0.taker_sell_volume_usd).toBeNull();
  });

  it('unknown symbol → empty', () => {
    expect(synthesizeRowsFromPerKind(hist(), 'NOPE')).toEqual([]);
  });
});

describe('readRows fallback to synthesis', () => {
  function bundleWith(historical: HistoricalBundle): SnapshotBundle {
    return { historical } as unknown as SnapshotBundle;
  }

  it('uses rowsBySymbol verbatim when present (no synthesis)', () => {
    const h = hist();
    const explicit = [{ schema_version: 2, minute_ts: 42, symbol: 'AAAUSDT' } as never];
    const b = bundleWith({ ...h, rowsBySymbol: { AAAUSDT: explicit } });
    expect(readRows(b, { symbol: 'AAAUSDT' })).toEqual(explicit);
  });

  it('synthesizes from per-kind when rowsBySymbol is absent', () => {
    const rows = readRows(bundleWith(hist()), { symbol: 'AAAUSDT' });
    expect(rows.length).toBe(2);
    expect(rows[0]!.open).toBe(10);
  });

  it('applies the fromMs/toMs window to synthesized rows', () => {
    const t0 = 1_700_000_000_000;
    const rows = readRows(bundleWith(hist()), { symbol: 'AAAUSDT', fromMs: t0 + HOUR });
    expect(rows.map((r) => r.minute_ts)).toEqual([t0 + HOUR]);
  });
});

describe('readRows on the real demo fixture (2026-06-12-real-top5, per-kind only, no rowsBySymbol)', () => {
  it('serves non-empty CanonicalRowV2 rows synthesized from the real 1h bars', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const bundle = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../data/snapshots/fixtures/2026-06-12-real-top5/ops/bundle.json'),
        'utf8',
      ),
    ) as SnapshotBundle;

    expect(bundle.historical?.rowsBySymbol).toBeUndefined(); // fixture predates rowsBySymbol
    const rows = readRows(bundle, { symbol: 'BEATUSDT' });
    expect(rows.length).toBeGreaterThan(100); // ~161 1h bars
    const r = rows[0]!;
    expect(r.schema_version).toBe(2);
    expect(r.symbol).toBe('BEATUSDT');
    expect(Number.isFinite(r.open) && Number.isFinite(r.close)).toBe(true);
    expect(r.has_oi).toBe(true); // real-top5 carries minute-granular open interest
    // ascending, hour-spaced
    expect(rows[1]!.minute_ts - rows[0]!.minute_ts).toBe(3_600_000);
  });
});
