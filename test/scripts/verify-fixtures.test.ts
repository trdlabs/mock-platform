import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
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

// append to test/scripts/verify-fixtures.test.ts
import { checkFixture, totalGap, maxConsecutiveGap } from '../../scripts/verify_fixtures.js';

const M = 60_000;
const from = M;                 // 60_000
const to = M + 10 * M;          // 10 grid slots: minutes 1..10
const cov = {
  schemaVersion: 'fixture-coverage.1' as const,
  period: { fromMs: from, toMs: to },
  symbols: ['A', 'B', 'C', 'D', 'E'],
  totalGapBudgetMinutes: 2,
  maxConsecutiveGapMinutes: 1,
};
const gridArr = (): number[] => Array.from({ length: (to - from) / M }, (_, i) => from + i * M);
// full unified grid: every minute, all 5 symbols identical
const full = (): Record<string, { minute_ts: number }[]> =>
  Object.fromEntries(cov.symbols.map((s) => [s, gridArr().map((t) => ({ minute_ts: t }))]));

describe('gap math', () => {
  it('totalGap counts missing minutes', () => {
    expect(totalGap([from, from + M], from, to)).toBe(8); // 10 slots, 2 present
  });
  it('maxConsecutiveGap includes leading and trailing edges', () => {
    // present only minute index 4 → leading 4, trailing 5
    expect(maxConsecutiveGap([from + 4 * M], from, to)).toBe(5);
  });
});

describe('checkFixture', () => {
  it('passes a full unified grid within budget', () => {
    expect(checkFixture(cov, full())).toEqual([]);
  });
  it('fails a symbol-set mismatch (missing key)', () => {
    const r = full(); delete r.E;
    expect(checkFixture(cov, r).some((e) => e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails an extra empty key (must NOT be silently filtered)', () => {
    const r = { ...full(), X: [] as { minute_ts: number }[] };
    expect(checkFixture(cov, r).some((e) => e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails an empty declared symbol', () => {
    const r = full(); r.E = [];
    expect(checkFixture(cov, r).some((e) => e.includes('empty rows'))).toBe(true);
  });
  it('fails bars-only (no rows at all)', () => {
    expect(checkFixture(cov, undefined).some((e) => e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails a duplicate minute_ts', () => {
    const r = full(); r.A = [...r.A!, { minute_ts: from }];
    expect(checkFixture(cov, r).some((e) => e.includes('duplicate'))).toBe(true);
  });
  it('fails a misaligned minute_ts', () => {
    const r = full(); r.A = [{ minute_ts: from + 30_000 }, ...r.A!.slice(1)];
    expect(checkFixture(cov, r).some((e) => e.includes('not minute-aligned'))).toBe(true);
  });
  it('fails non-strictly-increasing rows', () => {
    const r = full(); r.A = [r.A![1]!, r.A![0]!, ...r.A!.slice(2)];
    expect(checkFixture(cov, r).some((e) => e.includes('strictly increasing'))).toBe(true);
  });
  it('fails non-identical grids', () => {
    const r = full(); r.B = r.B!.slice(0, -1);
    expect(checkFixture(cov, r).some((e) => e.includes('grid mismatch'))).toBe(true);
  });
  it('fails a row below fromMs', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [{ minute_ts: from - M }, ...r[s]!];
    expect(checkFixture(cov, r).some((e) => e.includes('outside window'))).toBe(true);
  });
  it('fails a row at exactly toMs (half-open upper bound)', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [...r[s]!, { minute_ts: to }];
    expect(checkFixture(cov, r).some((e) => e.includes('outside window'))).toBe(true);
  });
  it('total-gap boundary: == budget passes, +1 fails (consecutive budget relaxed)', () => {
    const g = gridArr();
    // drop the last N minutes → a trailing run of N; relax the consecutive budget so only total-gap gates
    const covT = { ...cov, maxConsecutiveGapMinutes: 10 };
    const keep = (n: number) => Object.fromEntries(cov.symbols.map((s) => [s, g.slice(0, g.length - n).map((t) => ({ minute_ts: t }))]));
    expect(checkFixture(covT, keep(2))).toEqual([]);                                  // total gap == 2
    expect(checkFixture(covT, keep(3)).some((e) => e.includes('total gap'))).toBe(true); // 3 > 2
  });
  it('consecutive-gap boundary: == budget passes, +1 fails (total budget relaxed)', () => {
    const g = gridArr();
    const covC = { ...cov, totalGapBudgetMinutes: 10 }; // only consecutive gates
    const drop = (idx: number[]) => Object.fromEntries(cov.symbols.map((s) => [s, g.filter((_, i) => !idx.includes(i)).map((t) => ({ minute_ts: t }))]));
    expect(checkFixture(covC, drop([3]))).toEqual([]);                                 // one-minute hole (== 1)
    expect(checkFixture(covC, drop([3, 4])).some((e) => e.includes('consecutive'))).toBe(true); // two-minute hole
  });
});

// append to test/scripts/verify-fixtures.test.ts
import { runFixtureVerification } from '../../scripts/verify_fixtures.js';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runFixtureVerification', () => {
  it('returns 0 on the real repo (legacy fixtures warn)', () => {
    expect(runFixtureVerification('.')).toBe(0);
  });
  it('returns 1 for a malformed sidecar', () => {
    const d = mkdtempSync(join(tmpdir(), 'vf-'));
    const fx = join(d, 'data/snapshots/wfo/bad');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'coverage.json'), JSON.stringify({ schemaVersion: 'fixture-coverage.1' }));
    expect(runFixtureVerification(d)).toBe(1);
  });
  it('FAILS a wfo fixture with no coverage.json — deleting the sidecar must not go green', () => {
    const d = mkdtempSync(join(tmpdir(), 'vf-'));
    mkdirSync(join(d, 'data/snapshots/wfo/no-sidecar'), { recursive: true });
    expect(runFixtureVerification(d)).toBe(1);
  });
  it('still only WARNs for a legacy fixtures/ dir with no coverage.json', () => {
    const d = mkdtempSync(join(tmpdir(), 'vf-'));
    mkdirSync(join(d, 'data/snapshots/fixtures/legacy'), { recursive: true });
    expect(runFixtureVerification(d)).toBe(0);
  });
  it('returns 1 for a non-JSON sidecar without throwing', () => {
    const d = mkdtempSync(join(tmpdir(), 'vf-'));
    const fx = join(d, 'data/snapshots/wfo/bad2');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'coverage.json'), '{ not json');
    expect(runFixtureVerification(d)).toBe(1);
  });
});

