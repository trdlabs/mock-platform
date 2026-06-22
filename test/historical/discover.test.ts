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

  it('exposes only rows and historical-coverage (legacy resources retired)', () => {
    const names = buildHistoricalDiscover(withHistorical).resources.map((r) => r.name);
    expect(names).toContain('rows');
    expect(names).toContain('historical-coverage');
    for (const n of ['bars', 'funding', 'open-interest', 'liquidations']) {
      expect(names).not.toContain(n);
    }
  });
});
