import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intersectToCommonGrid, deriveHistoricalSurfaces, writeWfoFixture } from '../../scripts/make-wfo-fixture.js';
import { loadSnapshot } from '../../src/snapshot/loader.js';

const M = 60_000;
const TFS = ['1h', '1d'] as const;

describe('intersectToCommonGrid', () => {
  it('keeps only minutes present in every symbol, within the window', () => {
    const rows = {
      A: [{ minute_ts: M, v: 1 }, { minute_ts: 2 * M, v: 2 }, { minute_ts: 3 * M, v: 3 }],
      B: [{ minute_ts: M, v: 9 }, { minute_ts: 3 * M, v: 8 }, { minute_ts: 99 * M, v: 7 }],
    };
    const { grid, filtered, perSymbol } = intersectToCommonGrid(rows, ['A', 'B'], M, 4 * M);
    expect(grid).toEqual([M, 3 * M]);
    expect(filtered.A!.map((r) => r.minute_ts)).toEqual([M, 3 * M]);
    expect(perSymbol.A).toEqual({ inWindow: 3, final: 2 });
    expect(perSymbol.B).toEqual({ inWindow: 2, final: 2 }); // 99*M excluded from inWindow
  });
});

describe('deriveHistoricalSurfaces', () => {
  const row = (minute_ts: number, over: Record<string, unknown> = {}) => ({
    minute_ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
    funding_rate: null as number | null, oi_total_usd: null as number | null,
    liq_long_usd: null as number | null, liq_short_usd: null as number | null, ...over,
  });
  const HOUR = 3_600_000;

  it('sums each 1h bar from exactly the rows it is given, never double-counting', () => {
    // Regression: bars used to come from the exporter, which aggregates BEFORE duplicate rows are
    // collapsed, so a re-written minute was summed into its bar twice (measured: BTCUSDT 1h at
    // 2026-07-03T13:00Z read 2243.652 against a row sum of 2156.813).
    const rows = { A: [row(0, { volume: 3 }), row(60_000, { volume: 4 }), row(120_000, { volume: 5 })] };
    const bars = deriveHistoricalSurfaces(rows, TFS).barsBySymbolAndTimeframe.A!['1h']!;
    expect(bars).toHaveLength(1);
    expect(bars[0]!.volume).toBe(12);
  });

  it('carries OHLC across a bucket: open first, close last, high/low extremes', () => {
    const rows = { A: [
      row(0, { open: 10, high: 12, low: 9, close: 11 }),
      row(60_000, { open: 11, high: 20, low: 2, close: 15 }),
    ] };
    expect(deriveHistoricalSurfaces(rows, TFS).barsBySymbolAndTimeframe.A!['1h']![0])
      .toMatchObject({ open: 10, high: 20, low: 2, close: 15 });
  });

  it('emits funding/OI only for rows that carry them, at the row minute', () => {
    const rows = { A: [row(0), row(60_000, { funding_rate: 0.5, oi_total_usd: 42 })] };
    const d = deriveHistoricalSurfaces(rows, TFS);
    expect(d.fundingBySymbol.A).toEqual([{ tsMs: 60_000, symbol: 'A', rate: 0.5 }]);
    expect(d.openInterestBySymbol.A).toEqual([{ tsMs: 60_000, symbol: 'A', openInterestUsd: 42 }]);
  });

  it('expands liquidations per side and drops zero sides', () => {
    const rows = { A: [row(0, { liq_long_usd: 7, liq_short_usd: 0 }), row(60_000, { liq_long_usd: 0, liq_short_usd: 3 })] };
    expect(deriveHistoricalSurfaces(rows, TFS).liquidationsBySymbol.A).toEqual([
      { tsMs: 0, symbol: 'A', side: 'long', sizeUsd: 7 },
      { tsMs: 60_000, symbol: 'A', side: 'short', sizeUsd: 3 },
    ]);
  });

  it('cannot place any surface outside the rows it derives from', () => {
    // Regression: funding/OI/liquidations used to be carried over with a symbol filter only, so a
    // 42-day fixture shipped 50 days of them (measured: 54,630 OI entries before the window start).
    const rows = { A: [row(HOUR), row(HOUR + 60_000)] };
    const d = deriveHistoricalSurfaces({ A: rows.A.map((r) => ({ ...r, oi_total_usd: 1, funding_rate: 1, liq_long_usd: 1 })) }, TFS);
    for (const list of [d.fundingBySymbol.A!, d.openInterestBySymbol.A!, d.liquidationsBySymbol.A!]) {
      for (const e of list) expect(e.tsMs).toBeGreaterThanOrEqual(HOUR);
    }
    expect(d.barsBySymbolAndTimeframe.A!['1d']!.every((b) => b.tsMs === 0)).toBe(true); // day bucket of HOUR
  });
});