// The repo's own committed fixtures are all coverage-less, so the gate is only ever observed at
// "0 enforced" in CI. This exercises the ENFORCED path end to end against a real, loadable snapshot:
// scan -> coverage schema -> loadSnapshot (secret-scan + manifest schema + version compat + checksum
// + bundle schema) -> declared-vs-actual comparison -> exit 0.
describe('runFixtureVerification: enforced fixture, end-to-end', () => {
  const GOLDEN = 'data/snapshots/fixtures/historical-golden';
  const SYMBOLS = ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'HUSDT'];

  /** Real loadable snapshot in a temp tree: the committed golden bundle (full, schema-valid ops
   *  surface) with its rows re-keyed to exactly 5 symbols sharing one minute grid. */
  function buildEnforcedFixture(): { baseDir: string; dir: string; gridMinutes: number } {
    const golden = JSON.parse(readFileSync(join(GOLDEN, 'ops/bundle.json'), 'utf8')) as
      Record<string, unknown> & {
        historical: { rowsBySymbol: Record<string, Array<Record<string, unknown> & { minute_ts: number }>> };
      };
    const template = golden.historical.rowsBySymbol['BTCUSDT']!;
    const rowsBySymbol = Object.fromEntries(
      SYMBOLS.map((s) => [s, template.map((r) => ({ ...r, symbol: s }))]),
    );
    const bundleStr = JSON.stringify({ ...golden, historical: { ...golden.historical, rowsBySymbol } });

    const baseDir = mkdtempSync(join(tmpdir(), 'vf-e2e-'));
    const dir = join(baseDir, 'data/snapshots/wfo/e2e-enforced');
    mkdirSync(join(dir, 'ops'), { recursive: true });
    writeFileSync(join(dir, 'ops/bundle.json'), bundleStr);
    writeFileSync(join(dir, 'checksums.json'), JSON.stringify({
      'ops/bundle.json': createHash('sha256').update(bundleStr).digest('hex'),
    }));
    const manifest = JSON.parse(readFileSync(join(GOLDEN, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ref: 'e2e-enforced' }));

    // Declare the grid exactly: half-open window ending one minute past the last row, so the
    // present minutes fill it with zero slack and both budgets can be 0.
    const ts = template.map((r) => r.minute_ts);
    const fromMs = ts[0]!;
    const toMs = ts[ts.length - 1]! + 60_000;
    writeFileSync(join(dir, 'coverage.json'), JSON.stringify({
      schemaVersion: 'fixture-coverage.1',
      period: { fromMs, toMs },
      symbols: SYMBOLS,
      totalGapBudgetMinutes: 0,
      maxConsecutiveGapMinutes: 0,
    }));
    return { baseDir, dir, gridMinutes: (toMs - fromMs) / 60_000 };
  }

  it('passes a loadable fixture whose declared coverage matches its rows, and counts it as enforced', () => {
    const { baseDir, dir, gridMinutes } = buildEnforcedFixture();
    expect(gridMinutes).toBe(30); // the window is exactly the grid — no slack hiding a gap

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runFixtureVerification(baseDir)).toBe(0);
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(err).not.toHaveBeenCalled();
      expect(out).toContain(`OK    ${dir}`);  // took the enforce branch, not the legacy WARN branch
      expect(out).toContain('1 enforced');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
