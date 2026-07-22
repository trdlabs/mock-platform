import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openSnapshot } from '../../src/snapshot/registry.js';

/** The committed T2 fixture is the first snapshot to live under a NESTED ref (`wfo/<name>` rather
 *  than `fixtures/<name>`), so this pins that the registry resolves one at all. */
const REF = 'wfo/2026-06-09-to-2026-07-20-vps-wfo42d';
const DIR = `data/snapshots/${REF}`;

describe('nested wfo ref', () => {
  const snap = openSnapshot('data/snapshots', REF);
  const rows = (snap.bundle as unknown as { historical?: { rowsBySymbol?: Record<string, Array<{ minute_ts: number }>> } })
    .historical?.rowsBySymbol ?? {};
  const coverage = JSON.parse(readFileSync(`${DIR}/coverage.json`, 'utf8')) as {
    period: { fromMs: number; toMs: number }; symbols: string[];
  };

  it('openSnapshot resolves and loads the T2 fixture at a nested ref', () => {
    expect(Object.keys(rows).sort()).toHaveLength(5);
    expect(rows['HUSDT']!.length).toBeGreaterThan(0);
  });

  it('carries exactly the symbols the sidecar declares', () => {
    expect(Object.keys(rows).sort()).toEqual([...coverage.symbols].sort());
  });

  it('puts every symbol on one common grid, inside the declared half-open window', () => {
    const sizes = new Set(Object.values(rows).map((r) => r.length));
    expect(sizes.size).toBe(1); // intersected to a single shared minute grid
    for (const [symbol, arr] of Object.entries(rows)) {
      expect(arr[0]!.minute_ts, symbol).toBeGreaterThanOrEqual(coverage.period.fromMs);
      expect(arr[arr.length - 1]!.minute_ts, symbol).toBeLessThan(coverage.period.toMs);
    }
  });

  it('stores rows in ascending minute order with no repeated minute', () => {
    // Guards the build being reproducible: the parquet reader walks date directories in filesystem
    // order, so the ordering has to be imposed rather than inherited.
    for (const [symbol, arr] of Object.entries(rows)) {
      const ts = arr.map((r) => r.minute_ts);
      expect(ts, symbol).toEqual([...ts].sort((a, b) => a - b));
      expect(new Set(ts).size, symbol).toBe(ts.length);
    }
  });
});
