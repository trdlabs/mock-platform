import { describe, it, expect } from 'vitest';
import type { HistoricalBundle } from '../../../src/contract/snapshot/bundle.js';
import {
  synthesizeRowsFromPerKind,
  syntheticRowGrainMs,
  hasMinuteGrainBars,
  MINUTE_MS,
} from '../../../src/snapshot/readers/rows-from-perkind.js';
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

  // CanonicalRowV2.minute_ts names a minute. Hourly bars synthesized into it produce rows
  // that step by an hour while claiming to be minute rows — a consumer cannot tell them
  // apart from real ones, so a backtest over them is silently wrong (audit P1-2).
  it('refuses to synthesize minute rows from 1h bars', () => {
    expect(readRows(bundleWith(hist()), { symbol: 'AAAUSDT' })).toEqual([]);
  });

  it('synthesizes from per-kind when the finest bars ARE minute-grain', () => {
    const t0 = 1_700_000_000_000;
    const h = hist();
    const minuteBars = {
      ...h,
      barsBySymbolAndTimeframe: {
        AAAUSDT: {
          ...h.barsBySymbolAndTimeframe.AAAUSDT,
          '1m': [
            { tsMs: t0, open: 10, high: 12, low: 9, close: 11, volume: 100 },
            { tsMs: t0 + MINUTE_MS, open: 11, high: 13, low: 10, close: 12, volume: 200 },
          ],
        },
      },
    };
    const rows = readRows(bundleWith(minuteBars), { symbol: 'AAAUSDT' });
    expect(rows.length).toBe(2);
    expect(rows[0]!.open).toBe(10);
    expect(rows[1]!.minute_ts - rows[0]!.minute_ts).toBe(MINUTE_MS);
  });

  it('applies the fromMs/toMs window to synthesized minute rows', () => {
    const t0 = 1_700_000_000_000;
    const h = hist();
    const minuteBars = {
      ...h,
      barsBySymbolAndTimeframe: {
        AAAUSDT: {
          '1m': [
            { tsMs: t0, open: 10, high: 12, low: 9, close: 11, volume: 100 },
            { tsMs: t0 + MINUTE_MS, open: 11, high: 13, low: 10, close: 12, volume: 200 },
          ],
        },
      },
    };
    const rows = readRows(bundleWith(minuteBars), { symbol: 'AAAUSDT', fromMs: t0 + MINUTE_MS });
    expect(rows.map((r) => r.minute_ts)).toEqual([t0 + MINUTE_MS]);
  });
});

describe('minute-grain detection', () => {
  it('reports the synthesis grain, and only 1m counts as minute-grain', () => {
    const t0 = 1_700_000_000_000;
    expect(syntheticRowGrainMs(hist(), 'AAAUSDT')).toBe(HOUR);
    expect(hasMinuteGrainBars(hist(), 'AAAUSDT')).toBe(false);

    const minute = {
      ...hist(),
      barsBySymbolAndTimeframe: {
        AAAUSDT: { '1m': [{ tsMs: t0, open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
      },
    };
    expect(syntheticRowGrainMs(minute, 'AAAUSDT')).toBe(MINUTE_MS);
    expect(hasMinuteGrainBars(minute, 'AAAUSDT')).toBe(true);
  });

  it('reports undefined for a symbol with no bars', () => {
    expect(syntheticRowGrainMs(hist(), 'NOPEUSDT')).toBeUndefined();
    expect(hasMinuteGrainBars(hist(), 'NOPEUSDT')).toBe(false);
  });
});

describe('readRows on the real demo fixture (2026-06-12-real-top5, per-kind only, no rowsBySymbol)', () => {
  async function realTop5(): Promise<SnapshotBundle> {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    return JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../data/snapshots/fixtures/2026-06-12-real-top5/ops/bundle.json'),
        'utf8',
      ),
    ) as SnapshotBundle;
  }

  // This fixture's finest bars are 1h. It used to serve ~161 hour-spaced rows as minute
  // rows — the exact silent divergence audit P1-2 describes, and the reason this test now
  // asserts the opposite of what it originally did.
  it('serves NO rows: its finest bars are hourly, not minute-grain', async () => {
    const bundle = await realTop5();
    expect(bundle.historical?.rowsBySymbol).toBeUndefined(); // fixture predates rowsBySymbol
    expect(syntheticRowGrainMs(bundle.historical!, 'BEATUSDT')).toBe(3_600_000);
    expect(readRows(bundle, { symbol: 'BEATUSDT' })).toEqual([]);
  });

  it('never emits rows whose spacing is not one minute', async () => {
    const bundle = await realTop5();
    for (const symbol of Object.keys(bundle.historical!.barsBySymbolAndTimeframe)) {
      const rows = readRows(bundle, { symbol });
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.minute_ts - rows[i - 1]!.minute_ts).toBe(MINUTE_MS);
      }
    }
  });

  // The bars themselves are untouched — they stay reachable through the bars-keyed
  // endpoints, which state their own timeframe. Only the minute-row projection is refused.
  it('still carries the underlying hourly bars', async () => {
    const bundle = await realTop5();
    const bars = bundle.historical!.barsBySymbolAndTimeframe['BEATUSDT']?.['1h'] ?? [];
    expect(bars.length).toBeGreaterThan(100);
    expect(bars[1]!.tsMs - bars[0]!.tsMs).toBe(3_600_000);
  });
});
