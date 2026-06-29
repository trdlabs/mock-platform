# Synthetic Extended Historical Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a committed snapshot fixture `2026-06-16-to-18-extended` that replicates the real day `2026-06-18-real-all` backward two whole days, giving ~3 continuous days of 1m `CanonicalRowV2` rows so downstream can render a 1h term (≥28 hourly bars).

**Architecture:** A deterministic, network-free authoring script (`scripts/make-extended-fixture.ts`, modeled on `make-golden-fixture.ts`) loads the source fixture via `loadSnapshot`, triplicates every `historical` series by shifting only its timestamp field (−2d / −1d / 0d), keeps the rest of the bundle verbatim, and writes a new fixture validated by the full `loadSnapshot` gate chain. A vitest test pins the resulting invariants.

**Tech Stack:** TypeScript, `tsx` (run scripts), vitest, Node `node:fs`/`node:crypto`. No new dependencies.

## Global Constraints

- Fixture = dir with `manifest.json` + `ops/bundle.json` + `checksums.json`. Rows in `bundle.historical.rowsBySymbol[<SYMBOL>]` = `CanonicalRowV2[]`.
- `CanonicalRowV2` = exactly 19 fields, schema `additionalProperties:false`, all required. Do not add/remove fields. `turnover` kept verbatim.
- Every `minute_ts` `% 60_000 === 0`; per-symbol series strictly increasing, no dups.
- Tail must stay at `minute_ts = 1781827140000` (2026-06-18T23:59:00Z); first `= 1781568000000` (2026-06-16T00:00:00Z). `DAY_MS = 86_400_000`.
- Manifest versions from constants (`SNAPSHOT_SCHEMA_VERSION`, `OPS_READ_CONTRACT_VERSION`, `RESEARCH_READ_CONTRACT_VERSION`, `ANALYSIS_CONTRACT_VERSION`) → matches the exact-match compat gate. `exporterVersion: 'synthetic-extend.1'`, `sourcePlatformCommit: 'synthetic-extend-of:2026-06-18-real-all'`. No `Date.now()`.
- Checksum-safe write: `const s = JSON.stringify(bundle); writeFile(s); sha256Hex(s)`. Hash over the exact bundle string.
- MUST NOT modify the source fixture `2026-06-18-real-all` or any existing fixture.
- Extend all 5 historical maps (`rowsBySymbol` by `minute_ts`; `barsBySymbolAndTimeframe`, `fundingBySymbol`, `openInterestBySymbol`, `liquidationsBySymbol` by `tsMs`). Rest of bundle verbatim.

---

### Task 1: Generator script + generated fixture (test-first)

**Files:**
- Create: `scripts/make-extended-fixture.ts`
- Create (generated, committed): `data/snapshots/fixtures/2026-06-16-to-18-extended/{manifest.json,ops/bundle.json,checksums.json}`
- Test: `test/snapshot/extended-fixture.test.ts` (already written, see Step 1)

**Interfaces:**
- Consumes: `loadSnapshot(dir)` from `src/snapshot/loader.ts`; `sha256Hex` from `src/snapshot/checksums.ts`; `scanText` from `src/safety/secret-scan.ts`; version constants from `src/contract/{snapshot,ops-read,research-read,analysis}/version.ts`; types `SnapshotManifest`, `SnapshotBundle`, `CanonicalRowV2`.
- Produces: on-disk fixture dir `data/snapshots/fixtures/2026-06-16-to-18-extended` loadable by `openSnapshot('data/snapshots', 'fixtures/2026-06-16-to-18-extended')`.

