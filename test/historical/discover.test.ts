import { describe, it, expect } from 'vitest';
import { buildHistoricalDiscover } from '../../src/historical/handlers/discover.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const withHistorical = {
  historical: {
    barsBySymbolAndTimeframe: { BTCUSDT: { '1m': [] } },
    fundingBySymbol: { BTCUSDT: [] },
  },
} as unknown as SnapshotBundle;

const withoutHistorical = {} as unknown as SnapshotBundle;

// Bars advertise 1h/1d only, but native CanonicalRowV2 rows are minute-grain (the /historical/rows
// resource). Discover must advertise 1m so a `SYMBOL:1m` dataset resolves against the native rows.
const withNativeRows = {
  historical: {
    barsBySymbolAndTimeframe: { BTCUSDT: { '1h': [], '1d': [] } },
    rowsBySymbol: { BTCUSDT: [{ minute_ts: 0 }] },
  },
} as unknown as SnapshotBundle;

// Bars-only (no native rows): must NOT invent a 1m timeframe.
const barsOnly = {
  historical: {
    barsBySymbolAndTimeframe: { BTCUSDT: { '1h': [], '1d': [] } },
    rowsBySymbol: {},
  },
} as unknown as SnapshotBundle;

describe('buildHistoricalDiscover', () => {
  it('reports the historical.2 contract version', () => {
    expect(buildHistoricalDiscover(withHistorical).historicalContractVersion).toBe('historical.2');
  });

  it('lists "rows" first and available when a historical bundle is present', () => {
    const out = buildHistoricalDiscover(withHistorical);
    const rows = out.resources[0]!;
    expect(rows.name).toBe('rows');
    expect(rows.availability).toBe('available');
    expect(rows.supportedFilters).toContain('symbols');
    expect(rows.pagination).toEqual({ cursor: true, maxPageItems: 200 });
  });

  it('marks "rows" unavailable when the historical bundle is absent', () => {
    const out = buildHistoricalDiscover(withoutHistorical);
    const rows = out.resources.find((r) => r.name === 'rows')!;
    expect(rows.availability).toBe('unavailable');
  });

  it('advertises 1m when a symbol has native CanonicalRowV2 rows (even if bars are only 1h/1d)', () => {
    const out = buildHistoricalDiscover(withNativeRows);
    expect(out.timeframes).toContain('1m');
    expect(out.timeframes).toContain('1h');
    expect(out.timeframes).toContain('1d');
  });

  it('does not advertise 1m when there are no native rows (bars-only fixture)', () => {
    const out = buildHistoricalDiscover(barsOnly);
    expect(out.timeframes).not.toContain('1m');
    expect(out.timeframes).toEqual(['1d', '1h']);
  });

  it('exposes only rows and historical-coverage (legacy resources retired)', () => {
    const names = buildHistoricalDiscover(withHistorical).resources.map((r) => r.name);
    expect(names).toContain('rows');
    expect(names).toContain('historical-coverage');
    for (const n of ['bars', 'funding', 'open-interest', 'liquidations']) {
      expect(names).not.toContain(n);
    }
  });
});
