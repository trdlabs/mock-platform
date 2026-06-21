# Real-data demo fixture (top-5 symbols) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a committed, real-data demo fixture (`fixtures/2026-06-12-real-top5`: 73 real trades across the 5 most-traded symbols, full per-minute historical) so the demo is convincing without the private VPS or an SSH key, and wire it as the demo default.

**Architecture:** A reproducible authoring tool (`scripts/make-fixture.ts`, pure Node + the existing loader, no `pg`/`hyparquet`) subsets the gitignored on-disk `2026-06-12-vps` snapshot down to the top-N symbols by trade count, regenerates manifest + checksums, and self-validates through the real `loadSnapshot` (schema + checksum + secret-scan). The committed output replaces the synthetic fixture as the demo-compose default; the synthetic fixture stays for tests.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `tsx`, Vitest, AJV (via the existing snapshot validator), the trading-mock-platform snapshot contract.

**Repos touched:** `trading-mock-platform` (tool + fixture + test), `trading-lab` (demo-compose default + backtest-symbol alignment).

**Branches:** `trading-mock-platform` is already on `feat/real-data-demo-fixture`. In `trading-lab`, create `feat/real-data-demo-fixture` before Task 4.

---

## File Structure

| File | Repo | Responsibility |
|---|---|---|
| `scripts/make-fixture.ts` | mock-platform | Subsetting tool: select top-N symbols, filter bundle, write + self-validate fixture. Exports two pure functions for testing. |
| `test/scripts/make-fixture.test.ts` | mock-platform | Unit tests for the pure transform (selection + filtering rules). |
| `data/snapshots/fixtures/2026-06-12-real-top5/{manifest.json,checksums.json,ops/bundle.json}` | mock-platform | The committed fixture (generated artifact, ~8–9 MB). |
| `test/snapshot/real-fixture.test.ts` | mock-platform | Guards the committed fixture: loads + validates + asserts real-data shape. |
| `package.json` | mock-platform | Add `make:fixture` convenience script. |
| `docker-compose.demo.yml` | trading-lab | Switch `MOCK_SNAPSHOT_REF` default to the real fixture. |
| `README.md`, `docs/docker-demo.md` | trading-lab | Document the real fixture + its symbols. |
| `src/composition.ts`, `src/adapters/platform/mock-bot-results.adapter.ts`, `src/adapters/platform/mock-research-platform.adapter.ts` | trading-lab | Align demo backtest/market symbol+window to a fixture symbol. |

**Reference facts (verified against the codebase):**

- `SnapshotBundle` keys (`src/contract/snapshot/bundle.ts`): `runs`, `tradesByRun`, `eventsByRun`, `decisionsByRun`, `runtimeHealth`, `marketHealth`, `executionHealth`, `coverage`, `analysisByRun`, `researchByRun`, `replay`, and optional `historical` (`{barsBySymbolAndTimeframe, fundingBySymbol, openInterestBySymbol, liquidationsBySymbol}`).
- `runtimeHealth`/`marketHealth`/`executionHealth`/`coverage`/`replay` are **global** status objects, NOT per-symbol — copied unchanged.
- `tradesByRun` is keyed by run id; each `ClosedTrade` carries a `symbol` string (verified in the source data). `ClosedTrade` is the vendored-SDK type (A3 seam), so the tool operates **structurally** on parsed JSON, not via the SDK type.
- `SnapshotManifest` (`src/contract/snapshot/manifest.ts`): exact keys `ref`, `createdAtMs`, `versions`, `bundleRef`, `checksumsRef`; `versions` has exactly 7 keys.
- `loadSnapshot(dir)` (`src/snapshot/loader.ts`) runs `scanForSecrets` + `assertValidManifest`/`assertValidBundle` (AJV, `additionalProperties:false`) + `verifyChecksum`. `sha256Hex`/`verifyChecksum` in `src/snapshot/checksums.ts`. `scanText`/`scanForSecrets` in `src/safety/secret-scan.ts`.
- Source on disk: `data/snapshots/2026-06-12-vps/ops/bundle.json` (gitignored). Top-5 by trade count: ESPORTSUSDT (25), HUSDT (21), SIRENUSDT (12), BEATUSDT (10), COAIUSDT (5) = 73 trades.

---

