import { describe, it, expect } from 'vitest';
import { aggregateTurnover } from './wfo-turnover.js';
import { assembleRawBundle } from './wfo-build-raw.js';

describe('aggregateTurnover', () => {
  it('sums close*volume per symbol within [from, to), upper-casing symbols', () => {
    const rows = [
      { symbol: 'a', close: 2, volume: 3, minute_ts: 60_000 },   // 6  (a→A)
      { symbol: 'A', close: 1, volume: 1, minute_ts: 120_000 },  // +1
      { symbol: 'B', close: 5, volume: 2, minute_ts: 0 },        // below from → excluded
      { symbol: 'B', close: 4, volume: 1, minute_ts: 180_000 },  // == to → excluded (half-open)
    ];
    expect(aggregateTurnover(rows, 60_000, 180_000)).toEqual({ A: 7 });
  });
  it('throws on a non-finite value', () => {
    expect(() => aggregateTurnover([{ symbol: 'A', close: NaN, volume: 1, minute_ts: 60_000 }], 0, 120_000)).toThrow(/non-finite/);
  });
  it('throws on a duplicate (symbol, minute_ts) instead of double-counting', () => {
    const dup = [
      { symbol: 'A', close: 1, volume: 1, minute_ts: 60_000 },
      { symbol: 'a', close: 2, volume: 2, minute_ts: 60_000 }, // same symbol+minute (upper-cased)
    ];
    expect(() => aggregateTurnover(dup, 0, 120_000)).toThrow(/duplicate/);
  });
});

describe('assembleRawBundle', () => {
  it('replaces historical and preserves everything else', () => {
    const base = { runs: [1], tradesByRun: { r: [] }, historical: { old: true } };
    expect(assembleRawBundle(base, { fresh: true })).toEqual({ runs: [1], tradesByRun: { r: [] }, historical: { fresh: true } });
  });
});
