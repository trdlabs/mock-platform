# WFO Extended Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `trading-mock-platform` half of the `wfo-extended-fixture` initiative — a fixture integrity/coverage validator (item 3), a committed 42-day native-1m T2 fixture (item 1), and the code-default `MOCK_SNAPSHOT_REF` fix (item 5).

**Architecture:** Declared coverage lives in a versioned **sidecar** (`coverage.json`) read only by a new CI script `verify_fixtures.ts`; the runtime loader, `snapshot.1` schema, and `compat.ts` are untouched. The validator compares *declared* (authored from fetch intent) against *actual* (computed from the bundle) on a unified minute grid shared by all five symbols. The T2 fixture is produced by a new authoring tool from a single read-only VPS pull, validated in enforce mode, and committed under `data/snapshots/wfo/` so the demo image is unchanged.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `ajv` (already a dep), `vitest`, `tsx`. Spec: [`docs/superpowers/specs/2026-07-21-wfo-extended-fixture-design.md`](../specs/2026-07-21-wfo-extended-fixture-design.md).

## Global Constraints

- ESM NodeNext: every relative import uses a `.js` specifier even for `.ts` sources.
- No manifest schema / loader / `compat.ts` / `snapshot.1` changes. Coverage is a sidecar.
- Declared coverage fields are **never** derived from bundle content (anti-tautology): the authoring tool takes them as required CLI flags; the validator only reads and compares, never writes.
- Frozen budgets (in the sidecar, as integers): `totalGapBudgetMinutes = 6480`, `maxConsecutiveGapMinutes = 1440`.
- `MINUTE_MS = 60_000`, `DAY_MS = 86_400_000`; all `minute_ts` / `period` bounds minute-aligned; window half-open `[fromMs, toMs)`.
- T2 symbols: exactly 5 = `HUSDT` + top-4 by summed 1m turnover (excl. HUSDT, ties `symbol ASC`).
- T2 lives at `data/snapshots/wfo/<from>-to-<to>-vps-wfo42d/`; the Dockerfile only `COPY`s `data/snapshots/fixtures`, so T2 stays out of the image.
- VPS access is read-only; no secrets printed or committed; commit the fixture only after `verify:fixtures` passes in enforce mode; on any blocker (no ranking data, no conforming 42-day window) **stop and report**, never substitute synthetic data.
- Item 5's code-default points at the **T1** SSOT fixture `fixtures/2026-06-22-to-2026-06-28-vps`, **not** T2.

---

### Task 1: Coverage sidecar schema + document validation

**Files:**
- Create: `scripts/verify_fixtures.ts`
- Test: `test/scripts/verify-fixtures.test.ts`

**Interfaces:**
- Produces: `MINUTE_MS: number`; `interface CoverageDoc { schemaVersion: 'fixture-coverage.1'; period: { fromMs: number; toMs: number }; symbols: string[]; totalGapBudgetMinutes: number; maxConsecutiveGapMinutes: number }`; `validateCoverageDoc(doc: unknown): string[]` (returns `[]` when valid).

- [ ] **Step 1: Write the failing test**

```ts
// test/scripts/verify-fixtures.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts`
Expected: FAIL — cannot resolve `../../scripts/verify_fixtures.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/verify_fixtures.ts
import { Ajv } from 'ajv';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify_fixtures.ts test/scripts/verify-fixtures.test.ts
git commit -m "feat(fixtures): coverage sidecar schema + validateCoverageDoc"
```

---

### Task 2: Declared-vs-actual comparator (corruption gate, unified grid, gap budgets)

**Files:**
- Modify: `scripts/verify_fixtures.ts`
- Test: `test/scripts/verify-fixtures.test.ts`

**Interfaces:**
- Consumes: `CoverageDoc`, `MINUTE_MS` from Task 1.
- Produces:
  - `checkRowsIntegrity(symbol: string, rows: ReadonlyArray<{ minute_ts: number }>): string[]`
  - `totalGap(grid: number[], fromMs: number, toMs: number): number`
  - `maxConsecutiveGap(grid: number[], fromMs: number, toMs: number): number`
  - `checkFixture(coverage: CoverageDoc, rowsBySymbol: Record<string, ReadonlyArray<{ minute_ts: number }>> | undefined): string[]` (returns `[]` when the fixture passes)

- [ ] **Step 1: Write the failing tests**

```ts
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
    const r = full(); r.A = [...r.A, { minute_ts: from }];
    expect(checkFixture(cov, r).some((e) => e.includes('duplicate'))).toBe(true);
  });
  it('fails a misaligned minute_ts', () => {
    const r = full(); r.A = [{ minute_ts: from + 30_000 }, ...r.A.slice(1)];
    expect(checkFixture(cov, r).some((e) => e.includes('not minute-aligned'))).toBe(true);
  });
  it('fails non-strictly-increasing rows', () => {
    const r = full(); r.A = [r.A[1]!, r.A[0]!, ...r.A.slice(2)];
    expect(checkFixture(cov, r).some((e) => e.includes('strictly increasing'))).toBe(true);
  });
  it('fails non-identical grids', () => {
    const r = full(); r.B = r.B.slice(0, -1);
    expect(checkFixture(cov, r).some((e) => e.includes('grid mismatch'))).toBe(true);
  });
  it('fails a row below fromMs', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [{ minute_ts: from - M }, ...r[s]];
    expect(checkFixture(cov, r).some((e) => e.includes('outside window'))).toBe(true);
  });
  it('fails a row at exactly toMs (half-open upper bound)', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [...r[s], { minute_ts: to }];
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts`
Expected: FAIL — `checkFixture` / `totalGap` / `maxConsecutiveGap` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// append to scripts/verify_fixtures.ts

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

/** Declared (coverage) vs actual (rowsBySymbol). Returns [] when the fixture passes.
 *  Symbol-set equality is exact over ALL keys (an extra empty key fails), then each declared
 *  symbol is checked non-empty — so `{ X: [] }` can never slip through. */
