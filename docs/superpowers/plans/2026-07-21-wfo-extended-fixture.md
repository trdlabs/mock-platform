# WFO Extended Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `trading-mock-platform` half of the `wfo-extended-fixture` initiative — a fixture integrity/coverage validator (item 3), a committed 42-day native-1m T2 fixture (item 1), and the code-default `MOCK_SNAPSHOT_REF` fix (item 5).

**Architecture:** Declared coverage lives in a versioned **sidecar** (`coverage.json`) read only by a new CI script `verify_fixtures.ts`; the runtime loader, `snapshot.1` schema, and `compat.ts` are untouched. The validator compares *declared* (authored from fetch intent) against *actual* (computed from the bundle) on a unified minute grid shared by all five symbols. The T2 fixture is produced by a new authoring tool, validated in enforce mode, and committed under `data/snapshots/wfo/` so the demo image is unchanged.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `ajv` (already a dep), `vitest`, `tsx`. Spec: [`docs/superpowers/specs/2026-07-21-wfo-extended-fixture-design.md`](../specs/2026-07-21-wfo-extended-fixture-design.md).

## Global Constraints

- ESM NodeNext: every relative import uses a `.js` specifier even for `.ts` sources.
- No manifest schema / loader / `compat.ts` / `snapshot.1` changes. Coverage is a sidecar.
- Declared coverage fields are **never** derived from bundle content (anti-tautology): the authoring tool takes them as required CLI flags; the validator only reads and compares, never writes.
- Frozen budgets (in the sidecar, as integers): `totalGapBudgetMinutes = 6480`, `maxConsecutiveGapMinutes = 1440`.
- `MINUTE_MS = 60_000`; all `minute_ts` and `period` bounds are minute-aligned; the window is half-open `[fromMs, toMs)`.
- T2 fixture symbols: exactly 5 = `HUSDT` + top-4 by 1m turnover (excl. HUSDT, ties `symbol ASC`).
- T2 lives at `data/snapshots/wfo/<from>-to-<to>-vps-wfo42d/`; the Dockerfile only `COPY`s `data/snapshots/fixtures`, so T2 stays out of the image.
- VPS access is read-only; no secrets printed or committed; commit the fixture only after `verify:fixtures` passes in enforce mode; on any blocker (no ranking aggregate, no conforming 42-day window) **stop and report**, never substitute synthetic data.
- Item 5's code-default points at the **T1** SSOT fixture `fixtures/2026-06-22-to-2026-06-28-vps`, **not** T2.

---

### Task 1: Coverage sidecar schema + document validation

Pure structural validation of `coverage.json` (`fixture-coverage.1`). No bundle access yet.

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
const to = M + 10 * M;          // 11 grid slots: minutes 1..10
const cov = {
  schemaVersion: 'fixture-coverage.1' as const,
  period: { fromMs: from, toMs: to },
  symbols: ['A', 'B', 'C', 'D', 'E'],
  totalGapBudgetMinutes: 2,
  maxConsecutiveGapMinutes: 1,
};
// a fully-populated grid: minutes from..to-M, all 5 symbols identical
const full = (): Record<string, { minute_ts: number }[]> => {
  const g = Array.from({ length: (to - from) / M }, (_, i) => from + i * M);
  return Object.fromEntries(cov.symbols.map((s) => [s, g.map((t) => ({ minute_ts: t }))]));
};

describe('gap math', () => {
  it('totalGap counts missing minutes', () => {
    expect(totalGap([from, from + M], from, to)).toBe(8); // 10 slots, 2 present
  });
  it('maxConsecutiveGap includes leading and trailing edges', () => {
    // present only the middle minute → leading 4, trailing 5
    expect(maxConsecutiveGap([from + 4 * M], from, to)).toBe(5);
  });
});