- [ ] **Step 1: The failing test exists** — `test/snapshot/extended-fixture.test.ts` asserts: loadSnapshot ok; `manifest.ref === '2026-06-16-to-18-extended'`; `exporterVersion` matches `/synthetic-extend/`; same symbol set as source; each rowsBySymbol symbol ×3; every row series strictly increasing, `%60000===0`, all 19 fields; ESPORTSUSDT first=`1781568000000`, last=`1781827140000`, ≥28 hourly buckets; every symbol ≥28 hourly buckets; replicated rows = verbatim source shifted by whole days; source fixture untouched. Extend it with a check that `funding/oi/liq BySymbol` and `barsBySymbolAndTimeframe[sym][tf]` are also ×3.

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run test/snapshot/extended-fixture.test.ts`
Expected: FAIL — `loadSnapshot(FIXTURE)` throws `ENOENT` (the fixture dir does not exist yet).

- [ ] **Step 3: Write `scripts/make-extended-fixture.ts`**

```typescript
/**
 * make-extended-fixture — replicate the committed real-day fixture
 * 2026-06-18-real-all BACKWARD two whole days into a new committed fixture
 * 2026-06-16-to-18-extended, giving ~3 continuous days of 1m CanonicalRowV2 rows.
 *
 * Downstream (trading-lab commitXTermMath) resamples these 1m rows to 1h and
 * needs >= 28 hourly bars; one real day yields only ~24. Extending BACKWARD keeps
 * the series tail pinned at 2026-06-18T23:59:00Z (a downstream-pinned anchor).
 *
 * Deterministic, network-free, no Date.now(): every historical series is
 * triplicated by shifting ONLY its timestamp field (-2d / -1d / 0d); all other
 * fields are copied verbatim. This is a synthetic extension of a real day, NOT a
 * real fetch — the manifest declares exporterVersion 'synthetic-extend.1'.
 *
 * Usage:
 *   pnpm --config.verify-deps-before-run=false exec tsx scripts/make-extended-fixture.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { scanText } from '../src/safety/secret-scan.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/contract/snapshot/version.js';
import { OPS_READ_CONTRACT_VERSION } from '../src/contract/ops-read/version.js';
import { ANALYSIS_CONTRACT_VERSION } from '../src/contract/analysis/version.js';
import { RESEARCH_READ_CONTRACT_VERSION } from '../src/contract/research-read/version.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';
import type { SnapshotBundle } from '../src/contract/snapshot/bundle.js';

const SOURCE_REF = '2026-06-18-real-all';
const OUT_REF = '2026-06-16-to-18-extended';
const DAY_MS = 86_400_000;

/** Replicate `arr` back 2 whole days: [-2d, -1d, original], shifting only `tsKey`. */
function triplicate<T extends Record<string, unknown>>(arr: readonly T[], tsKey: keyof T): T[] {
  const shift = (delta: number): T[] =>
    arr.map((x) => ({ ...x, [tsKey]: (x[tsKey] as number) - delta }));
  return [...shift(2 * DAY_MS), ...shift(DAY_MS), ...arr];
}