describe('writeWfoFixture (end-to-end)', () => {
  // Use a real committed, gzipped, native-1m source; pick 5 of its symbols and a small window.
  const SOURCE = 'data/snapshots/fixtures/2026-06-22-to-2026-06-28-vps';

  it('writes a loadable fixture with sidecars authored from flags', () => {
    const src = loadSnapshot(SOURCE).bundle;
    const rows = src.historical!.rowsBySymbol!;
    const symbols = Object.keys(rows).sort().slice(0, 5);
    // A window the symbols genuinely SHARE: anchored at the LATEST first row,
    // so every series has data from there.
    //
    // It used to be anchored at the EARLIEST first row — which put ARXUSDT
    // (whose series starts later) at zero rows in the window, so the
    // intersection was empty and this test asserted a fixture of ZERO rows.
    // Every check below then passed vacuously: 0 === 0 for each symbol, and
    // "no surface outside the window" is trivially true when there are no
    // surfaces. The empty-intersection gate is what surfaced it.
    const firstTs = Math.max(...symbols.map((s) => rows[s]![0]!.minute_ts));
    const fromMs = firstTs;
    const toMs = firstTs + 10 * M;

    const out = join(mkdtempSync(join(tmpdir(), 'wfo-')), 'w42');
    const ranking = { probeWindow: { fromMs: 1, toMs: 2 }, turnoverSha256: 'abc', candidateCount: 9, primary: 'HUSDT', selected: [] };
    const res = writeWfoFixture({ source: SOURCE, out, symbols, fromMs, toMs, barTimeframes: TFS, totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10, ranking });

    // 0. the fixture is not empty — without this every assertion below can
    //    pass on zero rows, which is how the previous window went unnoticed.
    expect(res.gridSize).toBeGreaterThan(0);

    // 1. loads through the full gate chain
    const built = loadSnapshot(out).bundle;
    expect(Object.keys(built.historical!.rowsBySymbol!).sort()).toEqual([...symbols].sort());

    // 2. coverage.json comes verbatim from the flags
    const cov = JSON.parse(readFileSync(join(out, 'coverage.json'), 'utf8'));
    expect(cov).toMatchObject({ schemaVersion: 'fixture-coverage.1', period: { fromMs, toMs }, barTimeframes: ['1h', '1d'], totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10 });
    expect([...cov.symbols].sort()).toEqual([...symbols].sort());

    // 3. checksum entry matches the written bundle file
    const checks = JSON.parse(readFileSync(join(out, 'checksums.json'), 'utf8'));
    expect(checks[res.bundleRef]).toMatch(/^[0-9a-f]{64}$/);

    // 4. provenance embeds the ranking evidence verbatim and splits attrition
    const prov = JSON.parse(readFileSync(join(out, 'provenance.json'), 'utf8'));
    expect(prov.ranking).toEqual(ranking);
    const E = (toMs - fromMs) / M;
    for (const s of symbols) {
      const p = prov.perSymbol[s];
      expect(p.finalRowsAfterIntersection).toBe(res.gridSize);
      expect(p.missingMinutesInSelectedWindow).toBe(E - p.rowsInSelectedWindowBeforeIntersection);
      expect(p.droppedOutsideSelectedWindow).toBe(p.rawRowsInProbeWindow - p.rowsInSelectedWindowBeforeIntersection);
      expect(p.droppedByIntersection).toBe(p.rowsInSelectedWindowBeforeIntersection - p.finalRowsAfterIntersection);
    }
    expect(existsSync(join(out, 'provenance.json'))).toBe(true);

    // 5. NO surface may reach outside the declared window. The source is a 7-day fixture and this
    //    window is 10 minutes, so a carried-over series would be caught here by three orders of
    //    magnitude. This is the assertion that was missing when the first T2 shipped 54,630 open
    //    interest entries and 18,119 liquidations from before its own start.
    const bh = built.historical!;
    for (const s of symbols) {
      for (const e of bh.fundingBySymbol![s] ?? []) expect(e.tsMs, `funding ${s}`).toBeGreaterThanOrEqual(fromMs);
      for (const e of bh.fundingBySymbol![s] ?? []) expect(e.tsMs, `funding ${s}`).toBeLessThan(toMs);
      for (const e of bh.openInterestBySymbol![s] ?? []) expect(e.tsMs, `oi ${s}`).toBeGreaterThanOrEqual(fromMs);
      for (const e of bh.openInterestBySymbol![s] ?? []) expect(e.tsMs, `oi ${s}`).toBeLessThan(toMs);
      for (const e of bh.liquidationsBySymbol![s] ?? []) expect(e.tsMs, `liq ${s}`).toBeGreaterThanOrEqual(fromMs);
      for (const e of bh.liquidationsBySymbol![s] ?? []) expect(e.tsMs, `liq ${s}`).toBeLessThan(toMs);
    }

    // 6. every bar must equal the rows the fixture actually ships — not the rows the exporter saw
    //    before duplicates were collapsed and before the intersection dropped minutes.
    for (const s of symbols) {
      const shipped = bh.rowsBySymbol![s]!;
      for (const [tf, tfMs] of [['1h', 3_600_000], ['1d', 86_400_000]] as const) {
        const expected = new Map<number, number>();
        for (const r of shipped) {
          const b = Math.floor(r.minute_ts / tfMs) * tfMs;
          expected.set(b, (expected.get(b) ?? 0) + (r as { volume: number }).volume);
        }
        for (const bar of bh.barsBySymbolAndTimeframe![s]?.[tf] ?? []) {
          expect(bar.volume, `${s} ${tf} @ ${bar.tsMs}`).toBeCloseTo(expected.get(bar.tsMs)!, 6);
        }
      }
    }
  });
});

