import { Ajv } from 'ajv';
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../src/snapshot/loader.js';
import type { Timeframe } from '../src/contract/historical-read/dto.js';

export const MINUTE_MS = 60_000;

/** Bucket size of every timeframe the contract defines. Typed `Record<Timeframe, …>` on purpose:
 *  widening `Timeframe` in the SDK contract breaks compilation here until this map is widened too,
 *  so a fixture can never declare a timeframe the verifier has no bucket size for. */
export const TF_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

/** Sole source of "which timeframes exist" — the sidecar picks a subset, it never invents one. */
export const CONTRACT_TIMEFRAMES = Object.keys(TF_MS) as Timeframe[];

export interface CoverageDoc {
  schemaVersion: 'fixture-coverage.1';
  period: { fromMs: number; toMs: number };
  symbols: string[];
  /** The derived timeframes this fixture claims to ship, for every declared symbol. The bundle must
   *  carry exactly this set — no more, no less. See checkDerivedSurfaces. */
  barTimeframes: ReadonlyArray<Timeframe>;
  totalGapBudgetMinutes: number;
  maxConsecutiveGapMinutes: number;
}

const COVERAGE_SCHEMA = {
  $id: 'fixture-coverage',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'period', 'symbols', 'barTimeframes', 'totalGapBudgetMinutes', 'maxConsecutiveGapMinutes'],
  properties: {
    schemaVersion: { const: 'fixture-coverage.1' },
    period: {
      type: 'object',
      additionalProperties: false,
      required: ['fromMs', 'toMs'],
      properties: {
        fromMs: { type: 'integer', minimum: 0, multipleOf: MINUTE_MS },
        toMs: { type: 'integer', minimum: 0, multipleOf: MINUTE_MS },
      },
    },
    symbols: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5, uniqueItems: true },
    barTimeframes: { type: 'array', items: { enum: CONTRACT_TIMEFRAMES }, minItems: 1, uniqueItems: true },
    totalGapBudgetMinutes: { type: 'integer', minimum: 0 },
    maxConsecutiveGapMinutes: { type: 'integer', minimum: 0 },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(COVERAGE_SCHEMA);

/** AJV structural validation plus the one cross-field rule AJV can't express (toMs > fromMs).
 *  Returns [] when the sidecar is valid. */
export function validateCoverageDoc(doc: unknown): string[] {
  if (!validateSchema(doc)) return [`sidecar schema invalid: ${ajv.errorsText(validateSchema.errors)}`];
  const c = doc as CoverageDoc;
  return c.period.toMs > c.period.fromMs
    ? []
    : [`period.toMs ${c.period.toMs} must exceed fromMs ${c.period.fromMs}`];
}

/** Corruption gate for one symbol's rows: alignment, no duplicates, strictly increasing. */
export function checkRowsIntegrity(symbol: string, rows: ReadonlyArray<{ minute_ts: number }>): string[] {
  const errs: string[] = [];
  const seen = new Set<number>();
  let prev = -Infinity;
  for (const r of rows) {
    const t = r.minute_ts;
    if (t % MINUTE_MS !== 0) errs.push(`${symbol}: minute_ts ${t} not minute-aligned`);
    if (seen.has(t)) errs.push(`${symbol}: duplicate minute_ts ${t}`);
    seen.add(t);
    if (t <= prev) errs.push(`${symbol}: minute_ts ${t} not strictly increasing (prev ${prev})`);
    prev = t;
  }
  return errs;
}

export function totalGap(grid: number[], fromMs: number, toMs: number): number {
  return (toMs - fromMs) / MINUTE_MS - grid.length;
}

/** Longest contiguous run of missing minutes, counting the window edges as runs.
 *  `grid` must be strictly ascending and inside [fromMs, toMs). */
export function maxConsecutiveGap(grid: number[], fromMs: number, toMs: number): number {
  let max = 0;
  let prev = fromMs - MINUTE_MS; // leading run = (grid[0] - fromMs) / MINUTE_MS
  for (const g of grid) {
    const run = (g - prev) / MINUTE_MS - 1;
    if (run > max) max = run;
    prev = g;
  }
  const trailing = (toMs - prev) / MINUTE_MS - 1;
  return Math.max(max, trailing);
}

