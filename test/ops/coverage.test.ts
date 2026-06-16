import { describe, it, expect } from 'vitest';
import { handleCoverage } from '../../src/ops/handlers/coverage.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { coverage: { entries: [
  { source: 'bybit', kind: 'openInterest', state: 'present', freshnessAgeMs: 1000 },
  { source: 'bybit', kind: 'funding', state: 'unsupported', freshnessAgeMs: null },
], availability: 'available', asOf: 1 } } as unknown as SnapshotBundle;

describe('handleCoverage', () => {
  it('returns all entries with no filter', () => {
    expect(handleCoverage(bundle).entries).toHaveLength(2);
  });
  it('filters by kind, preserving present vs unsupported distinction', () => {
    const c = handleCoverage(bundle, undefined, 'funding');
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]!.state).toBe('unsupported');
  });
});