// The authoring pipeline used to hard-throw on anything but 5 symbols, which is why the only WFO
// tier that ever existed is 5 wide. That width is a research choice (how many symbols a
// distribution is measured over), not a property of the fixture format — the 2026-07-27 battery
// calibration could only observe ONE trading symbol because of it.
describe('writeWfoFixture — symbol count is an input, not a constant', () => {
  const SOURCE = 'data/snapshots/fixtures/2026-06-22-to-2026-06-28-vps';
  const windowFor = (symbols: string[]) => {
    const rows = loadSnapshot(SOURCE).bundle.historical!.rowsBySymbol!;
    const firstTs = Math.max(...symbols.map((s) => rows[s]![0]!.minute_ts));
    return { fromMs: firstTs, toMs: firstTs + 10 * M };
  };
  const pick = (n: number) => Object.keys(loadSnapshot(SOURCE).bundle.historical!.rowsBySymbol!).sort().slice(0, n);
  const write = (symbols: string[], over: Record<string, unknown> = {}) => {
    const { fromMs, toMs } = windowFor(symbols);
    const out = join(mkdtempSync(join(tmpdir(), 'wfo-n-')), 'wn');
    writeWfoFixture({
      source: SOURCE, out, symbols, fromMs, toMs, barTimeframes: TFS,
      totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10, ...over,
    });
    return out;
  };

  it('writes a loadable 9-symbol fixture whose sidecar declares all 9', () => {
    const symbols = pick(9);
    const out = write(symbols);

    expect(Object.keys(loadSnapshot(out).bundle.historical!.rowsBySymbol!).sort()).toEqual([...symbols].sort());
    expect(JSON.parse(readFileSync(join(out, 'coverage.json'), 'utf8')).symbols).toEqual([...symbols].sort());
  });

  it('writes a loadable single-symbol fixture (the intersection is then trivial)', () => {
    const symbols = pick(1);
    expect(JSON.parse(readFileSync(join(write(symbols), 'coverage.json'), 'utf8')).symbols).toEqual(symbols);
  });

  it('still rejects an empty symbol list and duplicates — the sidecar demands a unique non-empty set', () => {
    expect(() => write([])).toThrow(/at least one symbol/i);
    const [a] = pick(1);
    expect(() => write([a!, a!])).toThrow(/duplicate/i);
  });

  it('provenance describes the actual width, never a hardcoded 5', () => {
    const symbols = pick(3);
    const prov = JSON.parse(readFileSync(join(write(symbols), 'provenance.json'), 'utf8'));
    expect(prov.note).toContain('3');
    expect(prov.note).not.toContain('5 source series');
  });

  it('refuses a fixture too large to load, before anything reaches disk', () => {
    // Ceiling passed explicitly so the test need not build a 512 MiB bundle. The real default is
    // V8's max string length, measured to cap a 42-day fixture at ~15 symbols.
    const symbols = pick(3);
    const { fromMs, toMs } = windowFor(symbols);
    const out = join(mkdtempSync(join(tmpdir(), 'wfo-big-')), 'wbig');

    expect(() => writeWfoFixture({
      source: SOURCE, out, symbols, fromMs, toMs, barTimeframes: TFS,
      totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10, maxDecodedBytes: 1024,
    })).toThrow(/too large to load/i);

    // The whole point of failing at authoring time: no partial artifact is left behind.
    expect(existsSync(join(out, 'manifest.json'))).toBe(false);
    expect(existsSync(join(out, 'coverage.json'))).toBe(false);
  });

  it('rankingTieBreak is derived from the ranking evidence, not asserted about it', () => {
    const symbols = pick(4);
    const ranking = {
      probeWindow: { fromMs: 1, toMs: 2 }, turnoverSha256: 'abc', candidateCount: 9, primary: symbols[0],
      selected: symbols.map((s, i) => ({ symbol: s, rank: i, turnover: 1 })),
    };
    const prov = JSON.parse(readFileSync(join(write(symbols, { ranking }), 'provenance.json'), 'utf8'));
    // 4 selected = primary + top-3
    expect(prov.rankingTieBreak).toContain('top-3');
    expect(prov.rankingTieBreak).toContain(symbols[0]!);

    // Without ranking evidence there is nothing to describe — the field must be absent rather than
    // a sentence the fixture cannot back up.
    const bare = JSON.parse(readFileSync(join(write(symbols), 'provenance.json'), 'utf8'));
    expect(bare).not.toHaveProperty('rankingTieBreak');
  });
});