function main(): void {
  const root = join(process.cwd(), 'data/snapshots/fixtures');
  const srcDir = join(root, SOURCE_REF);

  // Load + validate the source (also our guard that the source is intact).
  const src = loadSnapshot(srcDir);
  const srcManifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8')) as SnapshotManifest;
  const h = src.bundle.historical;
  if (!h) throw new Error(`source fixture ${SOURCE_REF} has no historical bundle`);

  // Deep clone the whole bundle verbatim, then replace the historical maps.
  const bundle = JSON.parse(JSON.stringify(src.bundle)) as SnapshotBundle;

  const rowsBySymbol = h.rowsBySymbol ?? {};
  const extRows: Record<string, ReturnType<typeof triplicate>> = {};
  for (const [sym, rows] of Object.entries(rowsBySymbol)) {
    extRows[sym] = triplicate(rows as Array<Record<string, unknown>>, 'minute_ts');
  }
  const extFunding: Record<string, unknown[]> = {};
  for (const [sym, arr] of Object.entries(h.fundingBySymbol)) {
    extFunding[sym] = triplicate(arr as Array<Record<string, unknown>>, 'tsMs');
  }
  const extOi: Record<string, unknown[]> = {};
  for (const [sym, arr] of Object.entries(h.openInterestBySymbol)) {
    extOi[sym] = triplicate(arr as Array<Record<string, unknown>>, 'tsMs');
  }
  const extLiq: Record<string, unknown[]> = {};
  for (const [sym, arr] of Object.entries(h.liquidationsBySymbol)) {
    extLiq[sym] = triplicate(arr as Array<Record<string, unknown>>, 'tsMs');
  }
  const extBars: Record<string, Record<string, unknown[]>> = {};
  for (const [sym, byTf] of Object.entries(h.barsBySymbolAndTimeframe)) {
    extBars[sym] = {};
    for (const [tf, bars] of Object.entries(byTf)) {
      extBars[sym][tf] = triplicate(bars as Array<Record<string, unknown>>, 'tsMs');
    }
  }

  bundle.historical = {
    barsBySymbolAndTimeframe: extBars,
    fundingBySymbol: extFunding,
    openInterestBySymbol: extOi,
    liquidationsBySymbol: extLiq,
    rowsBySymbol: extRows,
  } as SnapshotBundle['historical'];

  const bundleStr = JSON.stringify(bundle);

  const hits = scanText(bundleStr);
  if (hits.length > 0) throw new Error(`secret-scan tripped on extended bundle: ${hits.join(', ')}`);

  const manifest: SnapshotManifest = {
    ref: OUT_REF,
    createdAtMs: srcManifest.createdAtMs, // deterministic; the underlying data's capture time
    versions: {
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      opsReadContractVersion: OPS_READ_CONTRACT_VERSION,
      researchReadContractVersion: RESEARCH_READ_CONTRACT_VERSION,
      analysisContractVersion: ANALYSIS_CONTRACT_VERSION,
      exporterVersion: 'synthetic-extend.1',
      sourcePlatformCommit: `synthetic-extend-of:${SOURCE_REF}`,
      redactionPolicyVersion: srcManifest.versions.redactionPolicyVersion,
    },
    bundleRef: 'ops/bundle.json',
    checksumsRef: 'checksums.json',
  };

  const out = join(root, OUT_REF);
  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, 'ops', 'bundle.json'), bundleStr);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Self-validation: re-run the full loader gate chain on what we just wrote.
  loadSnapshot(out);

  const sym0 = Object.keys(extRows)[0];
  console.log(`extended fixture '${OUT_REF}' written: ${Object.keys(extRows).length} symbols, ${extRows[sym0].length} rows/${sym0} → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run the generator**

Run: `pnpm --config.verify-deps-before-run=false exec tsx scripts/make-extended-fixture.ts`
Expected: prints `extended fixture '2026-06-16-to-18-extended' written: 11 symbols, 4104 rows/<sym> …` and exits 0 (self `loadSnapshot` passed).

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm exec vitest run test/snapshot/extended-fixture.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 6: Full suite + verifiers (no regressions, source untouched)**

Run: `pnpm test && pnpm verify:no-secrets && pnpm typecheck`
Expected: all green; `git status` shows only the new script, new fixture dir, new test, and docs — `2026-06-18-real-all` unchanged.

- [ ] **Step 7: Commit**

```bash
git add scripts/make-extended-fixture.ts test/snapshot/extended-fixture.test.ts \
        data/snapshots/fixtures/2026-06-16-to-18-extended docs/superpowers
git commit -m "feat(fixture): synthetic 3-day extension 2026-06-16-to-18-extended (backward replication)"
```

---

## Self-Review

**Spec coverage:** backward replication ✓ (triplicate), all 5 maps ✓, tail pinned ✓ (original block last), verbatim trades/health ✓ (deep-clone, only historical replaced), synthetic manifest ✓ (exporterVersion), checksum-safe ✓ (s/hash/write), self-validate ✓ (loadSnapshot), no manifest coverage edit ✓ (none exists), source untouched ✓ (Step 6 git check), test invariants ✓ (Task 1 Step 1). No gaps.

**Placeholder scan:** none — full script + commands shown.

**Type consistency:** `triplicate(arr, tsKey)` used consistently; `minute_ts` for rows, `tsMs` for bars/funding/oi/liq (per DTO). Manifest fields match `SnapshotManifest` / `MANIFEST_SCHEMA`.
