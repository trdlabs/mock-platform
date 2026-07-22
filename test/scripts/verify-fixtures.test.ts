import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { validateCoverageDoc } from '../../scripts/verify_fixtures.js';

const ok = {
  schemaVersion: 'fixture-coverage.1',
  period: { fromMs: 60_000, toMs: 60_000 + 42 * 86_400_000 },
  symbols: ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'HUSDT'],
  barTimeframes: ['1h', '1d'],
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

  // barTimeframes is what makes the bar gate universal: the sidecar, not the verifier, says which
  // derived timeframes this fixture claims. A fixture that omits it has declared nothing, so there
  // would again be nothing for the gate to hold the bundle to.
  it('requires barTimeframes', () => {
    const { barTimeframes: _omit, ...without } = ok;
    expect(validateCoverageDoc(without).length).toBeGreaterThan(0);
  });
  it('rejects an empty or duplicated barTimeframes', () => {
    expect(validateCoverageDoc({ ...ok, barTimeframes: [] }).length).toBeGreaterThan(0);
    expect(validateCoverageDoc({ ...ok, barTimeframes: ['1h', '1h'] }).length).toBeGreaterThan(0);
  });
  it('rejects a timeframe the contract does not define', () => {
    // `30m` is a plausible-looking value that Timeframe does NOT contain. Widening the set has to
    // start in the SDK contract, not in a fixture sidecar.
    expect(validateCoverageDoc({ ...ok, barTimeframes: ['1h', '30m'] }).length).toBeGreaterThan(0);
    expect(validateCoverageDoc({ ...ok, barTimeframes: ['bogus'] }).length).toBeGreaterThan(0);
  });
  it('accepts any subset of the contract timeframes', () => {
    expect(validateCoverageDoc({ ...ok, barTimeframes: ['5m', '15m'] })).toEqual([]);
    expect(validateCoverageDoc({ ...ok, barTimeframes: ['1m', '5m', '15m', '1h', '4h', '1d'] })).toEqual([]);
  });
});

// append to test/scripts/verify-fixtures.test.ts
import { checkFixture, checkRows, totalGap, maxConsecutiveGap } from '../../scripts/verify_fixtures.js';
import { deriveHistoricalSurfaces } from '../../scripts/make-wfo-fixture.js';

