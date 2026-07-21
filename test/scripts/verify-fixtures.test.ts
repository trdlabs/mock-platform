import { describe, it, expect } from 'vitest';
import { validateCoverageDoc } from '../../scripts/verify_fixtures.js';

const ok = {
  schemaVersion: 'fixture-coverage.1',
  period: { fromMs: 60_000, toMs: 60_000 + 42 * 86_400_000 },
  symbols: ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'HUSDT'],
  totalGapBudgetMinutes: 6480,
  maxConsecutiveGapMinutes: 1440,
};

describe('validateCoverageDoc', () => {
  it('accepts a well-formed sidecar', () => {
    expect(validateCoverageDoc(ok)).toEqual([]);
  });
  it('rejects an unknown top-level key', () => {
    expect(validateCoverageDoc({ ...ok, extra: 1 }).length).toBeGreaterThan(0);
  });
  it('rejects the wrong schemaVersion', () => {
    expect(validateCoverageDoc({ ...ok, schemaVersion: 'fixture-coverage.2' }).length).toBeGreaterThan(0);
  });
  it('rejects a symbol list that is not exactly 5 unique', () => {
    expect(validateCoverageDoc({ ...ok, symbols: ['A', 'B', 'C', 'D'] }).length).toBeGreaterThan(0);
    expect(validateCoverageDoc({ ...ok, symbols: ['A', 'A', 'C', 'D', 'E'] }).length).toBeGreaterThan(0);
  });
  it('rejects a negative or non-integer budget', () => {
    expect(validateCoverageDoc({ ...ok, totalGapBudgetMinutes: -1 }).length).toBeGreaterThan(0);
    expect(validateCoverageDoc({ ...ok, maxConsecutiveGapMinutes: 1.5 }).length).toBeGreaterThan(0);
  });
  it('rejects misaligned bounds', () => {
    expect(validateCoverageDoc({ ...ok, period: { fromMs: 30_000, toMs: ok.period.toMs } }).length).toBeGreaterThan(0);
  });
  it('rejects toMs <= fromMs', () => {
    expect(validateCoverageDoc({ ...ok, period: { fromMs: 120_000, toMs: 120_000 } }).length).toBeGreaterThan(0);
  });
});