## Task 1: Subsetting tool with tested pure transforms

**Files:**
- Create: `scripts/make-fixture.ts`
- Test: `test/scripts/make-fixture.test.ts`
- Modify: `package.json` (add `make:fixture` script)

- [ ] **Step 1: Write the failing unit test**

Create `test/scripts/make-fixture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectTopSymbols, filterBundleToSymbols } from '../../scripts/make-fixture.js';

const sample = {
  runs: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
  tradesByRun: {
    r1: [{ symbol: 'A' }, { symbol: 'A' }, { symbol: 'A' }, { symbol: 'B' }],
    r2: [{ symbol: 'B' }, { symbol: 'B' }, { symbol: 'C' }],
    r3: [{ symbol: 'D' }],
  },
  eventsByRun: { r1: [], r2: [], r3: [] },
  decisionsByRun: { r1: [{}], r2: [{}], r3: [{}] },
  analysisByRun: { r1: {}, r2: {}, r3: {} },
  researchByRun: { r1: {}, r2: {}, r3: {} },
  runtimeHealth: { entries: [], asOf: 1 },
  marketHealth: { status: 'ok' },
  executionHealth: { status: 'ok' },
  coverage: { entries: [], availability: 'available', asOf: 1 },
  replay: { frames: [] },
  historical: {
    barsBySymbolAndTimeframe: { A: { '1h': [] }, B: { '1h': [] }, C: { '1h': [] }, D: { '1h': [] } },
    fundingBySymbol: { A: [], B: [], C: [], D: [] },
    openInterestBySymbol: { A: [], B: [], C: [], D: [] },
    liquidationsBySymbol: { A: [], B: [], C: [], D: [] },
  },
} as const;

describe('selectTopSymbols', () => {
  it('ranks by trade count, tie-broken by symbol name asc', () => {
    // A=3, B=3, C=1, D=1 → top2 = [A, B] (A,B tie at 3 → alpha)
    expect(selectTopSymbols(structuredClone(sample), 2)).toEqual(['A', 'B']);
  });
});

describe('filterBundleToSymbols', () => {
  const out = filterBundleToSymbols(structuredClone(sample), ['A', 'B']);
  it('keeps only trades for the chosen symbols', () => {
    expect(out.tradesByRun.r1.map((t) => t.symbol)).toEqual(['A', 'A', 'A', 'B']);
    expect(out.tradesByRun.r2.map((t) => t.symbol)).toEqual(['B', 'B']); // C dropped
  });
  it('drops runs that retain no trades', () => {
    expect(Object.keys(out.tradesByRun).sort()).toEqual(['r1', 'r2']); // r3 (D only) gone
    expect(out.runs.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
  it('drops run-keyed data for dropped runs', () => {
    expect(Object.keys(out.decisionsByRun).sort()).toEqual(['r1', 'r2']);
  });
  it('filters historical maps to the chosen symbols', () => {
    expect(Object.keys(out.historical!.fundingBySymbol).sort()).toEqual(['A', 'B']);
    expect(Object.keys(out.historical!.barsBySymbolAndTimeframe).sort()).toEqual(['A', 'B']);
  });
  it('copies global health/coverage/replay unchanged', () => {
    expect(out.coverage).toEqual(sample.coverage);
    expect(out.replay).toEqual(sample.replay);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/scripts/make-fixture.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/make-fixture.js'` (file not created yet).

- [ ] **Step 3: Write the tool**

Create `scripts/make-fixture.ts`:

```ts
/**
 * make-fixture — derive a small, committable demo fixture from a large on-disk
 * VPS snapshot by keeping only the top-N symbols by trade count.
 *
 * Authoring-side tool (like fetch-snapshot): it reads a gitignored local snapshot
 * that consumers do not have; the committed OUTPUT is what the demo serves.
 *
 * Usage:
 *   NODE_OPTIONS=--max-old-space-size=4096 pnpm make:fixture -- \
 *     --source data/snapshots/2026-06-12-vps \
 *     --out    data/snapshots/fixtures/2026-06-12-real-top5 \
 *     --top    5
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { scanText } from '../src/safety/secret-scan.js';

interface RawHistorical {
  barsBySymbolAndTimeframe: Record<string, Record<string, unknown[]>>;
  fundingBySymbol: Record<string, unknown[]>;
  openInterestBySymbol: Record<string, unknown[]>;
  liquidationsBySymbol: Record<string, unknown[]>;
}
interface RawBundle {
  runs: Array<{ id?: string; runId?: string }>;
  tradesByRun: Record<string, Array<{ symbol: string }>>;
  eventsByRun: Record<string, unknown[]>;
  decisionsByRun: Record<string, unknown[]>;
  analysisByRun: Record<string, unknown>;
  researchByRun: Record<string, unknown>;
  runtimeHealth: unknown;
  marketHealth: unknown;
  executionHealth: unknown;
  coverage: unknown;
  replay: unknown;
  historical?: RawHistorical;
  [k: string]: unknown;
}

export function selectTopSymbols(bundle: RawBundle, n: number): string[] {
  const counts = new Map<string, number>();
  for (const trades of Object.values(bundle.tradesByRun)) {
    for (const t of trades) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([sym]) => sym);
}

const runIdOf = (r: { id?: string; runId?: string }): string => r.id ?? r.runId ?? '';
const pickKeys = <T>(obj: Record<string, T>, keep: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k)));
const pickSyms = <T>(obj: Record<string, T>, syms: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => syms.has(k)));

export function filterBundleToSymbols(bundle: RawBundle, symbols: string[]): RawBundle {
  const syms = new Set(symbols);
  const tradesByRun: Record<string, Array<{ symbol: string }>> = {};
  for (const [rid, trades] of Object.entries(bundle.tradesByRun)) {
    const kept = trades.filter((t) => syms.has(t.symbol));
    if (kept.length > 0) tradesByRun[rid] = kept;
  }
  const retained = new Set(Object.keys(tradesByRun));
  const h = bundle.historical;
  const historical: RawHistorical | undefined = h && {
    barsBySymbolAndTimeframe: pickSyms(h.barsBySymbolAndTimeframe, syms),
    fundingBySymbol: pickSyms(h.fundingBySymbol, syms),
    openInterestBySymbol: pickSyms(h.openInterestBySymbol, syms),
    liquidationsBySymbol: pickSyms(h.liquidationsBySymbol, syms),
  };
  return {
    ...bundle,
    runs: bundle.runs.filter((r) => retained.has(runIdOf(r))),
    tradesByRun,
    eventsByRun: pickKeys(bundle.eventsByRun, retained),
    decisionsByRun: pickKeys(bundle.decisionsByRun, retained),
    analysisByRun: pickKeys(bundle.analysisByRun, retained),
    researchByRun: pickKeys(bundle.researchByRun, retained),
    ...(historical ? { historical } : {}),
  };
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function main(): void {
  const source = arg('source');
  const out = arg('out');
  const topN = Number(arg('top', '5'));

  const srcManifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as {
    versions: Record<string, string>;
  };
  const srcBundle = JSON.parse(readFileSync(join(source, 'ops', 'bundle.json'), 'utf8')) as RawBundle;

  const symbols = selectTopSymbols(srcBundle, topN);
  const fixture = filterBundleToSymbols(srcBundle, symbols);
  const bundleStr = JSON.stringify(fixture);

  // Defense-in-depth: refuse to write if the secret scanner finds anything.
  const hits = scanText(bundleStr);
  if (hits.length > 0) {
    throw new Error(`secret-scan tripped on fixture bundle: ${hits.join(', ')} — narrow symbols or redact source`);
  }

  const ref = out.split('/').filter(Boolean).slice(-1)[0] as string;
  const manifest = {
    ref,
    createdAtMs: Date.now(),
    versions: { ...srcManifest.versions, exporterVersion: 'fixture-trim.1' },
    bundleRef: 'ops/bundle.json',
    checksumsRef: 'checksums.json',
  };

  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, 'ops', 'bundle.json'), bundleStr);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Self-validate through the real loader (schema + checksum + secret-scan).
  loadSnapshot(out);

  const tradeCount = Object.values(fixture.tradesByRun).reduce((s, a) => s + a.length, 0);
  console.log(
    `fixture '${ref}' written: ${symbols.length} symbols [${symbols.join(', ')}], ${tradeCount} trades, ${fixture.runs.length} run(s)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Add the convenience script**

In `package.json` `scripts`, add after `"fetch:snapshot": ...`:

```json
    "make:fixture": "tsx scripts/make-fixture.ts",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/scripts/make-fixture.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck (the script joins `tsconfig` include `scripts`)**

Run: `pnpm typecheck`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/make-fixture.ts test/scripts/make-fixture.test.ts package.json
git commit -m "feat: add make-fixture tool to subset a snapshot to top-N symbols"
```

---

## Task 2: Generate and commit the real fixture

**Files:**
- Create: `data/snapshots/fixtures/2026-06-12-real-top5/manifest.json`
- Create: `data/snapshots/fixtures/2026-06-12-real-top5/checksums.json`
- Create: `data/snapshots/fixtures/2026-06-12-real-top5/ops/bundle.json`

- [ ] **Step 1: Generate the fixture from the on-disk VPS snapshot**

Run:
```bash
NODE_OPTIONS=--max-old-space-size=4096 pnpm make:fixture -- \
  --source data/snapshots/2026-06-12-vps \
  --out    data/snapshots/fixtures/2026-06-12-real-top5 \
  --top    5
```
Expected stdout (symbols are deterministic):
```
fixture '2026-06-12-real-top5' written: 5 symbols [ESPORTSUSDT, HUSDT, SIRENUSDT, BEATUSDT, COAIUSDT], 73 trades, N run(s)
```
The tool self-validates via `loadSnapshot`; a clean exit means schema + checksum + secret-scan all passed.

- [ ] **Step 2: Contingency — if the run throws on the secret scan**

If Step 1 fails with `secret-scan tripped on fixture bundle: <labels>` (real decision/research free-text can contain a host path or db url), locate the offending records:
```bash
NODE_OPTIONS=--max-old-space-size=4096 node -e '
const {scanText}=await import("./dist/...");' 2>/dev/null || true
node --max-old-space-size=4096 -e '
const b=require("./data/snapshots/2026-06-12-vps/ops/bundle.json");
const pats=[/\/(?:home|root|etc|var|usr|opt)\//,/\b(?:postgres|postgresql|mysql|mongodb):\/\//,/-----BEGIN/];
for(const [rid,ds] of Object.entries(b.decisionsByRun||{})) for(const d of ds){const s=JSON.stringify(d); if(pats.some(p=>p.test(s))) console.log("decision",rid,s.slice(0,160));}
for(const [rid,r] of Object.entries(b.researchByRun||{})){const s=JSON.stringify(r); if(pats.some(p=>p.test(s))) console.log("research",rid,s.slice(0,160));}
'
```
Resolution (pick the smallest that clears the scan): the offending free-text lives in run-level `decisionsByRun`/`researchByRun`. Since these are kept whole for retained runs, the fix is to empty them for the demo — add `--drop-narrative` handling to the tool: in `filterBundleToSymbols`, when an env/arg flag is set, replace `decisionsByRun`/`researchByRun` retained entries with `{}` / `[]`. Re-run Step 1 with the flag. (Only do this if Step 1 actually trips; otherwise skip.)

- [ ] **Step 3: Confirm the committed size is reasonable**

Run: `du -h data/snapshots/fixtures/2026-06-12-real-top5/ops/bundle.json`
Expected: ~8–9 MB (acceptable per the design). If it is dramatically larger, stop and re-check the symbol filter.

- [ ] **Step 4: Verify the no-secrets CI guard accepts the new data**

Run: `pnpm verify:no-secrets`
Expected: `no-secrets OK (N data file(s) scanned)` with N increased by the new files; exit 0.

- [ ] **Step 5: Commit the generated fixture**

```bash
git add data/snapshots/fixtures/2026-06-12-real-top5
git commit -m "feat: add real-data demo fixture (2026-06-12-real-top5, top-5 symbols)"
```

---

## Task 3: Fixture guard test

**Files:**
- Create: `test/snapshot/real-fixture.test.ts`

- [ ] **Step 1: Write the test**

