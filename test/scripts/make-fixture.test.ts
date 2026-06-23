import { describe, it, expect } from 'vitest';
import { selectTopSymbols, filterBundleToSymbols } from '../../scripts/make-fixture.js';

const sample = {
  runs: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
  tradesByRun: {
    r1: [{ symbol: 'A' }, { symbol: 'A' }, { symbol: 'A' }, { symbol: 'B' }],
    r2: [{ symbol: 'B' }, { symbol: 'B' }, { symbol: 'C' }],
    r3: [{ symbol: 'D' }],
  },
  eventsByRun: { r1: [], r2: [], r3: [] },
  decisionsByRun: { r1: [{}], r2: [{}], r3: [{}] },
  analysisByRun: { r1: {}, r2: {}, r3: {} },
  researchByRun: { r1: {}, r2: {}, r3: {} },
  runtimeHealth: { entries: [], asOf: 1 },
  marketHealth: { status: 'ok' },
  executionHealth: { status: 'ok' },
  coverage: { entries: [], availability: 'available', asOf: 1 },
  replay: { frames: [] },
  historical: {
    barsBySymbolAndTimeframe: { A: { '1h': [] }, B: { '1h': [] }, C: { '1h': [] }, D: { '1h': [] } },
    fundingBySymbol: { A: [], B: [], C: [], D: [] },
    openInterestBySymbol: { A: [], B: [], C: [], D: [] },
    liquidationsBySymbol: { A: [], B: [], C: [], D: [] },
    rowsBySymbol: { A: [], B: [], C: [], D: [] },
  },
} as const;

describe('selectTopSymbols', () => {
  it('ranks by trade count, tie-broken by symbol name asc', () => {
    expect(selectTopSymbols(structuredClone(sample), 2)).toEqual(['A', 'B']);
  });
  it('returns all symbols (count desc, then name asc) when n exceeds the distinct count', () => {
    expect(selectTopSymbols(structuredClone(sample), 10)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('filterBundleToSymbols', () => {
  const out = filterBundleToSymbols(structuredClone(sample), ['A', 'B']);
  it('keeps only trades for the chosen symbols', () => {
    expect(out.tradesByRun.r1.map((t) => t.symbol)).toEqual(['A', 'A', 'A', 'B']);
    expect(out.tradesByRun.r2.map((t) => t.symbol)).toEqual(['B', 'B']);
  });
  it('drops runs that retain no trades', () => {
    expect(Object.keys(out.tradesByRun).sort()).toEqual(['r1', 'r2']);
    expect(out.runs.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
  it('drops run-keyed data for dropped runs', () => {
    expect(Object.keys(out.decisionsByRun).sort()).toEqual(['r1', 'r2']);
  });
  it('filters historical maps to the chosen symbols', () => {
    expect(Object.keys(out.historical!.fundingBySymbol).sort()).toEqual(['A', 'B']);
    expect(Object.keys(out.historical!.barsBySymbolAndTimeframe).sort()).toEqual(['A', 'B']);
  });
  it('copies global health/coverage/replay unchanged', () => {
    expect(out.coverage).toEqual(sample.coverage);
    expect(out.replay).toEqual(sample.replay);
  });
  it('filters rowsBySymbol to the chosen symbols when present', () => {
    expect(Object.keys(out.historical!.rowsBySymbol!).sort()).toEqual(['A', 'B']);
  });
});