describe('checkFixture', () => {
  it('passes a full unified grid within budget', () => {
    expect(checkFixture(cov, full())).toEqual([]);
  });
  it('fails a symbol-set mismatch', () => {
    const r = full(); delete r.E;
    expect(checkFixture(cov, r).some((e) => e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails an empty symbol', () => {
    const r = full(); r.E = [];
    expect(checkFixture(cov, r).some((e) => e.includes('symbols mismatch'))).toBe(true);
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
    // B now shorter → symbol set still equal but grids differ
    expect(checkFixture(cov, r).some((e) => e.includes('grid mismatch') || e.includes('symbols mismatch'))).toBe(true);
  });
  it('fails a row outside the window (below fromMs)', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [{ minute_ts: from - M }, ...r[s]];
    expect(checkFixture(cov, r).some((e) => e.includes('outside window'))).toBe(true);
  });
  it('fails a row at exactly toMs (half-open upper bound)', () => {
    const r = full();
    for (const s of cov.symbols) r[s] = [...r[s], { minute_ts: to }];
    expect(checkFixture(cov, r).some((e) => e.includes('outside window'))).toBe(true);
  });
  it('total-gap boundary: == budget passes, +1 fails', () => {
    const g = Array.from({ length: (to - from) / M }, (_, i) => from + i * M);
    const keep2 = (n: number) => Object.fromEntries(cov.symbols.map((s) => [s, g.slice(0, g.length - n).map((t) => ({ minute_ts: t }))]));
    expect(checkFixture(cov, keep2(2))).toEqual([]);                               // gap == 2
    expect(checkFixture(cov, keep2(3)).some((e) => e.includes('total gap'))).toBe(true); // gap 3 > 2
  });
  it('consecutive-gap boundary: == budget passes, +1 fails', () => {
    // budget 1: a single one-minute hole passes; a two-minute hole fails
    const g = Array.from({ length: (to - from) / M }, (_, i) => from + i * M);
    const drop = (idx: number[]) => Object.fromEntries(cov.symbols.map((s) => [s, g.filter((_, i) => !idx.includes(i)).map((t) => ({ minute_ts: t }))]));
    expect(checkFixture({ ...cov, totalGapBudgetMinutes: 5 }, drop([3]))).toEqual([]);                     // one-minute hole
    expect(checkFixture({ ...cov, totalGapBudgetMinutes: 5 }, drop([3, 4])).some((e) => e.includes('consecutive'))).toBe(true); // two-minute hole
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts`
Expected: FAIL — `checkFixture` / `totalGap` / `maxConsecutiveGap` are not exported.

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
 *  Structural checks run before row data so a missing symbol is a clean FAIL, not a throw. */
export function checkFixture(
  coverage: CoverageDoc,
  rowsBySymbol: Record<string, ReadonlyArray<{ minute_ts: number }>> | undefined,
): string[] {
  const rows = rowsBySymbol ?? {};
  const { fromMs, toMs } = coverage.period;

  const actual = Object.keys(rows).filter((s) => (rows[s]?.length ?? 0) > 0).sort();
  const declared = [...coverage.symbols].sort();
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    return [`symbols mismatch: declared [${declared.join(', ')}] vs actual non-empty [${actual.join(', ')}]`];
  }

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
git commit -m "feat(fixtures): declared-vs-actual comparator with unified grid + gap budgets"
```

---

### Task 3: CLI `main()` (two scan roots, warn/enforce), wired into `check:ci` and CI

**Files:**
- Modify: `scripts/verify_fixtures.ts` (add `main()`)
- Modify: `package.json` (add `verify:fixtures`, append to `check:ci`)
- Modify: `.github/workflows/ci.yml` (add the gate to the `checks` job)
- Test: `test/scripts/verify-fixtures.test.ts` (integration: run the script)

**Interfaces:**
- Consumes: `validateCoverageDoc`, `checkFixture` from Tasks 1-2; `loadSnapshot` from `../src/snapshot/loader.js`.

- [ ] **Step 1: Write the failing integration test**

```ts
// append to test/scripts/verify-fixtures.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/verify_fixtures.ts');
const runScript = (cwd: string) => execFileSync('npx', ['tsx', SCRIPT], { cwd, encoding: 'utf8', stdio: 'pipe' });
function expectScriptFail(cwd: string, re: RegExp): void {
  let err: { stdout?: string; stderr?: string } | undefined;
  try { runScript(cwd); } catch (e) { err = e as typeof err; }
  expect(err, 'expected non-zero exit').toBeDefined();
  expect(`${err?.stdout ?? ''}${err?.stderr ?? ''}`).toMatch(re);
}

describe('verify_fixtures main()', () => {
  it('passes on the real repo (legacy fixtures warn, exit 0)', () => {
    expect(() => runScript(process.cwd())).not.toThrow();
  });
  it('fails a fixture whose sidecar is malformed', () => {
    const d = mkdtempSync(join(tmpdir(), 'vf-'));
    const fx = join(d, 'data/snapshots/wfo/bad');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'coverage.json'), JSON.stringify({ schemaVersion: 'fixture-coverage.1' }));
    // no manifest/bundle needed: schema check fails first
    expectScriptFail(d, /FAIL|schema invalid/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/verify-fixtures.test.ts -t "main"`
Expected: FAIL — the script has no `main()` yet, so `npx tsx scripts/verify_fixtures.ts` exits 0 on the real repo but the malformed-sidecar case does not fail.

- [ ] **Step 3: Add `main()` to the script**

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

function main(): void {
  let failed = 0;
  let enforced = 0;
  for (const root of SCAN_ROOTS) {
    for (const dir of fixtureDirs(root)) {
      const coveragePath = join(dir, 'coverage.json');
      if (!existsSync(coveragePath)) {
        console.log(`WARN  ${dir} — legacy (no declared coverage)`);
        continue;
      }
      enforced++;
      const doc = JSON.parse(readFileSync(coveragePath, 'utf8')) as unknown;
      const schemaErrs = validateCoverageDoc(doc);
      if (schemaErrs.length) { console.error(`FAIL  ${dir}\n${schemaErrs.map((e) => `  - ${e}`).join('\n')}`); failed++; continue; }

      let rowsBySymbol: Record<string, ReadonlyArray<{ minute_ts: number }>> | undefined;
      try {
        rowsBySymbol = loadSnapshot(dir).bundle.historical?.rowsBySymbol;
      } catch (e) {
        console.error(`FAIL  ${dir}\n  - could not load snapshot: ${(e as Error).message}`); failed++; continue;
      }
      const errs = checkFixture(doc as CoverageDoc, rowsBySymbol);
      if (errs.length) { console.error(`FAIL  ${dir}\n${errs.map((e) => `  - ${e}`).join('\n')}`); failed++; }
      else console.log(`OK    ${dir}`);
    }
  }
  if (failed) { console.error(`verify_fixtures: ${failed} fixture(s) FAILED`); process.exit(1); }
  console.log(`verify_fixtures: OK (${enforced} enforced, legacy warned)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Wire it into the gate chain**

In `package.json`, add the script (next to the other `verify:*` entries) and append it to `check:ci`:

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
Expected: prints `WARN` for every existing fixture and `verify_fixtures: OK (0 enforced, legacy warned)`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify_fixtures.ts test/scripts/verify-fixtures.test.ts package.json .github/workflows/ci.yml
git commit -m "feat(fixtures): verify:fixtures CLI, warn-legacy/enforce, wired into check:ci + CI"
```

---

### Task 4: Code-default `MOCK_SNAPSHOT_REF` → T1 (item 5)

Independent of Tasks 1-3 and 5-6. Points the hardcoded fallback and `.env.example` at the T1 SSOT fixture; does not touch `ecosystem-defaults.yaml`.

**Files:**
- Modify: `src/access/config.ts:34`
- Modify: `.env.example` (already `fixtures/2026-06-22-to-2026-06-28-vps` — verify; if so, no change)
- Modify: `README.md` (the code-default note at lines ~154-155)
- Test: `test/access/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/access/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadMockConfig } from '../../src/access/config.js';

describe('loadMockConfig code-default', () => {
  it('defaults snapshotRef to the T1 native-1m SSOT fixture, not the synthetic one', () => {
    expect(loadMockConfig({}).snapshotRef).toBe('fixtures/2026-06-22-to-2026-06-28-vps');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/access/config.test.ts -t "code-default"`
Expected: FAIL — actual is `fixtures/2026-06-16-synthetic`.

- [ ] **Step 3: Change the default**

In `src/access/config.ts:34`:

```ts
    snapshotRef: env.MOCK_SNAPSHOT_REF ?? 'fixtures/2026-06-22-to-2026-06-28-vps',
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run test/access/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the README note and verify `.env.example`**

Confirm `.env.example:6` already reads `MOCK_SNAPSHOT_REF=fixtures/2026-06-22-to-2026-06-28-vps` (no change if so). In `README.md`, replace the now-false code-default note (lines ~154-156):

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

Run: `pnpm check` (typecheck + isolation + tests)
Expected: PASS.

```bash
git add src/access/config.ts README.md test/access/config.test.ts
git commit -m "fix(config): default MOCK_SNAPSHOT_REF to the T1 native-1m fixture (item 5)"
```

---

### Task 5: `make-wfo-fixture.ts` authoring tool (item 1, code)

Pure transforms (intersection, bar filtering, provenance accounting) plus a CLI that writes the aligned bundle + `manifest.json` + `checksums.json` + `coverage.json` (from flags) + `provenance.json`. No VPS access here; tested with synthetic input.

**Files:**
- Create: `scripts/make-wfo-fixture.ts`
- Test: `test/scripts/make-wfo-fixture.test.ts`

**Interfaces:**
- Produces:
  - `intersectToCommonGrid<R extends { minute_ts: number }>(rowsBySymbol: Record<string, ReadonlyArray<R>>, symbols: string[], fromMs: number, toMs: number): { grid: number[]; filtered: Record<string, R[]>; perSymbol: Record<string, { inWindow: number; final: number }> }`
  - `filterBarsToWindow<B extends { tsMs: number }>(bars: Record<string, Record<string, ReadonlyArray<B>>>, fromMs: number, toMs: number): Record<string, Record<string, B[]>>`

- [ ] **Step 1: Write the failing test**

```ts
// test/scripts/make-wfo-fixture.test.ts
import { describe, it, expect } from 'vitest';
import { intersectToCommonGrid, filterBarsToWindow } from '../../scripts/make-wfo-fixture.js';

const M = 60_000;
describe('intersectToCommonGrid', () => {
  it('keeps only minutes present in every symbol, within the window', () => {
    const rows = {
      A: [{ minute_ts: M, v: 1 }, { minute_ts: 2 * M, v: 2 }, { minute_ts: 3 * M, v: 3 }],
      B: [{ minute_ts: M, v: 9 }, { minute_ts: 3 * M, v: 8 }, { minute_ts: 99 * M, v: 7 }],
    };
    const { grid, filtered, perSymbol } = intersectToCommonGrid(rows, ['A', 'B'], M, 4 * M);
    expect(grid).toEqual([M, 3 * M]);           // 2*M missing from B; 99*M outside window
    expect(filtered.A.map((r) => r.minute_ts)).toEqual([M, 3 * M]);
    expect(filtered.B.map((r) => r.minute_ts)).toEqual([M, 3 * M]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/make-wfo-fixture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure transforms + CLI**

```ts
// scripts/make-wfo-fixture.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { bundleRefForByteLength, encodeBundleFileBytes } from '../src/snapshot/bundle-io.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';

/** Filter each symbol's rows to the common minute grid within [fromMs, toMs). */
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
  for (const s of symbols) {
    common = common === null ? new Set(inWindow[s]) : new Set([...common].filter((t) => inWindow[s]!.has(t)));
  }
  const gridSet = common ?? new Set<number>();
  const grid = [...gridSet].sort((a, b) => a - b);
  const filtered: Record<string, R[]> = {};
  for (const s of symbols) {
    filtered[s] = (rowsBySymbol[s] ?? []).filter((r) => gridSet.has(r.minute_ts));
    perSymbol[s].final = filtered[s].length;
  }
  return { grid, filtered, perSymbol };
}

/** Keep only bars whose tsMs is inside [fromMs, toMs). */
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

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

function main(): void {
  const source = arg('source');            // raw local (uncommitted) fixture dir
  const out = arg('out');                  // e.g. data/snapshots/wfo/<ref>
  const symbols = arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const fromMs = Number(arg('from'));
  const toMs = Number(arg('to'));
  const totalGapBudgetMinutes = Number(arg('total-gap-budget'));
  const maxConsecutiveGapMinutes = Number(arg('max-consecutive-gap'));
  if (symbols.length !== 5) throw new Error(`--symbols must list exactly 5 symbols, got ${symbols.length}`);

  const srcManifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as { versions: Record<string, string>; bundleRef: string };
  const src = loadSnapshot(source).bundle as unknown as {
    historical?: { rowsBySymbol?: Record<string, Array<{ minute_ts: number }>>; barsBySymbolAndTimeframe: Record<string, Record<string, Array<{ tsMs: number }>>>; fundingBySymbol: Record<string, unknown[]>; openInterestBySymbol: Record<string, unknown[]>; liquidationsBySymbol: Record<string, unknown[]> };
    [k: string]: unknown;
  };
  const h = src.historical;
  if (!h?.rowsBySymbol) throw new Error('source has no historical.rowsBySymbol');

  const rawRows: Record<string, number> = {};
  for (const s of symbols) rawRows[s] = (h.rowsBySymbol[s] ?? []).length;

  const { grid, filtered, perSymbol } = intersectToCommonGrid(h.rowsBySymbol, symbols, fromMs, toMs);
  const pick = <V>(obj: Record<string, V>): Record<string, V> => Object.fromEntries(symbols.filter((s) => s in obj).map((s) => [s, obj[s]!]));
  const historical = {
    barsBySymbolAndTimeframe: filterBarsToWindow(pick(h.barsBySymbolAndTimeframe), fromMs, toMs),
    fundingBySymbol: pick(h.fundingBySymbol),
    openInterestBySymbol: pick(h.openInterestBySymbol),
    liquidationsBySymbol: pick(h.liquidationsBySymbol),
    rowsBySymbol: filtered,
  };
  const fixture = { ...src, historical };
  const bundleStr = JSON.stringify(fixture);
  const bundleBytes = Buffer.from(bundleStr, 'utf8');
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

  // coverage.json — authored ONLY from flags (never from the produced bundle)
  writeFileSync(join(out, 'coverage.json'), JSON.stringify({
    schemaVersion: 'fixture-coverage.1',
    period: { fromMs, toMs },
    symbols: [...symbols].sort(),
    totalGapBudgetMinutes,
    maxConsecutiveGapMinutes,
  }, null, 2));

  // provenance.json — descriptive audit; distinguishes VPS absence from trimming
  writeFileSync(join(out, 'provenance.json'), JSON.stringify({
    note: 'rows filtered to the intersection of the 5 source series',
    rawSourceRef: source,
    rawSourceBundleSha256: sha256Hex(readFileSync(join(source, srcManifest.bundleRef))),
    window: { fromMs, toMs },
    commonGridSize: grid.length,
    rankingTieBreak: 'top-4 by summed 1m turnover excl. HUSDT, ties by symbol ASC',
    perSymbol: Object.fromEntries(symbols.map((s) => [s, {
      rawRowsInProbeWindow: rawRows[s],
      rowsInSelectedWindowBeforeIntersection: perSymbol[s]!.inWindow,
      finalRowsAfterIntersection: perSymbol[s]!.final,
      droppedByWindow: rawRows[s]! - perSymbol[s]!.inWindow,
      droppedByIntersection: perSymbol[s]!.inWindow - perSymbol[s]!.final,
    }])),
  }, null, 2));

  loadSnapshot(out); // fail loudly if the written fixture does not load
  console.log(`wfo fixture '${ref}' written: 5 symbols, grid ${grid.length} min, bundleRef ${bundleRef}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/scripts/make-wfo-fixture.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/make-wfo-fixture.ts test/scripts/make-wfo-fixture.test.ts
git commit -m "feat(fixtures): make-wfo-fixture authoring tool (intersect + coverage/provenance sidecars)"
```

---

### Task 6: Fetch, produce, validate, and commit the T2 fixture (item 1, data) + smoke + Docker gate

This task runs the read-only VPS pull and commits the fixture. It is a **runbook**, not TDD — the only automated tests are the nested-ref smoke and the Docker inverse gate at the end. **Stop and report a blocker** at any ⛔ below.

**Files:**
- Create (generated): `data/snapshots/wfo/<from>-to-<to>-vps-wfo42d/` (bundle, `manifest.json`, `checksums.json`, `coverage.json`, `provenance.json`)
- Test: `test/snapshot/wfo-nested-ref.test.ts`

**Prerequisites:** `.env.rollout.local` with VPS credentials present (see `control-center/docs/operations/rollout-secrets.md`). If absent → ⛔ blocker.

- [ ] **Step 1: Fix the probe window and rank symbols (read-only)**

Compute `probeTo = start_of(latest_complete_UTC_day + 1)` and `probeFrom = probeTo − 50·86400·1000`. Using the rollout credentials, run a **read-only** aggregate of summed 1m turnover per symbol over `[probeFrom, probeTo)`. Select `HUSDT` + the top-4 by turnover **excluding HUSDT**, ties by `symbol ASC`.

If the aggregate cannot be produced → ⛔ blocker (do **not** fall back to ranking off the committed 7-day slice). Record the 5 symbols and the exact `probeFrom`/`probeTo`.

- [ ] **Step 2: Read-only raw pull of the 5 symbols**

```bash
# 50-day pull of ONLY the 5 selected symbols into a gitignored local ref (NOT committed)
pnpm fetch:snapshot -- \
  --db-url "$ROLLOUT_DB_URL" --vps "$ROLLOUT_VPS" \
  --from <probeFrom-date> --to <probeTo-date> \
  --symbols HUSDT,<S2>,<S3>,<S4>,<S5> \
  --ref _raw/wfo-probe --mode replace
# verify native 1m rows exist for all 5 (per control-center mock-platform-snapshot-rollout.md)
```

Before pulling, ensure `data/snapshots/_raw/` is in `.gitignore` (add it if missing) — it must never be committed, and it sits outside the two validator scan roots (`fixtures/*`, `wfo/*`) so it is never validated. If any of the 5 symbols has no native 1m rows → ⛔ blocker.

- [ ] **Step 3: Choose the 42-day anchor offline**

Working only from the local `_raw/wfo-probe` bundle, slide the anchor: for each candidate `toMs` (freshest complete day first), `fromMs = toMs − 42·86400·1000`; intersect the 5 symbols to the common grid within `[fromMs, toMs)`; accept the first window where **both** `totalGap ≤ 6480` and `maxConsecutiveGap ≤ 1440` hold on that grid. (A throwaway script may reuse `intersectToCommonGrid`, `totalGap`, `maxConsecutiveGap` from `scripts/make-wfo-fixture.js` / `scripts/verify_fixtures.js`.)

If no anchor passes → ⛔ blocker (do **not** tune the budgets; do **not** substitute synthetic data).

- [ ] **Step 4: Produce the aligned fixture**

```bash
pnpm tsx scripts/make-wfo-fixture.ts -- \
  --source data/snapshots/_raw/wfo-probe \
  --out    data/snapshots/wfo/<from>-to-<to>-vps-wfo42d \
  --symbols HUSDT,<S2>,<S3>,<S4>,<S5> \
  --from <fromMs> --to <toMs> \
  --total-gap-budget 6480 --max-consecutive-gap 1440
```

- [ ] **Step 5: Validate in enforce mode — must be green before committing**

Run: `pnpm verify:fixtures`
Expected: `OK    data/snapshots/wfo/<from>-to-<to>-vps-wfo42d` and `verify_fixtures: OK (1 enforced, legacy warned)`.
Run: `pnpm check:ci`
Expected: exit 0.

If `verify:fixtures` reports FAIL → do **not** commit; investigate (the `provenance.json` per-symbol attrition tells you whether the shortfall is VPS absence or trimming).

- [ ] **Step 6: Write the nested-ref smoke test**

```ts
// test/snapshot/wfo-nested-ref.test.ts
import { describe, it, expect } from 'vitest';
import { openSnapshot } from '../../src/snapshot/registry.js';

const REF = 'wfo/<from>-to-<to>-vps-wfo42d'; // replace with the committed ref

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

- [ ] **Step 7: Docker inverse gate (three assertions)**

```bash
docker build -t trading-mock-platform:wfo .
# 1. the wfo tree is absent from the image
docker run --rm --entrypoint sh trading-mock-platform:wfo -c 'test ! -e data/snapshots/wfo && echo ABSENT'
# 2/3. image size did not grow on the order of the T2 payload (~20 MB) vs origin/main
docker images trading-mock-platform:wfo --format '{{.Size}}'
```

Expected: prints `ABSENT`; image size within noise of the `origin/main` image (no ~20 MB jump). If `data/snapshots/wfo` appears in the image → the Dockerfile COPY scope changed unexpectedly → investigate.

- [ ] **Step 8: Commit the fixture and the smoke test**

```bash
git add data/snapshots/wfo test/snapshot/wfo-nested-ref.test.ts
git commit -m "feat(fixtures): commit the 42-day native-1m T2 WFO fixture + nested-ref smoke"
```

---

## Self-review notes

- **Spec coverage:** item 3 → Tasks 1-3; item 5 → Task 4; item 1 → Tasks 5-6. Sidecar (Task 1), anti-tautology (Task 5 authors from flags; validator never writes), unified grid + gap semantics (Task 2), two scan roots + warn/enforce (Task 3), bars filtered to window (Task 5), provenance attrition + tie-break + raw hash (Task 5), image inverse gate + nested-ref smoke (Task 6), stop conditions (Task 6 ⛔). All present.
- **Delivery order:** Tasks 1-3 (validator) precede Task 6 (fixture), so T2 is admitted through an existing gate. Task 4 is independent and may run any time.
