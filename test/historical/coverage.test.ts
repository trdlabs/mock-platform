import { describe, it, expect } from 'vitest';
import { handleHistoricalCoverage } from '../../src/historical/handlers/coverage.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const withNativeRows = {
  historical: {
    barsBySymbolAndTimeframe: {
      ESPORTSUSDT: { '1h': [{ tsMs: 0 }, { tsMs: 3_600_000 }], '1d': [{ tsMs: 0 }] },
    },
    rowsBySymbol: {
      ESPORTSUSDT: [
        { minute_ts: 1_000 },
        { minute_ts: 61_000 },
        { minute_ts: 121_000 },
      ],
    },
    fundingBySymbol: {},
  },
} as unknown as SnapshotBundle;

const barsOnly = {
  historical: {
    barsBySymbolAndTimeframe: {
      BTCUSDT: { '1h': [{ tsMs: 0 }], '1d': [{ tsMs: 0 }] },
    },
    rowsBySymbol: {},
    fundingBySymbol: {},
  },
} as unknown as SnapshotBundle;

const rowsOnly = {
  historical: {
    barsBySymbolAndTimeframe: {},
    rowsBySymbol: {
      BTCUSDT: [{ minute_ts: 5_000 }, { minute_ts: 65_000 }],
    },
    fundingBySymbol: {},
  },
} as unknown as SnapshotBundle;

describe('handleHistoricalCoverage', () => {
  it('includes native 1m entries when rowsBySymbol is populated', () => {
    const snapshot = handleHistoricalCoverage(withNativeRows, 1);
    expect(snapshot.timeframes).toContain('1m');
    expect(snapshot.timeframes).toContain('1h');
    expect(snapshot.timeframes).toContain('1d');

    const oneMinute = snapshot.entries.find((e) => e.symbol === 'ESPORTSUSDT' && e.timeframe === '1m');
    expect(oneMinute).toMatchObject({
      fromMs: 1_000,
      toMs: 121_000,
      barCount: 3,
      availability: 'available',
    });
  });

  it('does not invent 1m coverage for bars-only fixtures', () => {
    const snapshot = handleHistoricalCoverage(barsOnly, 1);
    expect(snapshot.timeframes).not.toContain('1m');
    expect(snapshot.entries.every((e) => e.timeframe !== '1m')).toBe(true);
  });

  it('lists row-only symbols even when no bar maps exist', () => {
    const snapshot = handleHistoricalCoverage(rowsOnly, 1);
    expect(snapshot.symbols).toEqual(['BTCUSDT']);
    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        timeframe: '1m',
        barCount: 2,
        availability: 'available',
      }),
    ]);
  });
});
