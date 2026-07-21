import { Ajv } from 'ajv';
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../src/snapshot/loader.js';

export const MINUTE_MS = 60_000;

export interface CoverageDoc {
  schemaVersion: 'fixture-coverage.1';
  period: { fromMs: number; toMs: number };
  symbols: string[];
  totalGapBudgetMinutes: number;
  maxConsecutiveGapMinutes: number;
}

const COVERAGE_SCHEMA = {
  $id: 'fixture-coverage',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'period', 'symbols', 'totalGapBudgetMinutes', 'maxConsecutiveGapMinutes'],
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

const TF_MS: Readonly<Record<string, number>> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

/** The derived surfaces of a historical block — everything that is NOT `rowsBySymbol`. */
export interface HistoricalBlock {
  rowsBySymbol?: Record<string, ReadonlyArray<{ minute_ts: number; volume?: number }>>;
  barsBySymbolAndTimeframe?: Record<string, Record<string, ReadonlyArray<{ tsMs: number; volume?: number }>>>;
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
  for (const [symbol, tfs] of Object.entries(historical.barsBySymbolAndTimeframe ?? {})) {
    if (!declared.has(symbol)) {
      errs.push(`barsBySymbolAndTimeframe: undeclared symbol ${symbol}`);
      continue;
    }
    const shipped = rows[symbol] ?? [];
    for (const [tf, bars] of Object.entries(tfs)) {
      const tfMs = TF_MS[tf];
      if (tfMs === undefined) { errs.push(`barsBySymbolAndTimeframe[${symbol}]: unknown timeframe ${tf}`); continue; }
      if (bars.length && shipped.some((r) => !Number.isFinite(r.volume))) {
        errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: rows carry no numeric volume, bars cannot be verified`);
        continue;
      }
      const expected = new Map<number, number>();
      for (const r of shipped) {
        const b = Math.floor(r.minute_ts / tfMs) * tfMs;
        expected.set(b, (expected.get(b) ?? 0) + (r.volume as number));
      }
      for (const bar of bars) {
        const want = expected.get(bar.tsMs);
        if (want === undefined) {
          errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: bar ${bar.tsMs} has no shipped rows in its bucket`);
          continue;
        }
        if (!Number.isFinite(bar.volume) || Math.abs((bar.volume as number) - want) > 1e-6) {
          errs.push(`barsBySymbolAndTimeframe[${symbol}][${tf}]: bar ${bar.tsMs} volume ${bar.volume} != row sum ${want}`);
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

/** Declared (coverage) vs actual (the whole historical block). Returns [] when the fixture passes.
 *  Symbol-set equality is exact over ALL keys (an extra empty key fails), then each declared
 *  symbol is checked non-empty — so `{ X: [] }` can never slip through. */
export function checkFixture(coverage: CoverageDoc, historical: HistoricalBlock | undefined): string[] {
  const rows = historical?.rowsBySymbol ?? {};
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

  // The rows are sound; now hold the surfaces derived from them to the same window and the same data.
  errs.push(...checkDerivedSurfaces(coverage, historical ?? {}));
  return errs;
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