Create `test/snapshot/real-fixture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSnapshot } from '../../src/snapshot/loader.js';

const FIXTURE = join(process.cwd(), 'data/snapshots/fixtures/2026-06-12-real-top5');

describe('real-data demo fixture (2026-06-12-real-top5)', () => {
  const snap = loadSnapshot(FIXTURE); // throws on schema / checksum / secret-scan failure

  it('loads with the expected manifest ref', () => {
    expect(snap.manifest.ref).toBe('2026-06-12-real-top5');
  });

  it('carries exactly the 5 top-traded symbols in historical', () => {
    const h = snap.bundle.historical;
    expect(h).toBeDefined();
    expect(Object.keys(h!.barsBySymbolAndTimeframe).sort()).toEqual(
      ['BEATUSDT', 'COAIUSDT', 'ESPORTSUSDT', 'HUSDT', 'SIRENUSDT'],
    );
    expect(Object.keys(h!.fundingBySymbol).sort()).toEqual(
      ['BEATUSDT', 'COAIUSDT', 'ESPORTSUSDT', 'HUSDT', 'SIRENUSDT'],
    );
  });

  it('retains all 73 real trades for those symbols', () => {
    const trades = Object.values(snap.bundle.tradesByRun).reduce((s, a) => s + a.length, 0);
    expect(trades).toBe(73);
  });

  it('every historical symbol has at least one trade (coherent demo)', () => {
    const traded = new Set<string>();
    for (const arr of Object.values(snap.bundle.tradesByRun)) for (const t of arr) traded.add((t as { symbol: string }).symbol);
    for (const sym of Object.keys(snap.bundle.historical!.barsBySymbolAndTimeframe)) {
      expect(traded.has(sym)).toBe(true);
    }
  });
});
```

> **Note for the implementer:** if Task 2 Step 1 stdout reported a different 5th symbol (a 5-trade tie resolving alphabetically to something other than COAIUSDT) or a different trade total, update the literal symbol list and the `73` to match the actual generated output. The selection is deterministic, so this is a one-time alignment.

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run test/snapshot/real-fixture.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add test/snapshot/real-fixture.test.ts
git commit -m "test: guard the real-data demo fixture shape"
```

---

## Task 4: Full mock-platform gate, then switch the demo default (trading-lab)

**Files:**
- Modify: `trading-lab/docker-compose.demo.yml:20`
- Modify: `trading-lab/README.md` (demo section), `trading-lab/docs/docker-demo.md`

- [ ] **Step 1: Run the full mock-platform CI gate**

Run: `pnpm check:ci`
Expected: exit 0 — typecheck, contract-isolation, all tests (now including the two new tests), no-forbidden-deps, no-secrets, vendored-sdk all green.

- [ ] **Step 2: Branch trading-lab**

```bash
cd ../trading-lab
git checkout -b feat/real-data-demo-fixture
```

- [ ] **Step 3: Switch the demo-compose default**

In `trading-lab/docker-compose.demo.yml`, change line 20 from:
```yaml
      MOCK_SNAPSHOT_REF: "${MOCK_SNAPSHOT_REF:-fixtures/2026-06-16-synthetic}"
```
to:
```yaml
      MOCK_SNAPSHOT_REF: "${MOCK_SNAPSHOT_REF:-fixtures/2026-06-12-real-top5}"
```

- [ ] **Step 4: Update the demo docs**

In `trading-lab/README.md` demo section and `trading-lab/docs/docker-demo.md`, replace the default snapshot reference `fixtures/2026-06-16-synthetic` with `fixtures/2026-06-12-real-top5`, and add a one-line note: "Демо по умолчанию использует реальный срез из 5 символов (ESPORTSUSDT, HUSDT, SIRENUSDT, BEATUSDT, COAIUSDT), 73 сделки." Leave any reference to `fixtures/2026-06-16-synthetic` that documents the synthetic option intact (it still exists).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.demo.yml README.md docs/docker-demo.md
git commit -m "feat(demo): default the unified stack to the real-data fixture"
```

---

## Task 5: Align the lab demo backtest symbol + window to the fixture

The demo's backtest target currently hardcodes `BTCUSDT` / a 2023 period, which the fixture does not contain — the backtester would answer `unavailable`. Point it at a fixture symbol (`ESPORTSUSDT`) and the fixture window (`2026-06-12 → 2026-06-18`, `1h`).

**Files:**
- Modify: `trading-lab/src/composition.ts:235`
- Modify: `trading-lab/src/adapters/platform/mock-bot-results.adapter.ts:17`
- Modify: `trading-lab/src/adapters/platform/mock-research-platform.adapter.ts:37`