const OHLCV = ['open', 'high', 'low', 'close', 'volume'] as const;

export interface OhlcvRow { minute_ts: number; open?: number; high?: number; low?: number; close?: number; volume?: number }
export interface OhlcvBar { tsMs: number; open?: number; high?: number; low?: number; close?: number; volume?: number }

export interface HistoricalBlock {
  rowsBySymbol?: Record<string, ReadonlyArray<OhlcvRow>>;
  barsBySymbolAndTimeframe?: Record<string, Record<string, ReadonlyArray<OhlcvBar>>>;
  fundingBySymbol?: Record<string, ReadonlyArray<{ tsMs: number }>>;
  openInterestBySymbol?: Record<string, ReadonlyArray<{ tsMs: number }>>;
  liquidationsBySymbol?: Record<string, ReadonlyArray<{ tsMs: number }>>;
}

/** The derived surfaces must agree with the rows the fixture ships, and must not reach outside the
 *  declared window. Both properties were violated by a real committed fixture:
 *
 *  - funding/open-interest/liquidations were carried across a symbol filter with no window clip, so
 *    a 42-day fixture shipped 54,630 open-interest entries and 18,119 liquidations from before its
 *    own start;
 *  - bars came from an aggregate computed BEFORE duplicate rows were collapsed and before the grid
 *    intersection, so their volume double-counted re-written minutes and they retained buckets whose
 *    minutes `rowsBySymbol` no longer had.
 *
 *  Checking only `rowsBySymbol` cannot see either, which is why this exists. */
