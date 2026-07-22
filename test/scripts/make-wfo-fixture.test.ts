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
    // a small window covering the first ~10 minutes shared by these symbols
    const firstTs = Math.min(...symbols.map((s) => rows[s]![0]!.minute_ts));
    const fromMs = firstTs;
    const toMs = firstTs + 10 * M;

    const out = join(mkdtempSync(join(tmpdir(), 'wfo-')), 'w42');
    const ranking = { probeWindow: { fromMs: 1, toMs: 2 }, turnoverSha256: 'abc', candidateCount: 9, primary: 'HUSDT', selected: [] };
    const res = writeWfoFixture({ source: SOURCE, out, symbols, fromMs, toMs, barTimeframes: TFS, totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10, ranking });

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