const M = 60_000;
const from = M;                 // 60_000
const to = M + 10 * M;          // 10 grid slots: minutes 1..10
const cov = {
  schemaVersion: 'fixture-coverage.1' as const,
  period: { fromMs: from, toMs: to },
  symbols: ['A', 'B', 'C', 'D', 'E'],
  barTimeframes: ['1h', '1d'] as const,
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
  // These cases exercise the row-level rules, so they pass rows alone; checkFixture now takes the
  // whole historical block.
  const chk = (c: typeof cov, rows: Record<string, Array<{ minute_ts: number }>> | undefined) =>
    checkRows(c, rows);
  it('passes a full unified grid within budget', () => {
    expect(chk(cov, full())).toEqual([]);
  });
  it('fails a symbol-set mismatch (missing key)', () => {
    const r = full(); delete r.E;
    expect(chk(cov, r).some((e) => e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails an extra empty key (must NOT be silently filtered)', () => {
    const r = { ...full(), X: [] as { minute_ts: number }[] };
    expect(chk(cov, r).some((e) => e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails an empty declared symbol', () => {
    const r = full(); r.E = [];
    expect(chk(cov, r).some((e) => e.includes('empty rows'))).toBe(true);
  });
  it('fails bars-only (no rows at all)', () => {
    expect(chk(cov, undefined).some((e) => e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails a duplicate minute_ts', () => {
    const r = full(); r.A = [...r.A!, { minute_ts: from }];
    expect(chk(cov, r).some((e) => e.includes('duplicate'))).toBe(true);
  });
  it('fails a misaligned minute_ts', () => {
    const r = full(); r.A = [{ minute_ts: from + 30_000 }, ...r.A!.slice(1)];
    expect(chk(cov, r).some((e) => e.includes('not minute-aligned'))).toBe(true);
  });
  it('fails non-strictly-increasing rows', () => {
    const r = full(); r.A = [r.A![1]!, r.A![0]!, ...r.A!.slice(2)];
    expect(chk(cov, r).some((e) => e.includes('strictly increasing'))).toBe(true);
  });
  it('fails non-identical grids', () => {
    const r = full(); r.B = r.B!.slice(0, -1);
    expect(chk(cov, r).some((e) => e.includes('grid mismatch'))).toBe(true);
  });
  it('fails a row below fromMs', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [{ minute_ts: from - M }, ...r[s]!];
    expect(chk(cov, r).some((e) => e.includes('outside window'))).toBe(true);
  });
  it('fails a row at exactly toMs (half-open upper bound)', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [...r[s]!, { minute_ts: to }];
    expect(chk(cov, r).some((e) => e.includes('outside window'))).toBe(true);
  });
  it('total-gap boundary: == budget passes, +1 fails (consecutive budget relaxed)', () => {
    const g = gridArr();
    // drop the last N minutes → a trailing run of N; relax the consecutive budget so only total-gap gates
    const covT = { ...cov, maxConsecutiveGapMinutes: 10 };
    const keep = (n: number) => Object.fromEntries(cov.symbols.map((s) => [s, g.slice(0, g.length - n).map((t) => ({ minute_ts: t }))]));
    expect(chk(covT, keep(2))).toEqual([]);                                  // total gap == 2
    expect(chk(covT, keep(3)).some((e) => e.includes('total gap'))).toBe(true); // 3 > 2
  });
  it('consecutive-gap boundary: == budget passes, +1 fails (total budget relaxed)', () => {
    const g = gridArr();
    const covC = { ...cov, totalGapBudgetMinutes: 10 }; // only consecutive gates
    const drop = (idx: number[]) => Object.fromEntries(cov.symbols.map((s) => [s, g.filter((_, i) => !idx.includes(i)).map((t) => ({ minute_ts: t }))]));
    expect(chk(covC, drop([3]))).toEqual([]);                                 // one-minute hole (== 1)
    expect(chk(covC, drop([3, 4])).some((e) => e.includes('consecutive'))).toBe(true); // two-minute hole
  });
});

describe('checkDerivedSurfaces (the whole historical block, not just rows)', () => {
  const rowsWithVolume = () =>
    Object.fromEntries(cov.symbols.map((s) => [
      s, gridArr().map((t, i) => ({ minute_ts: t, open: 10 + i, high: 20 + i, low: 5 + i, close: 15 + i, volume: 2 })),
    ]));
  /** The 5m and 15m aggregation of `rowsWithVolume`, worked out by hand rather than by calling the
   *  production bucketer, so these cases are evidence and not a restatement of the code under test.
   *  Rows are minute i=0..9 at t=(i+1)*60_000, open 10+i, high 20+i, low 5+i, close 15+i, volume 2. */
  const FIVE_M_BARS = [
    { tsMs: 0,       open: 10, high: 23, low: 5, close: 18, volume: 8 },   // i=0..3
    { tsMs: 300_000, open: 14, high: 28, low: 9, close: 23, volume: 10 },  // i=4..8
    { tsMs: 600_000, open: 19, high: 29, low: 14, close: 24, volume: 2 },  // i=9
  ];
  const FIFTEEN_M_BARS = [{ tsMs: 0, open: 10, high: 29, low: 5, close: 24, volume: 20 }]; // i=0..9

  /** Bars that genuinely agree with the rows above: one bucket per timeframe, full OHLCV. */
  const goodBars = () => {
    const g = gridArr();
    const bar = (tsMs: number) => ({
      tsMs, open: 10, high: 20 + (g.length - 1), low: 5, close: 15 + (g.length - 1), volume: 2 * g.length,
    });
    return Object.fromEntries(cov.symbols.map((s) => [s, {
      '1h': [bar(Math.floor(from / 3_600_000) * 3_600_000)],
      '1d': [bar(Math.floor(from / 86_400_000) * 86_400_000)],
    }]));
  };

  it('passes when every derived surface agrees with the shipped rows', () => {
    expect(checkFixture(cov, {
      rowsBySymbol: rowsWithVolume(),
      barsBySymbolAndTimeframe: goodBars(),
      openInterestBySymbol: Object.fromEntries(cov.symbols.map((s) => [s, [{ tsMs: from }]])),
    })).toEqual([]);
  });

  it('FAILS a derived series reaching outside the declared window', () => {
    // The exact defect a real fixture shipped: 54,630 open-interest entries before its own start.
    const errs = checkFixture(cov, {
      rowsBySymbol: rowsWithVolume(),
      barsBySymbolAndTimeframe: goodBars(),
      openInterestBySymbol: Object.fromEntries(cov.symbols.map((s) => [s, [{ tsMs: from - M }, { tsMs: from }]])),
    });
    expect(errs.some((e) => e.includes('openInterestBySymbol') && e.includes('outside window'))).toBe(true);
  });

  it('FAILS when barsBySymbolAndTimeframe is absent entirely', () => {
    // Deleting the surface must not be a way to have nothing to disagree with.
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume() });
    expect(errs.some((e) => e.includes('missing bars for declared symbol'))).toBe(true);
  });

  it('FAILS when one declared symbol has no bars', () => {
    const bars = goodBars(); delete (bars as Record<string, unknown>).C;
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: bars });
    expect(errs.some((e) => e.includes('missing bars for declared symbol C'))).toBe(true);
  });

  it('FAILS when a declared timeframe is missing', () => {
    const bars = goodBars(); delete (bars.B as unknown as Record<string, unknown>)['1d'];
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: bars });
    expect(errs.some((e) => e.includes('barsBySymbolAndTimeframe[B]') && e.includes('missing declared timeframe(s) 1d'))).toBe(true);
  });

  it('FAILS a timeframe the sidecar does not declare, even when its bars are correct', () => {
    // A well-formed 5m surface is still a surface nobody declared: the sidecar is the contract, so
    // shipping more than it says is a mismatch, not a bonus. Without this the set check is one-sided
    // and an undeclared timeframe rides along unverified.
    const bars = goodBars();
    (bars.A as Record<string, unknown>)['5m'] = FIVE_M_BARS;
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: bars });
    expect(errs.some((e) => e.includes('barsBySymbolAndTimeframe[A]') && e.includes('undeclared timeframe(s) 5m'))).toBe(true);
  });

  it('FAILS a timeframe name the contract does not define', () => {
    const bars = goodBars();
    (bars.A as Record<string, unknown>)['30m'] = [];
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: bars });
    expect(errs.some((e) => e.includes('undeclared timeframe(s) 30m'))).toBe(true);
  });

  it('FAILS duplicate or out-of-order bar tsMs', () => {
    // Bars are looked up by tsMs, so a repeated bucket agrees with the rows on every field and would
    // otherwise pass twice over — while a consumer reading them in order sees the bucket rewind.
    const dup = goodBars();
    dup.A!['1h'] = [dup.A!['1h']![0]!, { ...dup.A!['1h']![0]! }];
    expect(checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: dup })
      .some((e) => e.includes('[A][1h]') && e.includes('duplicate bar tsMs'))).toBe(true);

    // Two rows in two different hours, so 1h genuinely has two buckets to put out of order.
    const covTwoHours = {
      ...cov,
      period: { fromMs: from, toMs: 2 * 3_600_000 },
      totalGapBudgetMinutes: 1000, maxConsecutiveGapMinutes: 1000,
    };
    const flat = (tsMs: number, v: number) => ({ tsMs, open: v, high: v, low: v, close: v, volume: v });
    const rows = Object.fromEntries(cov.symbols.map((s) => [s, [
      { minute_ts: from, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { minute_ts: 3_600_000, open: 2, high: 2, low: 2, close: 2, volume: 2 },
    ]]));
    const unordered = Object.fromEntries(cov.symbols.map((s) => [s, {
      '1h': [flat(3_600_000, 2), flat(0, 1)],                                  // descending
      '1d': [{ tsMs: 0, open: 1, high: 2, low: 1, close: 2, volume: 3 }],
    }]));
    expect(checkFixture(covTwoHours, { rowsBySymbol: rows, barsBySymbolAndTimeframe: unordered })
      .some((e) => e.includes('[A][1h]') && e.includes('not strictly increasing'))).toBe(true);
  });

  it('passes a fixture that declares a different valid timeframe set', () => {
    // Nothing in the gate is specific to 1h/1d — that pair is a fixture-level choice, not a rule.
    const cov5 = { ...cov, barTimeframes: ['5m', '15m'] as const };
    expect(checkFixture(cov5, {
      rowsBySymbol: rowsWithVolume(),
      barsBySymbolAndTimeframe: Object.fromEntries(cov.symbols.map((s) => [s, { '5m': FIVE_M_BARS, '15m': FIFTEEN_M_BARS }])),
    })).toEqual([]);
  });

  it('FAILS a 5m fixture whose bars are the 1h aggregation under a 5m key', () => {
    const cov5 = { ...cov, barTimeframes: ['5m', '15m'] as const };
    const errs = checkFixture(cov5, {
      rowsBySymbol: rowsWithVolume(),
      // one bucket covering everything — right for 15m, wrong for 5m
      barsBySymbolAndTimeframe: Object.fromEntries(cov.symbols.map((s) => [s, { '5m': FIFTEEN_M_BARS, '15m': FIFTEEN_M_BARS }])),
    });
    expect(errs.some((e) => e.includes('[A][5m]'))).toBe(true);
  });

  it('FAILS a bar whose OHLC is wrong even though its volume is right', () => {
    // Comparing volume alone let a bar carry wrong prices as long as the sizes still added up.
    const bars = goodBars();
    bars.A!['1h']![0]!.high = 999; // volume untouched
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: bars });
    expect(errs.some((e) => e.includes('barsBySymbolAndTimeframe[A][1h]') && e.includes('high 999'))).toBe(true);
  });

  it('FAILS a bar whose open is taken from the wrong minute', () => {
    const bars = goodBars();
    bars.A!['1d']![0]!.open = 11; // the second minute's open, not the bucket's first
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: bars });
    expect(errs.some((e) => e.includes('[A][1d]') && e.includes('open 11'))).toBe(true);
  });

  it('FAILS a 1h bar whose volume does not equal the sum of the rows shipped for it', () => {
    // The other real defect: bars aggregated before duplicates were collapsed, so a re-written
    // minute was counted twice into its bucket.
    const bars = goodBars();
    bars.A!['1h']![0]!.volume += 2; // one extra minute's worth, as a double-count would produce
    const errs = checkFixture(cov, { rowsBySymbol: rowsWithVolume(), barsBySymbolAndTimeframe: bars });
    expect(errs.some((e) => e.includes('barsBySymbolAndTimeframe[A][1h]') && e.includes('volume') && e.includes("!= rows'"))).toBe(true);
  });

  it('FAILS a bar bucket that has no shipped rows left, and a bucket with rows but no bar', () => {
    const orphan = checkFixture(cov, {
      rowsBySymbol: rowsWithVolume(),
      // the next hour holds none of the shipped minutes (rows span minutes 1..10)
      barsBySymbolAndTimeframe: Object.fromEntries(cov.symbols.map((s) => [s, { '1h': [...goodBars()[s]!['1h']!, { tsMs: 3_600_000, volume: 1 }] }])),
    });
    expect(orphan.some((e) => e.includes('no shipped rows in its bucket'))).toBe(true);

    const missing = checkFixture(cov, {
      rowsBySymbol: rowsWithVolume(),
      barsBySymbolAndTimeframe: Object.fromEntries(cov.symbols.map((s) => [s, { '1h': [] }])),
    });
    expect(missing.some((e) => e.includes('have no bar'))).toBe(true);
  });

  it('FAILS an undeclared symbol smuggled in on a derived surface', () => {
    const errs = checkFixture(cov, {
      rowsBySymbol: rowsWithVolume(),
      barsBySymbolAndTimeframe: goodBars(),
      fundingBySymbol: { ZZZ: [{ tsMs: from }] },
    });
    expect(errs.some((e) => e.includes('fundingBySymbol') && e.includes('undeclared symbol ZZZ'))).toBe(true);
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
  // The one place the pair appears: what this fixture is authored to declare — and what the sidecar
  // it writes must then hold the bundle to. The verifier itself knows no preferred set.
  const E2E_TIMEFRAMES = ['1h', '1d'] as const;

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
    // The golden's own bars/funding/OI/liquidations belong to ITS symbols and span ITS window, so
    // re-keying only the rows would leave the fixture self-inconsistent — which the gate now (
    // correctly) rejects. Derive every surface from the rows this fixture actually ships.
    const historical = { ...golden.historical, ...deriveHistoricalSurfaces(rowsBySymbol as never, E2E_TIMEFRAMES), rowsBySymbol };
    const bundleStr = JSON.stringify({ ...golden, historical });

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
      barTimeframes: E2E_TIMEFRAMES,
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