- [ ] **Step 1: Confirm which symbol the demo backtest actually requests**

Run (from `trading-lab`):
```bash
grep -rniE "symbols:\s*\[|BTCUSDT|defaultPlatformRun" src --include='*.ts' | grep -v '.worktrees' | grep -viE '\.test\.'
```
Expected: the three sites above. `src/composition.ts:235` (`defaultPlatformRun`) is the demo backtest target; the two adapters provide demo bot-results/market context. Note any additional non-test site the grep surfaces and treat it the same way.

- [ ] **Step 2: Edit `src/composition.ts:235`**

Change:
```ts
    defaultPlatformRun: { datasetId: 'default', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-12-31' }, seed: 42 },
```
to:
```ts
    defaultPlatformRun: { datasetId: 'default', symbols: ['ESPORTSUSDT'], timeframe: '1h', period: { from: '2026-06-12', to: '2026-06-18' }, seed: 42 },
```

- [ ] **Step 3: Edit the two mock adapters**

`src/adapters/platform/mock-bot-results.adapter.ts:17` and `src/adapters/platform/mock-research-platform.adapter.ts:37`: change `symbols: ['BTCUSDT'],` to `symbols: ['ESPORTSUSDT'],` in both.

- [ ] **Step 4: Run the lab test suite and fix BTCUSDT-coupled tests**

Run: `pnpm test`
Expected: green. If a non-worktree test asserts `BTCUSDT` on the demo path (not on the `.worktrees` copies, which are ignored), update that assertion to `ESPORTSUSDT`. Re-run until green. Do NOT touch tests under `.worktrees/`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/composition.ts src/adapters/platform/mock-bot-results.adapter.ts src/adapters/platform/mock-research-platform.adapter.ts
git commit -m "feat(demo): point demo backtest/market target at the real fixture symbol"
```

---

## Task 6: End-to-end verification of the unified demo

**Files:** none (verification only).

- [ ] **Step 1: mock-platform gate (re-confirm)**

Run (from `trading-mock-platform`): `pnpm check:ci`
Expected: exit 0.

- [ ] **Step 2: trading-lab gate**

Run (from `trading-lab`): `pnpm check`
Expected: exit 0 (typecheck + tests).

- [ ] **Step 3: Demo smoke (best-effort, requires Docker)**

If Docker is available, bring up the unified demo and confirm the real data flows. Run (from `trading-lab`):
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build -d
# wait for healthchecks, then:
make e2e MODE=demo
docker compose -f docker-compose.yml -f docker-compose.demo.yml down
```
Expected: the e2e cycle (`strategy.onboard → research.run_cycle.completed`) completes, the backtest resolves against `ESPORTSUSDT` historical data (not `unavailable`), and office shows the 73 real trades. If Docker is unavailable, record that this step was skipped and rely on Steps 1–2.

- [ ] **Step 4: Report**

Summarize: fixture size, symbols, trade count, both repo gates' results, and whether the Docker e2e ran or was skipped. State any test assertions changed in Task 5.

---

## Self-Review

- **Spec coverage:** source = on-disk `2026-06-12-vps` (Task 2) ✓; tool `scripts/make-fixture.ts`, no pg/hyparquet (Task 1) ✓; filter rules incl. global-vs-symbol distinction (Task 1 test + tool) ✓; output dir + manifest/checksums + full-resolution historical, variant B (Task 2) ✓; validation via loadSnapshot + verify:no-secrets (Tasks 2,4) ✓; demo default switch (Task 4) ✓; integration risk / symbol alignment (Task 5) ✓; testing (Tasks 1,3) ✓; out-of-scope items respected (no fetch-snapshot change, synthetic fixture kept) ✓.
- **Placeholder scan:** all code steps contain full code; the only conditional ("contingency" / "drop-narrative", and the Docker step) are explicitly gated on a runtime outcome with concrete commands — not deferred work.
- **Type consistency:** `selectTopSymbols`/`filterBundleToSymbols`/`runIdOf`/`pickKeys`/`pickSyms` names match between the tool and the unit test; `RawBundle`/`RawHistorical` field names match `SnapshotBundle`/`HistoricalBundle`; manifest keys match `SnapshotManifest`; the fixture ref string `2026-06-12-real-top5` is identical across Tasks 2/3/4.