export function checkDerivedSurfaces(coverage: CoverageDoc, historical: HistoricalBlock): string[] {
  const { fromMs, toMs } = coverage.period;
  const declared = new Set(coverage.symbols);
  const errs: string[] = [];

  const series: ReadonlyArray<readonly [string, Record<string, ReadonlyArray<{ tsMs: number }>> | undefined]> = [
    ['fundingBySymbol', historical.fundingBySymbol],
    ['openInterestBySymbol', historical.openInterestBySymbol],
    ['liquidationsBySymbol', historical.liquidationsBySymbol],
  ];
  for (const [name, bySymbol] of series) {
    for (const [symbol, entries] of Object.entries(bySymbol ?? {})) {
      if (!declared.has(symbol)) {
        errs.push(`${name}: undeclared symbol ${symbol}`);
        continue;
      }
      const outside = entries.filter((e) => e.tsMs < fromMs || e.tsMs >= toMs);
      if (outside.length) {
        const first = Math.min(...outside.map((e) => e.tsMs));
        errs.push(`${name}[${symbol}]: ${outside.length} entr(ies) outside window [${fromMs}, ${toMs}), earliest ${first}`);
      }
    }
  }

  const rows = historical.rowsBySymbol ?? {};
  const barsBySymbol = historical.barsBySymbolAndTimeframe ?? {};

  for (const symbol of Object.keys(barsBySymbol)) {
    if (!declared.has(symbol)) errs.push(`barsBySymbolAndTimeframe: undeclared symbol ${symbol}`);
  }

  // Driven by the DECLARED symbols and the DECLARED timeframes, not by whatever the bundle happens
  // to contain — otherwise deleting a symbol, a timeframe, or the whole surface would pass silently.
  const declaredTfs = [...coverage.barTimeframes].sort();
  for (const symbol of coverage.symbols) {
    const shipped = rows[symbol] ?? [];
    const tfs = barsBySymbol[symbol];
    if (tfs === undefined) {
      errs.push(`barsBySymbolAndTimeframe: missing bars for declared symbol ${symbol}`);
      continue;
    }

    // Exact set equality, both directions. A missing timeframe is data the sidecar promised and the
    // bundle does not have; an extra one is data nobody declared, so nothing holds it to the rows.
    const actualTfs = Object.keys(tfs).sort();
    const missingTfs = declaredTfs.filter((t) => !actualTfs.includes(t));
    const extraTfs = actualTfs.filter((t) => !declaredTfs.includes(t as Timeframe));
    if (missingTfs.length) errs.push(`barsBySymbolAndTimeframe[${symbol}]: missing declared timeframe(s) ${missingTfs.join(', ')}`);
    if (extraTfs.length) errs.push(`barsBySymbolAndTimeframe[${symbol}]: undeclared timeframe(s) ${extraTfs.join(', ')}`);

    for (const tf of coverage.barTimeframes) {
      const bars = tfs[tf];
      if (bars === undefined) continue; // already reported as missing
      const tfMs = TF_MS[tf];
      if (shipped.some((r) => OHLCV.some((f) => !Number.isFinite(r[f])))) {
        errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: rows carry no numeric OHLCV, bars cannot be verified`);
        continue;
      }

      // Rebuild each bucket the same way the authoring tool does: open of the first minute, close of
      // the last, extremes across the bucket, volume summed. Comparing volume alone let a bar keep
      // wrong prices as long as the sizes happened to add up.
      const expected = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
      for (const r of [...shipped].sort((a, b) => a.minute_ts - b.minute_ts)) {
        const b = Math.floor(r.minute_ts / tfMs) * tfMs;
        const acc = expected.get(b);
        if (!acc) expected.set(b, { open: r.open!, high: r.high!, low: r.low!, close: r.close!, volume: r.volume! });
        else {
          acc.high = Math.max(acc.high, r.high!);
          acc.low = Math.min(acc.low, r.low!);
          acc.close = r.close!;
          acc.volume += r.volume!;
        }
      }

      // Bars are matched to buckets by tsMs, so a repeated bucket agrees with the rows on every
      // field and would pass twice over; and a consumer reading the array in order would see the
      // series rewind. Neither is visible to the value comparison below.
      const seenTs = new Set<number>();
      let prevTs = -Infinity;
      for (const bar of bars) {
        if (seenTs.has(bar.tsMs)) errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: duplicate bar tsMs ${bar.tsMs}`);
        else if (bar.tsMs <= prevTs) errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: bar tsMs ${bar.tsMs} not strictly increasing (prev ${prevTs})`);
        seenTs.add(bar.tsMs);
        prevTs = bar.tsMs;
      }

      for (const bar of bars) {
        const want = expected.get(bar.tsMs);
        if (want === undefined) {
          errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: bar ${bar.tsMs} has no shipped rows in its bucket`);
          continue;
        }
        for (const f of OHLCV) {
          const got = bar[f];
          if (!Number.isFinite(got) || Math.abs((got as number) - want[f]) > 1e-6) {
            errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: bar ${bar.tsMs} ${f} ${got} != rows' ${want[f]}`);
          }
        }
      }
      const missing = [...expected.keys()].filter((b) => !bars.some((x) => x.tsMs === b));
      if (missing.length) {
        errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: ${missing.length} bucket(s) with shipped rows have no bar`);
      }
    }
  }
  return errs;
}

/** Declared (coverage) vs actual, restricted to `rowsBySymbol`. Returns [] when the rows pass.
 *  Symbol-set equality is exact over ALL keys (an extra empty key fails), then each declared
 *  symbol is checked non-empty — so `{ X: [] }` can never slip through. */
export function checkRows(coverage: CoverageDoc, rowsBySymbol: Record<string, ReadonlyArray<OhlcvRow>> | undefined): string[] {
  const rows = rowsBySymbol ?? {};
  const { fromMs, toMs } = coverage.period;

  const keys = Object.keys(rows).sort();
  const declared = [...coverage.symbols].sort();
  if (JSON.stringify(keys) !== JSON.stringify(declared)) {
    return [`symbols mismatch: declared [${declared.join(', ')}] vs rowsBySymbol keys [${keys.join(', ')}]`];
  }
  const empty = declared.filter((s) => (rows[s]?.length ?? 0) === 0);
  if (empty.length) return [`empty rows for declared symbol(s): ${empty.join(', ')}`];

  const errs: string[] = [];
  for (const s of declared) errs.push(...checkRowsIntegrity(s, rows[s]!));
  if (errs.length) return errs;

  const grids = declared.map((s) => rows[s]!.map((r) => r.minute_ts));
  const refKey = grids[0]!.join(',');
  for (let i = 1; i < grids.length; i++) {
    if (grids[i]!.join(',') !== refKey) errs.push(`grid mismatch: ${declared[i]} minute_ts set differs from ${declared[0]}`);
  }
  if (errs.length) return errs;

  const grid = grids[0]!; // strictly ascending (corruption gate) and identical across symbols
  if (grid.some((g) => g < fromMs || g >= toMs)) {
    return [`row minute_ts outside window [${fromMs}, ${toMs})`];
  }

  const tg = totalGap(grid, fromMs, toMs);
  if (tg > coverage.totalGapBudgetMinutes) errs.push(`total gap ${tg} > budget ${coverage.totalGapBudgetMinutes}`);
  const mcg = maxConsecutiveGap(grid, fromMs, toMs);
  if (mcg > coverage.maxConsecutiveGapMinutes) errs.push(`max consecutive gap ${mcg} > budget ${coverage.maxConsecutiveGapMinutes}`);
  return errs;
}

/** The full artifact gate: the rows, and every surface derived from them. */
export function checkFixture(coverage: CoverageDoc, historical: HistoricalBlock | undefined): string[] {
  const rowErrs = checkRows(coverage, historical?.rowsBySymbol);
  // Only worth interrogating the derived surfaces once the rows they must agree with are sound;
  // otherwise every bar would be reported as disagreeing with rows we already rejected.
  if (rowErrs.length) return rowErrs;
  return checkDerivedSurfaces(coverage, historical ?? {});
}

/** Coverage policy is per root, not global.
 *  - `fixtures/**` predates the sidecar, so a missing coverage.json there is a legacy WARN.
 *  - `wfo/**` exists only for coverage-declaring tiers, so a missing sidecar there is a FAIL:
 *    otherwise deleting coverage.json would silently turn this gate green. */
const SCAN_ROOTS: ReadonlyArray<{ root: string; coverageRequired: boolean }> = [
  { root: 'data/snapshots/fixtures', coverageRequired: false },
  { root: 'data/snapshots/wfo', coverageRequired: true },
];

function fixtureDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).map((n) => join(root, n)).filter((p) => statSync(p).isDirectory());
}