export function checkFixture(
  coverage: CoverageDoc,
  rowsBySymbol: Record<string, ReadonlyArray<{ minute_ts: number }>> | undefined,
): string[] {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify_fixtures.ts test/scripts/verify-fixtures.test.ts
git commit -m "feat(fixtures): declared-vs-actual comparator (exact symbol set, unified grid, gap budgets)"
```

---

### Task 3: `runFixtureVerification(baseDir)` + CLI, wired into `check:ci` and CI

Directly testable (returns an exit code; no subprocess, no `npx`). JSON-parse failure prints a clean FAIL, not a stack trace.

**Files:**
- Modify: `scripts/verify_fixtures.ts`
- Modify: `package.json` (add `verify:fixtures`, append to `check:ci`)
- Modify: `.github/workflows/ci.yml`
- Test: `test/scripts/verify-fixtures.test.ts`

**Interfaces:**
- Consumes: `validateCoverageDoc`, `checkFixture`, `CoverageDoc` from Tasks 1-2; `loadSnapshot` from `../src/snapshot/loader.js`.
- Produces: `runFixtureVerification(baseDir: string): number` (0 = all enforced fixtures pass / only legacy warns; 1 = ≥1 FAIL).

- [ ] **Step 1: Write the failing test**

```ts
// append to test/scripts/verify-fixtures.test.ts
import { runFixtureVerification } from '../../scripts/verify_fixtures.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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
  it('returns 1 for a non-JSON sidecar without throwing', () => {
    const d = mkdtempSync(join(tmpdir(), 'vf-'));
    const fx = join(d, 'data/snapshots/wfo/bad2');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'coverage.json'), '{ not json');
    expect(runFixtureVerification(d)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts -t "runFixtureVerification"`
Expected: FAIL — `runFixtureVerification` not exported.

- [ ] **Step 3: Add `runFixtureVerification` + a thin `main()`**

```ts
// append to scripts/verify_fixtures.ts
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../src/snapshot/loader.js';

const SCAN_ROOTS = ['data/snapshots/fixtures', 'data/snapshots/wfo'];

function fixtureDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).map((n) => join(root, n)).filter((p) => statSync(p).isDirectory());
}