describe('writeWfoFixture: refuses an empty intersection', () => {
  const SRC = 'data/snapshots/fixtures/2026-06-22-to-2026-06-28-vps';

  it('throws instead of writing a zero-row fixture, and leaves nothing behind', () => {
    const src = loadSnapshot(SRC).bundle;
    const rows = src.historical!.rowsBySymbol!;
    const symbols = Object.keys(rows).sort().slice(0, 2);
    // A window strictly BEFORE the source's data: every symbol is empty in it,
    // so the intersection is empty too.
    const firstTs = Math.min(...symbols.map((s) => rows[s]![0]!.minute_ts));
    const out = join(mkdtempSync(join(tmpdir(), 'wfo-empty-')), 'w42');

    expect(() =>
      writeWfoFixture({
        source: SRC, out, symbols,
        fromMs: firstTs - 10 * M, toMs: firstTs,
        barTimeframes: TFS, totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10,
      }),
    ).toThrow(/no minute is present in all 2 symbols/);

    // Fail BEFORE anything reaches disk: a half-written fixture directory reads
    // as an artifact somebody may pick up.
    expect(existsSync(join(out, 'manifest.json'))).toBe(false);
    expect(existsSync(join(out, 'provenance.json'))).toBe(false);
    expect(existsSync(join(out, 'coverage.json'))).toBe(false);
  });
});