/** Scan the two fixture roots under `baseDir`. Returns a process exit code (0 ok / 1 any FAIL). */
export function runFixtureVerification(baseDir: string): number {
  let failed = 0;
  let enforced = 0;
  for (const { root, coverageRequired } of SCAN_ROOTS) {
    for (const dir of fixtureDirs(join(baseDir, root))) {
      const coveragePath = join(dir, 'coverage.json');
      if (!existsSync(coveragePath)) {
        if (coverageRequired) {
          console.error(`FAIL  ${dir}\n  - coverage.json is required under ${root} (declared-coverage tier)`);
          failed++;
        } else {
          console.log(`WARN  ${dir} — legacy (no declared coverage)`);
        }
        continue;
      }
      enforced++;

      let doc: unknown;
      try { doc = JSON.parse(readFileSync(coveragePath, 'utf8')); }
      catch (e) { console.error(`FAIL  ${dir}\n  - coverage.json is not valid JSON: ${(e as Error).message}`); failed++; continue; }

      const schemaErrs = validateCoverageDoc(doc);
      if (schemaErrs.length) { console.error(`FAIL  ${dir}\n${schemaErrs.map((e) => `  - ${e}`).join('\n')}`); failed++; continue; }

      let historical: HistoricalBlock | undefined;
      try { historical = loadSnapshot(dir).bundle.historical as HistoricalBlock | undefined; }
      catch (e) { console.error(`FAIL  ${dir}\n  - could not load snapshot: ${(e as Error).message}`); failed++; continue; }

      const errs = checkFixture(doc as CoverageDoc, historical);
      if (errs.length) { console.error(`FAIL  ${dir}\n${errs.map((e) => `  - ${e}`).join('\n')}`); failed++; }
      else console.log(`OK    ${dir}`);
    }
  }
  if (failed) { console.error(`verify_fixtures: ${failed} fixture(s) FAILED`); return 1; }
  console.log(`verify_fixtures: OK (${enforced} enforced, legacy warned)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runFixtureVerification('.'));
}