/** Scan the two fixture roots under `baseDir`. Returns a process exit code (0 ok / 1 any FAIL). */
export function runFixtureVerification(baseDir: string): number {
  let failed = 0;
  let enforced = 0;
  for (const root of SCAN_ROOTS) {
    for (const dir of fixtureDirs(join(baseDir, root))) {
      const coveragePath = join(dir, 'coverage.json');
      if (!existsSync(coveragePath)) { console.log(`WARN  ${dir} — legacy (no declared coverage)`); continue; }
      enforced++;

      let doc: unknown;
      try { doc = JSON.parse(readFileSync(coveragePath, 'utf8')); }
      catch (e) { console.error(`FAIL  ${dir}\n  - coverage.json is not valid JSON: ${(e as Error).message}`); failed++; continue; }

      const schemaErrs = validateCoverageDoc(doc);
      if (schemaErrs.length) { console.error(`FAIL  ${dir}\n${schemaErrs.map((e) => `  - ${e}`).join('\n')}`); failed++; continue; }

      let rowsBySymbol: Record<string, ReadonlyArray<{ minute_ts: number }>> | undefined;
      try { rowsBySymbol = loadSnapshot(dir).bundle.historical?.rowsBySymbol; }
      catch (e) { console.error(`FAIL  ${dir}\n  - could not load snapshot: ${(e as Error).message}`); failed++; continue; }

      const errs = checkFixture(doc as CoverageDoc, rowsBySymbol);
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
```

- [ ] **Step 4: Wire it into the gate chain**

In `package.json`, add the script next to the other `verify:*` entries and append it to `check:ci`:

```jsonc
"verify:fixtures": "tsx scripts/verify_fixtures.ts",
"check:ci": "pnpm check && pnpm verify:no-forbidden-deps && pnpm verify:no-secrets && pnpm verify:sdk-pin && pnpm verify:golden-sync && pnpm verify:fixtures",
```

In `.github/workflows/ci.yml`, add a step to the `checks` job after `verify:golden-sync`:

```yaml
      - run: pnpm verify:fixtures
```

- [ ] **Step 5: Run the tests and the gate**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts`
Expected: PASS.
Run: `pnpm verify:fixtures`
Expected: `WARN` for every existing fixture, then `verify_fixtures: OK (0 enforced, legacy warned)`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify_fixtures.ts test/scripts/verify-fixtures.test.ts package.json .github/workflows/ci.yml
git commit -m "feat(fixtures): runFixtureVerification + verify:fixtures gate wired into check:ci + CI"
```

---

### Task 4: Code-default `MOCK_SNAPSHOT_REF` → T1 (item 5)

Independent of the other tasks. `.env.example:6` already reads the T1 ref (verify; no change expected).

**Files:**
- Modify: `src/access/config.ts:34`
- Modify: `README.md` (code-default note, ~lines 154-156)
- Test: `test/access/config.test.ts` (add one `it` to the existing `describe('loadMockConfig', ...)` — imports already present)

- [ ] **Step 1: Write the failing test**

Add this `it` inside the existing `describe('loadMockConfig', ...)` block in `test/access/config.test.ts` (do **not** re-import `vitest` or `loadMockConfig` — they are already imported at the top):

```ts
  it('defaults snapshotRef to the T1 native-1m SSOT fixture, not the synthetic one', () => {
    expect(loadMockConfig({}).snapshotRef).toBe('fixtures/2026-06-22-to-2026-06-28-vps');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/access/config.test.ts -t "T1 native-1m"`
Expected: FAIL — actual is `fixtures/2026-06-16-synthetic`.

- [ ] **Step 3: Change the default**

In `src/access/config.ts:34`:

```ts
    snapshotRef: env.MOCK_SNAPSHOT_REF ?? 'fixtures/2026-06-22-to-2026-06-28-vps',
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run test/access/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the README note; verify `.env.example`**

Confirm `.env.example:6` already reads `MOCK_SNAPSHOT_REF=fixtures/2026-06-22-to-2026-06-28-vps` (no edit if so). In `README.md`, replace the now-false code-default note:

Old:
```
is unaffected. Note that the *code*-default `MOCK_SNAPSHOT_REF` (`fixtures/2026-06-16-synthetic`) is
bars-only, so starting the mock without an explicit ref now yields `minute_rows_unavailable` on
`/historical/rows` — that is the correct answer for that snapshot; set `MOCK_SNAPSHOT_REF` to a
fixture with native 1m when you need rows.
```
New:
```
is unaffected. The *code*-default `MOCK_SNAPSHOT_REF` is now the native-1m T1 fixture
`fixtures/2026-06-22-to-2026-06-28-vps` (previously the 2024-era bars-only
`fixtures/2026-06-16-synthetic`), so starting the mock without an explicit ref serves real
minute rows on `/historical/rows`.
```

- [ ] **Step 6: Run the full check and commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add src/access/config.ts README.md test/access/config.test.ts
git commit -m "fix(config): default MOCK_SNAPSHOT_REF to the T1 native-1m fixture (item 5)"
```

---

### Task 5: `make-wfo-fixture.ts` authoring tool (item 1, code)

Exports `writeWfoFixture(opts)` — tested end-to-end in a temp dir against a real gzipped source fixture — plus the pure transforms. `coverage.json` is authored **only** from `opts` (never from bundle content). The provenance hash is over the **raw pre-gzip** bundle bytes.

**Files:**
- Create: `scripts/make-wfo-fixture.ts`
- Test: `test/scripts/make-wfo-fixture.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` (`../src/snapshot/checksums.js`), `bundleRefForByteLength` / `encodeBundleFileBytes` / `decodeBundleFileBytes` (`../src/snapshot/bundle-io.js`), `loadSnapshot` (`../src/snapshot/loader.js`).
- Produces:
  - `intersectToCommonGrid<R extends { minute_ts: number }>(rowsBySymbol, symbols, fromMs, toMs): { grid: number[]; filtered: Record<string, R[]>; perSymbol: Record<string, { inWindow: number; final: number }> }`
  - `filterBarsToWindow<B extends { tsMs: number }>(bars, fromMs, toMs): Record<string, Record<string, B[]>>`
  - `writeWfoFixture(opts: { source: string; out: string; symbols: string[]; fromMs: number; toMs: number; totalGapBudgetMinutes: number; maxConsecutiveGapMinutes: number }): { bundleRef: string; gridSize: number }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/scripts/make-wfo-fixture.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intersectToCommonGrid, filterBarsToWindow, writeWfoFixture } from '../../scripts/make-wfo-fixture.js';
import { loadSnapshot } from '../../src/snapshot/loader.js';

const M = 60_000;

describe('intersectToCommonGrid', () => {
  it('keeps only minutes present in every symbol, within the window', () => {
    const rows = {
      A: [{ minute_ts: M, v: 1 }, { minute_ts: 2 * M, v: 2 }, { minute_ts: 3 * M, v: 3 }],
      B: [{ minute_ts: M, v: 9 }, { minute_ts: 3 * M, v: 8 }, { minute_ts: 99 * M, v: 7 }],
    };
    const { grid, filtered, perSymbol } = intersectToCommonGrid(rows, ['A', 'B'], M, 4 * M);
    expect(grid).toEqual([M, 3 * M]);
    expect(filtered.A.map((r) => r.minute_ts)).toEqual([M, 3 * M]);
    expect(perSymbol.A).toEqual({ inWindow: 3, final: 2 });
    expect(perSymbol.B).toEqual({ inWindow: 2, final: 2 }); // 99*M excluded from inWindow
  });
});

describe('filterBarsToWindow', () => {
  it('drops bars outside [fromMs, toMs)', () => {
    const bars = { A: { '1h': [{ tsMs: 0 }, { tsMs: M }, { tsMs: 4 * M }] } };
    expect(filterBarsToWindow(bars, M, 4 * M).A['1h'].map((b) => b.tsMs)).toEqual([M]);
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
    const res = writeWfoFixture({ source: SOURCE, out, symbols, fromMs, toMs, totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10 });

    // 1. loads through the full gate chain
    const built = loadSnapshot(out).bundle;
    expect(Object.keys(built.historical!.rowsBySymbol!).sort()).toEqual([...symbols].sort());

    // 2. coverage.json comes verbatim from the flags
    const cov = JSON.parse(readFileSync(join(out, 'coverage.json'), 'utf8'));
    expect(cov).toMatchObject({ schemaVersion: 'fixture-coverage.1', period: { fromMs, toMs }, totalGapBudgetMinutes: 10, maxConsecutiveGapMinutes: 10 });
    expect([...cov.symbols].sort()).toEqual([...symbols].sort());

    // 3. checksum entry matches the written bundle file
    const checks = JSON.parse(readFileSync(join(out, 'checksums.json'), 'utf8'));
    expect(checks[res.bundleRef]).toMatch(/^[0-9a-f]{64}$/);

    // 4. provenance splits VPS absence from probe-surplus and intersection loss
    const prov = JSON.parse(readFileSync(join(out, 'provenance.json'), 'utf8'));
    const E = (toMs - fromMs) / M;
    for (const s of symbols) {
      const p = prov.perSymbol[s];
      expect(p.finalRowsAfterIntersection).toBe(res.gridSize);
      expect(p.missingMinutesInSelectedWindow).toBe(E - p.rowsInSelectedWindowBeforeIntersection);
      expect(p.droppedOutsideSelectedWindow).toBe(p.rawRowsInProbeWindow - p.rowsInSelectedWindowBeforeIntersection);
      expect(p.droppedByIntersection).toBe(p.rowsInSelectedWindowBeforeIntersection - p.finalRowsAfterIntersection);
    }
    expect(existsSync(join(out, 'provenance.json'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/make-wfo-fixture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the transforms + `writeWfoFixture` + CLI**

```ts
// scripts/make-wfo-fixture.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { bundleRefForByteLength, encodeBundleFileBytes, decodeBundleFileBytes } from '../src/snapshot/bundle-io.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';

export function intersectToCommonGrid<R extends { minute_ts: number }>(
  rowsBySymbol: Record<string, ReadonlyArray<R>>,
  symbols: string[],
  fromMs: number,
  toMs: number,
): { grid: number[]; filtered: Record<string, R[]>; perSymbol: Record<string, { inWindow: number; final: number }> } {
  const inWindow: Record<string, Set<number>> = {};
  const perSymbol: Record<string, { inWindow: number; final: number }> = {};
  for (const s of symbols) {
    const set = new Set<number>();
    for (const r of rowsBySymbol[s] ?? []) if (r.minute_ts >= fromMs && r.minute_ts < toMs) set.add(r.minute_ts);
    inWindow[s] = set;
    perSymbol[s] = { inWindow: set.size, final: 0 };
  }
  let common: Set<number> | null = null;
  for (const s of symbols) common = common === null ? new Set(inWindow[s]) : new Set([...common].filter((t) => inWindow[s]!.has(t)));
  const gridSet = common ?? new Set<number>();
  const grid = [...gridSet].sort((a, b) => a - b);
  const filtered: Record<string, R[]> = {};
  for (const s of symbols) {
    filtered[s] = (rowsBySymbol[s] ?? []).filter((r) => gridSet.has(r.minute_ts));
    perSymbol[s].final = filtered[s].length;
  }
  return { grid, filtered, perSymbol };
}

export function filterBarsToWindow<B extends { tsMs: number }>(
  bars: Record<string, Record<string, ReadonlyArray<B>>>,
  fromMs: number,
  toMs: number,
): Record<string, Record<string, B[]>> {
  const out: Record<string, Record<string, B[]>> = {};
  for (const [sym, tfs] of Object.entries(bars)) {
    out[sym] = {};
    for (const [tf, arr] of Object.entries(tfs)) out[sym][tf] = arr.filter((b) => b.tsMs >= fromMs && b.tsMs < toMs);
  }
  return out;
}

interface SrcHistorical {
  rowsBySymbol?: Record<string, Array<{ minute_ts: number }>>;
  barsBySymbolAndTimeframe: Record<string, Record<string, Array<{ tsMs: number }>>>;
  fundingBySymbol: Record<string, unknown[]>;
  openInterestBySymbol: Record<string, unknown[]>;
  liquidationsBySymbol: Record<string, unknown[]>;
}

export interface WriteWfoOpts {
  source: string; out: string; symbols: string[];
  fromMs: number; toMs: number;
  totalGapBudgetMinutes: number; maxConsecutiveGapMinutes: number;
}

export function writeWfoFixture(opts: WriteWfoOpts): { bundleRef: string; gridSize: number } {
  const { source, out, symbols, fromMs, toMs, totalGapBudgetMinutes, maxConsecutiveGapMinutes } = opts;
  if (symbols.length !== 5) throw new Error(`expected exactly 5 symbols, got ${symbols.length}`);

  const srcManifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as { versions: Record<string, string>; bundleRef: string };
  const src = loadSnapshot(source).bundle as unknown as { historical?: SrcHistorical; [k: string]: unknown };
  const h = src.historical;
  if (!h?.rowsBySymbol) throw new Error('source has no historical.rowsBySymbol');

  const rawRows: Record<string, number> = {};
  for (const s of symbols) rawRows[s] = (h.rowsBySymbol[s] ?? []).length;

  const { grid, filtered, perSymbol } = intersectToCommonGrid(h.rowsBySymbol, symbols, fromMs, toMs);
  const pick = <V>(obj: Record<string, V>): Record<string, V> => Object.fromEntries(symbols.filter((s) => s in obj).map((s) => [s, obj[s]!]));
  const historical: SrcHistorical = {
    barsBySymbolAndTimeframe: filterBarsToWindow(pick(h.barsBySymbolAndTimeframe), fromMs, toMs),
    fundingBySymbol: pick(h.fundingBySymbol),
    openInterestBySymbol: pick(h.openInterestBySymbol),
    liquidationsBySymbol: pick(h.liquidationsBySymbol),
    rowsBySymbol: filtered,
  };
  const fixture = { ...src, historical };
  const bundleBytes = Buffer.from(JSON.stringify(fixture), 'utf8');
  const bundleRef = bundleRefForByteLength(bundleBytes.length);
  const encoded = encodeBundleFileBytes(bundleBytes, bundleRef);

  const ref = out.split('/').filter(Boolean).slice(-1)[0]!;
  const manifest: SnapshotManifest = {
    ref,
    createdAtMs: Date.now(),
    versions: { ...srcManifest.versions, exporterVersion: 'wfo-fixture.1' } as SnapshotManifest['versions'],
    bundleRef,
    checksumsRef: 'checksums.json',
  };

  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, bundleRef), encoded);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ [bundleRef]: sha256Hex(encoded) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // coverage.json — authored ONLY from opts (never from the produced bundle)
  writeFileSync(join(out, 'coverage.json'), JSON.stringify({
    schemaVersion: 'fixture-coverage.1',
    period: { fromMs, toMs },
    symbols: [...symbols].sort(),
    totalGapBudgetMinutes,
    maxConsecutiveGapMinutes,
  }, null, 2));

  // provenance.json — descriptive; hash is over the RAW pre-gzip source bundle bytes
  const rawSourceBytes = decodeBundleFileBytes(readFileSync(join(source, srcManifest.bundleRef)), srcManifest.bundleRef);
  writeFileSync(join(out, 'provenance.json'), JSON.stringify({
    note: 'rows filtered to the intersection of the 5 source series',
    rawSourceRef: source,
    rawSourceBundleSha256: sha256Hex(rawSourceBytes),
    window: { fromMs, toMs },
    commonGridSize: grid.length,
    rankingTieBreak: 'top-4 by summed 1m turnover excl. HUSDT, ties by symbol ASC',
    perSymbol: Object.fromEntries(symbols.map((s) => {
      const raw = rawRows[s]!; const inWin = perSymbol[s]!.inWindow; const fin = perSymbol[s]!.final;
      const E = (toMs - fromMs) / 60_000;
      return [s, {
        rawRowsInProbeWindow: raw,
        rowsInSelectedWindowBeforeIntersection: inWin,
        // genuine VPS absence inside the 42d window — the data-quality signal
        missingMinutesInSelectedWindow: E - inWin,
        // the probe surplus removed by windowing (expected, NOT absence)
        droppedOutsideSelectedWindow: raw - inWin,
        finalRowsAfterIntersection: fin,
        // rows dropped because another symbol lacked that minute
        droppedByIntersection: inWin - fin,
      }];
    })),
  }, null, 2));

  loadSnapshot(out); // fail loudly if the written fixture does not load
  return { bundleRef, gridSize: grid.length };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

function main(): void {
  const res = writeWfoFixture({
    source: arg('source'),
    out: arg('out'),
    symbols: arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    fromMs: Number(arg('from')),
    toMs: Number(arg('to')),
    totalGapBudgetMinutes: Number(arg('total-gap-budget')),
    maxConsecutiveGapMinutes: Number(arg('max-consecutive-gap')),
  });
  console.log(`wfo fixture written: grid ${res.gridSize} min, bundleRef ${res.bundleRef}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `pnpm vitest run test/scripts/make-wfo-fixture.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/make-wfo-fixture.ts test/scripts/make-wfo-fixture.test.ts
git commit -m "feat(fixtures): make-wfo-fixture — writeWfoFixture with sidecars from flags + raw-hash provenance"
```

---

### Task 6: Deterministic ranking + window selection (`wfo-select.ts`) + `wfo-rank` / `wfo-probe` CLIs

Testable pure functions so ranking and anchor selection are executable, not prose. Ranking is split from window selection because ranking runs on a parquet turnover map (Task 7) *before* the 5-symbol snapshot exists, while window selection runs on that snapshot.

**Files:**
- Create: `scripts/wfo-select.ts`
- Create: `scripts/wfo-rank.ts`
- Create: `scripts/wfo-probe.ts`
- Test: `test/scripts/wfo-select.test.ts`

**Interfaces:**
- Consumes: `intersectToCommonGrid` (`./make-wfo-fixture.js`), `totalGap` / `maxConsecutiveGap` (`./verify_fixtures.js`).
- Produces:
  - `rankWfoSymbols(turnoverBySymbol: Record<string, number>, primary: string, count: number): string[]`
  - `selectWfoWindow(rowsBySymbol, symbols: string[], probeFrom: number, probeTo: number, spanDays: number, totalGapBudgetMinutes: number, maxConsecutiveGapMinutes: number): { fromMs: number; toMs: number } | null`

- [ ] **Step 1: Write the failing tests**

```ts
// test/scripts/wfo-select.test.ts
import { describe, it, expect } from 'vitest';
import { rankWfoSymbols, selectWfoWindow } from '../../scripts/wfo-select.js';

const M = 60_000;
const DAY = 86_400_000;

describe('rankWfoSymbols', () => {
  it('puts primary first, then top-N by turnover desc, ties symbol ASC', () => {
    const t = { HUSDT: 1, ZUSDT: 100, AUSDT: 50, BUSDT: 50, CUSDT: 10 };
    // excl HUSDT, top-3: ZUSDT(100), then AUSDT/BUSDT tie(50)→ASC, so AUSDT, BUSDT
    expect(rankWfoSymbols(t, 'HUSDT', 3)).toEqual(['HUSDT', 'ZUSDT', 'AUSDT', 'BUSDT']);
  });
  it('includes the primary even if it has no turnover entry', () => {
    expect(rankWfoSymbols({ ZUSDT: 9, AUSDT: 8 }, 'HUSDT', 1)).toEqual(['HUSDT', 'ZUSDT']);
  });
});

describe('selectWfoWindow', () => {
  const probeFrom = 0;
  const probeTo = 3 * DAY;
  const dense = (): Record<string, { minute_ts: number }[]> => {
    const g = Array.from({ length: (probeTo - probeFrom) / M }, (_, i) => probeFrom + i * M);
    return { A: g.map((t) => ({ minute_ts: t })), B: g.map((t) => ({ minute_ts: t })) };
  };
  it('returns the freshest 1-day window that fits within budget', () => {
    expect(selectWfoWindow(dense(), ['A', 'B'], probeFrom, probeTo, 1, 0, 0)).toEqual({ fromMs: 2 * DAY, toMs: 3 * DAY });
  });
  it('returns null when no window fits the budget', () => {
    const r = dense();
    r.B = r.B.filter((_, i) => i % 10_000 === 0); // B nearly empty → intersection tiny
    expect(selectWfoWindow(r, ['A', 'B'], probeFrom, probeTo, 1, 5, 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/wfo-select.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `wfo-select.ts`, `wfo-rank.ts`, `wfo-probe.ts`**

```ts
// scripts/wfo-select.ts
import { intersectToCommonGrid } from './make-wfo-fixture.js';
import { totalGap, maxConsecutiveGap } from './verify_fixtures.js';

const DAY_MS = 86_400_000;

/** primary first, then the top `count` other symbols by turnover desc, ties by symbol ASC. */
export function rankWfoSymbols(turnoverBySymbol: Record<string, number>, primary: string, count: number): string[] {
  const others = Object.keys(turnoverBySymbol)
    .filter((s) => s !== primary)
    .sort((a, b) => (turnoverBySymbol[b]! - turnoverBySymbol[a]!) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, count);
  return [primary, ...others];
}

/** Slide a `spanDays` half-open window's anchor from the freshest day boundary backwards;
 *  return the first window whose intersected grid meets both budgets, or null. */
export function selectWfoWindow(
  rowsBySymbol: Record<string, ReadonlyArray<{ minute_ts: number }>>,
  symbols: string[],
  probeFrom: number,
  probeTo: number,
  spanDays: number,
  totalGapBudgetMinutes: number,
  maxConsecutiveGapMinutes: number,
): { fromMs: number; toMs: number } | null {
  const span = spanDays * DAY_MS;
  for (let toMs = probeTo; toMs - span >= probeFrom; toMs -= DAY_MS) {
    const fromMs = toMs - span;
    const { grid } = intersectToCommonGrid(rowsBySymbol, symbols, fromMs, toMs);
    if (totalGap(grid, fromMs, toMs) <= totalGapBudgetMinutes && maxConsecutiveGap(grid, fromMs, toMs) <= maxConsecutiveGapMinutes) {
      return { fromMs, toMs };
    }
  }
  return null;
}
```

```ts
// scripts/wfo-rank.ts — reads a {SYMBOL: turnover} JSON map (from tools/fetch-snapshot/wfo-turnover.ts)
// and prints the ranked 5 symbols, or exits non-zero (blocker) if it cannot produce enough.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rankWfoSymbols } from './wfo-select.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

function main(): void {
  const turnover = JSON.parse(readFileSync(arg('turnover'), 'utf8')) as Record<string, number>;
  const primary = arg('primary').toUpperCase();
  const count = Number(arg('count'));
  const symbols = rankWfoSymbols(turnover, primary, count);
  if (symbols.length !== count + 1) { console.error(`BLOCKER: ranked ${symbols.length} symbols, need ${count + 1}`); process.exit(2); }
  console.log(symbols.join(','));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

```ts
// scripts/wfo-probe.ts — reads the LOCAL 5-symbol raw snapshot (no VPS), prints the chosen
// 42-day window, or exits non-zero (blocker) when no window fits the frozen budgets.
import { pathToFileURL } from 'node:url';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { selectWfoWindow } from './wfo-select.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

function main(): void {
  const source = arg('source');
  const symbols = arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const probeFrom = Number(arg('probe-from'));
  const probeTo = Number(arg('probe-to'));
  const spanDays = Number(arg('span-days'));
  const totalGapBudget = Number(arg('total-gap-budget'));
  const maxConsecutiveGapM = Number(arg('max-consecutive-gap'));

  const rows = (loadSnapshot(source).bundle as unknown as {
    historical?: { rowsBySymbol?: Record<string, Array<{ minute_ts: number }>> };
  }).historical?.rowsBySymbol;
  if (!rows) { console.error('BLOCKER: source has no historical.rowsBySymbol'); process.exit(2); }

  const win = selectWfoWindow(rows, symbols, probeFrom, probeTo, spanDays, totalGapBudget, maxConsecutiveGapM);
  if (!win) { console.error('BLOCKER: no contiguous 42-day window fits the frozen budgets — do not tune budgets, do not substitute synthetic data'); process.exit(2); }

  console.log(`from=${win.fromMs}`);
  console.log(`to=${win.toMs}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `pnpm vitest run test/scripts/wfo-select.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/wfo-select.ts scripts/wfo-rank.ts scripts/wfo-probe.ts test/scripts/wfo-select.test.ts
git commit -m "feat(fixtures): wfo-select (rank/window) + wfo-rank + wfo-probe CLIs"
```

---

### Task 7: Parquet ranking/build tools (one visit), then fetch → produce → validate → commit T2

The pull is **one read-only VPS visit** (ops + rsync of all parquet); ranking and the 5-symbol raw snapshot are then built **locally** from the cached parquet, so no 50-day all-symbol JSON bundle is ever materialised. The two parquet tools live under `tools/fetch-snapshot/` (its own isolated deps: `hyparquet`); they reuse the existing reader and never import from `src/contract`. The rest is a runbook — **stop and report a blocker** at any ⛔.

**Files:**
- Modify: `tools/fetch-snapshot/fetch-snapshot.ts` (export `readParquetDir`)
- Create: `tools/fetch-snapshot/wfo-turnover.ts`
- Create: `tools/fetch-snapshot/wfo-build-raw.ts`
- Modify: `.gitignore` (add `data/snapshots/_raw/`)
- Create (generated): `data/snapshots/wfo/<from>-to-<to>-vps-wfo42d/`
- Test: `test/snapshot/wfo-nested-ref.test.ts`

**Prerequisites:** `.env.rollout.local` with VPS credentials + parquet root (see `control-center/docs/operations/rollout-secrets.md`). If absent → ⛔ blocker.

- [ ] **Step 1: Export `readParquetDir` and add the two parquet tools**

In `tools/fetch-snapshot/fetch-snapshot.ts`, change `async function readParquetDir(` to `export async function readParquetDir(` (no other change).

```ts
// tools/fetch-snapshot/wfo-turnover.ts
// Local, read-only column aggregate over cached parquet: turnover = Σ close·volume per symbol,
// within [from, to). Reads only symbol/close/volume columns. Prints a JSON {SYMBOL: turnover} map.
import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

async function main(): Promise<void> {
  const localRoot = arg('parquet-local');
  const tsFrom = Number(arg('from'));
  const tsTo = Number(arg('to'));

  const { parquetReadObjects } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const { asyncBufferFromFile } = (await import('hyparquet/src/node.js')) as {
    asyncBufferFromFile: (p: string) => Promise<{ byteLength: number; slice(s: number, e?: number): ArrayBuffer | Promise<ArrayBuffer> }>;
  };

  const turnover: Record<string, number> = {};
  for (const sv of [1, 2] as const) {
    const svDir = join(localRoot, `schema_version=${sv}`);
    if (!existsSync(svDir)) continue;
    for (const entry of readdirSync(svDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('date=')) continue;
      const partDir = join(svDir, entry.name);
      for (const f of await readdir(partDir)) {
        if (!f.startsWith('part-') || !f.endsWith('.parquet')) continue;
        const file = await asyncBufferFromFile(join(partDir, f));
        const rows = (await parquetReadObjects({ file, columns: ['minute_ts', 'symbol', 'close', 'volume'], compressors })) as Record<string, unknown>[];
        for (const r of rows) {
          const ts = Number(r['minute_ts']);
          if (ts < tsFrom || ts >= tsTo) continue;
          const sym = String(r['symbol']).trim().toUpperCase();
          turnover[sym] = (turnover[sym] ?? 0) + Number(r['close']) * Number(r['volume']);
        }
      }
    }
  }
  process.stdout.write(JSON.stringify(turnover));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
```

```ts
// tools/fetch-snapshot/wfo-build-raw.ts
// Build a 5-symbol raw snapshot LOCALLY from cached parquet (no VPS): full historical for the 5
// symbols over the probe window, merged with the ops from the primary-only probe bundle. Reuses
// the SAME writer primitives the mock loader expects (checksums + gzip).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../../src/snapshot/checksums.js';
import { bundleRefForByteLength, encodeBundleFileBytes, decodeBundleFileBytes } from '../../src/snapshot/bundle-io.js';
import type { SnapshotManifest } from '../../src/contract/snapshot/manifest.js';
import { readParquetDir } from './fetch-snapshot.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

async function main(): Promise<void> {
  const probe = arg('probe');              // _raw/wfo-probe (ops + primary historical)
  const out = arg('out');                  // _raw/wfo (5-symbol raw)
  const parquetLocal = arg('parquet-local');
  const symbols = arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const tsFrom = Number(arg('from'));      // probeFrom
  const tsTo = Number(arg('to'));          // probeTo

  const probeManifest = JSON.parse(readFileSync(join(probe, 'manifest.json'), 'utf8')) as { versions: Record<string, string>; bundleRef: string };
  const base = JSON.parse(decodeBundleFileBytes(readFileSync(join(probe, probeManifest.bundleRef)), probeManifest.bundleRef).toString('utf8')) as Record<string, unknown>;

  const historical = await readParquetDir(parquetLocal, symbols, tsFrom, tsTo); // 5-symbol HistoricalBundle
  const bundle = { ...base, historical };
  const bytes = Buffer.from(JSON.stringify(bundle), 'utf8');
  const bundleRef = bundleRefForByteLength(bytes.length);
  const encoded = encodeBundleFileBytes(bytes, bundleRef);

  const ref = out.split('/').filter(Boolean).slice(-1)[0]!;
  const manifest: SnapshotManifest = { ref, createdAtMs: Date.now(), versions: { ...probeManifest.versions } as SnapshotManifest['versions'], bundleRef, checksumsRef: 'checksums.json' };
  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, bundleRef), encoded);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ [bundleRef]: sha256Hex(encoded) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`raw 5-symbol snapshot written to ${out} (${symbols.join(', ')})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
```

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add tools/fetch-snapshot/fetch-snapshot.ts tools/fetch-snapshot/wfo-turnover.ts tools/fetch-snapshot/wfo-build-raw.ts
git commit -m "feat(fetch-snapshot): export readParquetDir; add wfo-turnover + wfo-build-raw parquet tools"
```

- [ ] **Step 2: Gitignore the raw pull, commit it first**

Add the line `data/snapshots/_raw/` to `.gitignore` **with your editor** (not `echo >>`, which can corrupt a no-trailing-newline file), then:

```bash
git add .gitignore
git commit -m "chore: gitignore data/snapshots/_raw (transient VPS pulls)"
```

- [ ] **Step 3: Fix the probe window (UTC)**

Compute `probeTo = start_of(latest_complete_UTC_day + 1)` (ms) and `probeFrom = probeTo − 50·86_400_000`. Record both integers — every later step reuses them.

- [ ] **Step 4: One read-only VPS visit (ops + rsync of all parquet)**

`fetch-snapshot`'s `rsync` downloads **all** symbols' parquet for the dates regardless of `--symbols`, so a primary-only run caches everything while materialising only a tiny bundle. `--to` is **inclusive of the whole day**, so pass `probeTo − 1 day` to cover `[probeFrom, probeTo)`. `--parquet-root` is **required** or historical is null. Note the local parquet cache path (`--parquet-local`, default `/tmp/mock-parquet`).

```bash
pnpm fetch:snapshot -- \
  --db-url "$ROLLOUT_DB_URL" --vps "$ROLLOUT_VPS" \
  --parquet-root "$ROLLOUT_PARQUET_ROOT" --parquet-local /tmp/mock-parquet \
  --from <probeFrom UTC date YYYY-MM-DD> \
  --to   <(probeTo − 1 day) UTC date YYYY-MM-DD> \
  --symbols HUSDT \
  --ref  _raw/wfo-probe --mode replace
```

If rsync brings no parquet or ops fails → ⛔ blocker.

- [ ] **Step 5: Rank (local parquet aggregate) → 5 symbols**

```bash
pnpm tsx tools/fetch-snapshot/wfo-turnover.ts -- \
  --parquet-local /tmp/mock-parquet --from <probeFrom ms> --to <probeTo ms> > /tmp/wfo-turnover.json

SYMBOLS=$(pnpm -s tsx scripts/wfo-rank.ts -- --turnover /tmp/wfo-turnover.json --primary HUSDT --count 4)
echo "$SYMBOLS"   # e.g. HUSDT,AUSDT,BUSDT,CUSDT,DUSDT
```

A non-zero exit / empty turnover map → ⛔ blocker (no proxy fallback).

- [ ] **Step 6: Build the 5-symbol raw snapshot locally (no second visit)**

```bash
pnpm tsx tools/fetch-snapshot/wfo-build-raw.ts -- \
  --probe data/snapshots/_raw/wfo-probe --out data/snapshots/_raw/wfo \
  --parquet-local /tmp/mock-parquet --symbols "$SYMBOLS" \
  --from <probeFrom ms> --to <probeTo ms>
```

- [ ] **Step 7: Select the 42-day window (offline, tested code)**

```bash
pnpm tsx scripts/wfo-probe.ts -- \
  --source data/snapshots/_raw/wfo --symbols "$SYMBOLS" \
  --probe-from <probeFrom ms> --probe-to <probeTo ms> \
  --span-days 42 --total-gap-budget 6480 --max-consecutive-gap 1440
```

Prints `from=<ms>` / `to=<ms>`. Non-zero exit = ⛔ blocker (no window fits the frozen budgets). Do **not** tune budgets or substitute synthetic data.

- [ ] **Step 8: Produce the aligned committed fixture**

```bash
pnpm tsx scripts/make-wfo-fixture.ts -- \
  --source data/snapshots/_raw/wfo \
  --out    data/snapshots/wfo/<from-date>-to-<to-date>-vps-wfo42d \
  --symbols "$SYMBOLS" --from <from ms> --to <to ms> \
  --total-gap-budget 6480 --max-consecutive-gap 1440
```

- [ ] **Step 9: Validate in enforce mode — green before committing**

Run: `pnpm verify:fixtures`
Expected: `OK    data/snapshots/wfo/<ref>` and `verify_fixtures: OK (1 enforced, legacy warned)`.
Run: `pnpm check:ci`
Expected: exit 0.

If `verify:fixtures` FAILs, do **not** commit — `provenance.json` tells you whether the shortfall is genuine VPS absence (`missingMinutesInSelectedWindow`) or grid alignment (`droppedByIntersection`), as distinct from the expected probe surplus (`droppedOutsideSelectedWindow`).

- [ ] **Step 10: Write and run the nested-ref smoke test**

```ts
// test/snapshot/wfo-nested-ref.test.ts
import { describe, it, expect } from 'vitest';
import { openSnapshot } from '../../src/snapshot/registry.js';

const REF = 'wfo/<from-date>-to-<to-date>-vps-wfo42d'; // the committed ref

describe('nested wfo ref', () => {
  it('openSnapshot resolves and loads the T2 fixture at a nested ref', () => {
    const snap = openSnapshot('data/snapshots', REF);
    const rows = snap.bundle.historical?.rowsBySymbol ?? {};
    expect(Object.keys(rows).sort()).toHaveLength(5);
    expect(rows.HUSDT!.length).toBeGreaterThan(0);
  });
});
```

Run: `pnpm vitest run test/snapshot/wfo-nested-ref.test.ts`
Expected: PASS.

- [ ] **Step 11: Docker inverse gate — real byte sizes, isolation-safe worktree**

```bash
# unique baseline worktree; trap removes ONLY the one we created (parallel-session safe)
BASE_WT="$(mktemp -d)/mp-base"
trap 'git worktree remove --force "$BASE_WT" 2>/dev/null || true' EXIT
git worktree add "$BASE_WT" origin/main
docker build -q -t trading-mock-platform:base "$BASE_WT"
docker build -q -t trading-mock-platform:wfo .

BASE=$(docker image inspect -f '{{.Size}}' trading-mock-platform:base)
WFO=$(docker image inspect -f '{{.Size}}' trading-mock-platform:wfo)
echo "delta bytes: $((WFO - BASE))"

# 1. the wfo tree is absent from the image
docker run --rm --entrypoint sh trading-mock-platform:wfo -c 'test ! -e data/snapshots/wfo && echo WFO-ABSENT'
# 2/3. no T2-sized growth: delta well under the ~20 MB payload (allow 5 MB of build noise)
test "$((WFO - BASE))" -lt 5000000 && echo SIZE-OK
```

Expected: `WFO-ABSENT` and `SIZE-OK`. Either failing means the Dockerfile COPY scope changed → investigate (do not commit).

- [ ] **Step 12: Commit the fixture and the smoke test**

```bash
git add data/snapshots/wfo test/snapshot/wfo-nested-ref.test.ts
git commit -m "feat(fixtures): commit the 42-day native-1m T2 WFO fixture + nested-ref smoke"
```

---

## Self-review notes

- **Spec coverage:** item 3 → Tasks 1-3; item 5 → Task 4; item 1 → Tasks 5-7. Sidecar (Task 1); anti-tautology — authored from flags in Task 5, validator never writes (Tasks 2-3); unified grid + exact symbol set + gap semantics (Task 2); two scan roots + warn/enforce + JSON-parse guard (Task 3); bars filtered to window (Task 5); provenance attrition split (VPS absence vs probe surplus vs intersection) + tie-break + raw-pre-gzip hash (Task 5); deterministic ranking + window selection as tested code (Task 6); one read-only visit + local parquet aggregate + local 5-symbol build, `--parquet-root` + inclusive-`--to` (Task 7); image inverse gate with real byte delta + isolation-safe worktree + nested-ref smoke (Task 7); `_raw` gitignored (editor, committed first) (Task 7); stop conditions (Task 7 ⛔). All present.
- **Delivery order:** Tasks 1-3 (validator) precede Task 7 (fixture), so T2 is admitted through an existing gate. Task 4 is independent. Tasks 5-6 are pure code, buildable/reviewable without VPS; only Task 7 needs credentials.
- **Execution split:** Tasks 1-6 are TDD, no credentials needed. Task 7 is inline with credentials and stop-conditions.
