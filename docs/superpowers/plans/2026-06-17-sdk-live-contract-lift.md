# SDK Live Bot-Results Contract Lift (A2.5 → A3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@trading-platform/sdk` the source of truth for the live bot-results contract primitives, and switch the mock from declaring those types to importing them from the SDK via a vendored tarball — with machine-guaranteed equivalence and isolation.

**Architecture:** The SDK gains a new types-only subpath `@trading-platform/sdk/ops-read` whose DTOs are hand-authored (036 precedent) and proven equal to `trading-platform/src/operations/dto.ts` by a `tsc --noEmit` mutual-assignability conformance fixture. The mock vendors the packed SDK as a `file:` tarball and re-exports the SDK types through a single isolated seam file (`src/contract/ops-read/dto.sdk.ts`); a three-file split keeps the future health/coverage lift explicit, and a sub-directory-scoped isolation guard guarantees no other contract file (notably `research-read/dto.ts`) picks up the SDK.

**Tech Stack:** TypeScript (NodeNext ESM), `tsc --noEmit` type-level conformance, Node `.mjs`/`tsx` verify scripts, vitest, pnpm `file:` vendoring, npm pack.

**Repos & paths (cross-repo, strictly sequential):**
- Platform: `/home/alexxxnikolskiy/projects/trading-platform` (branch to create: `004-sdk-ops-read-surface`).
- Mock: `/home/alexxxnikolskiy/projects/trading-mock-platform` (branch already created: `004-sdk-live-contract-lift`).
- Order: **Task 1 (platform SDK) → Tasks 2–6 (mock)**. The mock cannot pack/vendor until the SDK surface exists and builds.

**Resolved facts (from planning research — do not re-derive):**
- `OPS_READ_CONTRACT_VERSION = 'ops.3'` on BOTH sides — identical, no fixture realignment.
- SDK package version `0.3.0` → tarball `trading-platform-sdk-0.3.0.tgz`.
- The 11 lifted types: `BotMode`, `BotRunStatus`, `TradeSide`, `OpsSeverity`, `BotRunStrategyRef`, `BotRunRecord`, `ClosedTrade`, `ClosedTradesAggregate`, `RunSummary`, `OperationalEvent`, `DecisionLogEntry`.
- Conformance precedent: `packages/sdk/conformance/paper-candidate.conformance.ts` + `tsconfig.036.json`, run by `verify_036_type_conformance.mjs`.
- Mock `tsconfig.json` includes `src`, `test`, `scripts` → `pnpm typecheck` checks all three; `verbatimModuleSyntax: true`.

---

## Task 1: SDK ops-read surface + conformance fixture (platform)

**Repo:** `/home/alexxxnikolskiy/projects/trading-platform`

**Files:**
- Create: `packages/sdk/src/ops-read/dto.ts`
- Create: `packages/sdk/src/ops-read/version.ts`
- Create: `packages/sdk/src/ops-read/index.ts`
- Modify: `packages/sdk/package.json` (add `"./ops-read"` to `exports`)
- Create: `packages/sdk/conformance/ops-read-dto.conformance.ts`
- Create: `packages/sdk/conformance/tsconfig.ops-read.json`
- Create: `scripts/verify_033_sdk_ops_read_conformance.mjs`
- Modify: root `package.json` (append the new verify to the `gates:033` aggregate)

- [ ] **Step 1: Create the platform feature branch**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform
git checkout main && git pull --ff-only
git checkout -b 004-sdk-ops-read-surface
```

- [ ] **Step 2: Write the conformance fixture (the failing test) + its tsconfig**

Create `packages/sdk/conformance/ops-read-dto.conformance.ts`:

```typescript
// Type-level conformance fixture (ops-read live bot-results surface).
// Asserts the SDK's own-declared ops-read DTOs are bidirectionally assignable to the platform's
// ops-read wire types (src/operations/dto.ts). Compiled with `tsc --noEmit` by
// verify_033_sdk_ops_read_conformance.mjs.
//
// This file is NOT part of the published SDK (it lives outside packages/sdk/src), so importing the
// platform module here does not leak internals into the public surface.

import type * as Sdk from '../src/ops-read/index.js';
import type * as PlatOps from '../../../dist/src/operations/dto.js';

// Non-distributive mutual-assignability check (tuple-wrap avoids union distribution).
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// closed unions
type _BotMode = Assert<Mutual<Sdk.BotMode, PlatOps.BotMode>>;
type _BotRunStatus = Assert<Mutual<Sdk.BotRunStatus, PlatOps.BotRunStatus>>;
type _TradeSide = Assert<Mutual<Sdk.TradeSide, PlatOps.TradeSide>>;
type _OpsSeverity = Assert<Mutual<Sdk.OpsSeverity, PlatOps.OpsSeverity>>;

// records
type _BotRunStrategyRef = Assert<Mutual<Sdk.BotRunStrategyRef, PlatOps.BotRunStrategyRef>>;
type _BotRunRecord = Assert<Mutual<Sdk.BotRunRecord, PlatOps.BotRunRecord>>;
type _ClosedTrade = Assert<Mutual<Sdk.ClosedTrade, PlatOps.ClosedTrade>>;
type _ClosedTradesAggregate = Assert<Mutual<Sdk.ClosedTradesAggregate, PlatOps.ClosedTradesAggregate>>;
type _RunSummary = Assert<Mutual<Sdk.RunSummary, PlatOps.RunSummary>>;
type _OperationalEvent = Assert<Mutual<Sdk.OperationalEvent, PlatOps.OperationalEvent>>;
type _DecisionLogEntry = Assert<Mutual<Sdk.DecisionLogEntry, PlatOps.DecisionLogEntry>>;

// Reference every alias so tsc must evaluate them.
export type ConformanceChecks = [
  _BotMode, _BotRunStatus, _TradeSide, _OpsSeverity,
  _BotRunStrategyRef, _BotRunRecord, _ClosedTrade, _ClosedTradesAggregate,
  _RunSummary, _OperationalEvent, _DecisionLogEntry,
];
```

Create `packages/sdk/conformance/tsconfig.ops-read.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["ops-read-dto.conformance.ts"]
}
```

- [ ] **Step 3: Build the platform, then run the fixture to verify it FAILS**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform
npm run build
node node_modules/typescript/bin/tsc -p packages/sdk/conformance/tsconfig.ops-read.json
```

Expected: FAIL — `error TS2307: Cannot find module '../src/ops-read/index.js'` (the SDK surface does not exist yet).

- [ ] **Step 4: Hand-author the SDK ops-read DTO module**

Create `packages/sdk/src/ops-read/dto.ts`:

```typescript
// @trading-platform/sdk/ops-read — live bot-results wire types (types-only, own-declared).
//
// Source of truth for these shapes is trading-platform/src/operations/dto.ts (feature "ops-read 033").
// They are declared here verbatim (primitive / closed-union only — zero platform imports) and proven
// bidirectionally assignable to the platform DTOs by conformance/ops-read-dto.conformance.ts. Do NOT
// edit a field here without the conformance gate going green against operations/dto.ts.

export type BotMode = 'live' | 'paper' | 'backtest';
export type BotRunStatus = 'running' | 'finished' | 'crashed' | 'aborted';
export type TradeSide = 'long' | 'short';
export type OpsSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface BotRunStrategyRef {
  readonly name: string;
  readonly version: string;
}

export interface BotRunRecord {
  readonly runId: string;
  readonly mode: BotMode;
  readonly status: BotRunStatus;
  readonly strategy: BotRunStrategyRef;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly lastSeenMs: number;
  readonly symbols: readonly string[];
}

export interface ClosedTrade {
  readonly tradeId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly realizedPnl: string;
  readonly pnlPct: string;
  readonly isWin: boolean | null;
  readonly closeReason: string | null;
}

export interface ClosedTradesAggregate {
  readonly closedTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  readonly winratePct: number;
  readonly pnlUsd: string;
  readonly avgPnl: string;
  readonly exitReasons: Record<string, number>;
}

export interface RunSummary extends ClosedTradesAggregate {
  readonly runId: string;
  readonly excludesReconcile: boolean;
  readonly asOf: number;
}

export interface OperationalEvent {
  readonly category: string;
  readonly severity: OpsSeverity | null;
  readonly runId: string;
  readonly tradeId: string | null;
  readonly tsMs: number;
  readonly safeMessage: string;
}

export interface DecisionLogEntry {
  readonly category: string;
  readonly runId: string;
  readonly botId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly reason: string;
  readonly tsMs: number;
  readonly safeMessage: string;
}
```

Create `packages/sdk/src/ops-read/version.ts`:

```typescript
// Ops Read contract version — own axis, INDEPENDENT of research CONTRACT_VERSION (017.x).
// Mirrors trading-platform/src/operations/version.ts. Bumping this is policed by the platform's
// ops zero-bump gates; this SDK copy must equal the platform value (asserted indirectly via the
// downstream mock's exact-match compat gate).
export const OPS_READ_CONTRACT_VERSION = 'ops.3' as const;
export type OpsReadContractVersion = typeof OPS_READ_CONTRACT_VERSION;
```

Create `packages/sdk/src/ops-read/index.ts`:

```typescript
// @trading-platform/sdk/ops-read — Ops Read live bot-results contract surface (types-only + version).
export type * from './dto.js';
export { OPS_READ_CONTRACT_VERSION } from './version.js';
export type { OpsReadContractVersion } from './version.js';
```

- [ ] **Step 5: Add the `./ops-read` export to the SDK package.json**

In `packages/sdk/package.json`, inside `exports`, add this entry immediately after the `"./agent/mcp-transport"` block (keep the trailing comma valid):

```json
    "./ops-read": {
      "types": "./dist/ops-read/index.d.ts",
      "import": "./dist/ops-read/index.js"
    },
```

- [ ] **Step 6: Rebuild and run the fixture to verify it PASSES**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform
npm run build:sdk
node node_modules/typescript/bin/tsc -p packages/sdk/conformance/tsconfig.ops-read.json
```

Expected: exit 0, no output (the SDK ops-read DTOs are mutually assignable to `operations/dto.ts`). If any `Assert<...>` fails, tsc prints `Type 'false' does not satisfy the constraint 'true'` for the offending pair — fix the SDK dto.ts field to match `operations/dto.ts` exactly.

- [ ] **Step 7: Create the conformance verify script**

Create `scripts/verify_033_sdk_ops_read_conformance.mjs`:

```javascript
// Runs the ops-read SDK ⇄ operations/dto.ts type-conformance fixture (tsc --noEmit).
// Mirrors verify_036_type_conformance.mjs. Requires the platform to be built first
// (the fixture imports dist/src/operations/dto.js) — the check:0XX chain runs `npm run build` before gates.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const project = join(REPO_ROOT, 'packages', 'sdk', 'conformance', 'tsconfig.ops-read.json');

let failures = 0;
function check(label, ok) {
  if (ok) { console.log(`  ok   ${label}`); } else { console.error(`  FAIL ${label}`); failures++; }
}

check('conformance project present', existsSync(project));
try {
  execFileSync('node', [tsc, '-p', project], { stdio: 'pipe' });
  check('SDK ops-read DTOs conform to platform operations DTOs (tsc --noEmit clean)', true);
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  console.error(`conformance type-check FAILED — tsc diagnostics:\n${out}`);
  failures++;
}

if (failures) { console.error(`verify_033_sdk_ops_read_conformance: ${failures} failure(s)`); process.exit(1); }
console.log('verify_033_sdk_ops_read_conformance OK');
```

- [ ] **Step 8: Wire the verify script into the `gates:033` aggregate**

In root `package.json`, the `gates:033` script ends with `... && node scripts/verify_033_audit_logging.mjs && node scripts/verify_033_subscription_readonly_recovery.mjs && node scripts/verify_allowlist.mjs`. Insert the new check immediately before `verify_allowlist.mjs`:

```
... && node scripts/verify_033_subscription_readonly_recovery.mjs && node scripts/verify_033_sdk_ops_read_conformance.mjs && node scripts/verify_allowlist.mjs
```

> **Plan-review note:** `gates:033` runs in CI via the `check:0XX` chain, which executes `npm run build` (and `build:sdk`) first — so `dist/src/operations/dto.js` exists when the fixture compiles, exactly like the 036 conformance in `gates:036`. If the platform team prefers a dedicated feature-gate number over appending to `gates:033`, this is a one-line rename — flag at review.

- [ ] **Step 9: Run the new gate, then the full ops gate, to verify green**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform
npm run build && node scripts/verify_033_sdk_ops_read_conformance.mjs
npm run gates:033
```

Expected: `verify_033_sdk_ops_read_conformance OK`, and `gates:033` exits 0. (`gates:033` assumes a prior `npm run build`; we just ran it.)

- [ ] **Step 10: Sanity-check that nothing else regressed (zero-bump + capability gates)**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform
npm run gen:sdk-snapshot:check
node scripts/verify_032_capability_absence.mjs && node scripts/verify_034_capability_absence.mjs
node scripts/verify_032_zero_bump.mjs && node scripts/verify_033_zero_bump.mjs
```

Expected: all exit 0 — `gen_sdk_snapshot` reports no drift (we never touched it); `live`/`rawStorage` stay `false`; research `017.2` and ops `ops.3` versions unchanged.

- [ ] **Step 11: Commit (platform)**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform
git add packages/sdk/src/ops-read/ packages/sdk/package.json \
  packages/sdk/conformance/ops-read-dto.conformance.ts packages/sdk/conformance/tsconfig.ops-read.json \
  scripts/verify_033_sdk_ops_read_conformance.mjs package.json
git commit -m "feat(sdk): @trading-platform/sdk/ops-read live bot-results surface + conformance gate

New types-only subpath mirroring operations/dto.ts (036 own-declared precedent), proven
bidirectionally assignable via conformance/ops-read-dto.conformance.ts (gates:033). Backtest
CONTRACT_VERSION 017.2 and SDK live/rawStorage:false untouched; gen_sdk_snapshot not touched."
```

---

## Task 2: Vendor the SDK tarball + relax the forbidden-deps guard (mock)

**Repo:** `/home/alexxxnikolskiy/projects/trading-mock-platform` (branch `004-sdk-live-contract-lift`)

**Files:**
- Create: `vendor/trading-platform-sdk-0.3.0.tgz` (packed artifact)
- Modify: `package.json` (add the vendored dependency)
- Modify: `scripts/verify_no_forbidden_deps.mjs`
- Modify: `Dockerfile` (copy `vendor/` before `pnpm install` in both stages)

- [ ] **Step 1: Pack the built SDK into the mock's vendor/ directory**

```bash
cd /home/alexxxnikolskiy/projects/trading-platform && npm run build:sdk
mkdir -p /home/alexxxnikolskiy/projects/trading-mock-platform/vendor
cd /home/alexxxnikolskiy/projects/trading-platform/packages/sdk
npm pack --pack-destination /home/alexxxnikolskiy/projects/trading-mock-platform/vendor/
ls /home/alexxxnikolskiy/projects/trading-mock-platform/vendor/
```

Expected: `trading-platform-sdk-0.3.0.tgz` present in the mock's `vendor/`.

- [ ] **Step 2: Add the vendored dependency to the mock package.json**

In `/home/alexxxnikolskiy/projects/trading-mock-platform/package.json`, add to `dependencies` (alphabetical, before `ajv`):

```json
    "@trading-platform/sdk": "file:./vendor/trading-platform-sdk-0.3.0.tgz",
```

Then install:

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm install
```

- [ ] **Step 3: Run the forbidden-deps guard to verify it FAILS (3 violations)**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
node scripts/verify_no_forbidden_deps.mjs
```

Expected: FAIL — three violations: (a) `runtime dependency '@trading-platform/sdk' is not in the allowlist`; (b) `dependency '@trading-platform/sdk' uses a non-registry specifier 'file:./vendor/...'`; (c) `forbidden package '@trading-platform' present in pnpm-lock.yaml`.

- [ ] **Step 4: Relax the guard — admit EXACTLY @trading-platform/sdk-via-vendored-tgz**

Replace the full contents of `scripts/verify_no_forbidden_deps.mjs` with:

```javascript
import { readFileSync } from 'node:fs';

// Clarification #1: allowlist is checked against DIRECT dependencies only; denylist scans the whole lockfile.
// A3 (feature 004): @trading-platform/sdk is admitted as a vendored standalone tarball ONLY.
const RUNTIME_ALLOWLIST = new Set(['hono', '@hono/node-server', '@hono/node-ws', 'ajv', '@modelcontextprotocol/sdk', '@trading-platform/sdk']);
// bare denylist tokens — the private platform runtime, db, and exchange SDKs.
// NOTE: '@trading-platform' is intentionally NOT a bare token: the @trading-platform scope is policed
// separately below so the standalone @trading-platform/sdk can be admitted while everything else under
// the scope (e.g. a private @trading-platform/platform) stays denied.
const DENYLIST = [
  'trading-platform',
  'pg', 'ccxt',
  'binance-api-node', 'node-binance-api', 'bybit-api', 'okx-api',
];
const NON_REGISTRY = /^(?:file:|link:|git\+|git:|github:|workspace:)/;
// The single permitted non-registry specifier: the vendored SDK tarball.
const VENDORED_SDK_NAME = '@trading-platform/sdk';
const VENDORED_SDK_SPEC = /^file:\.\/vendor\/trading-platform-sdk-\d+\.\d+\.\d+\.tgz$/;

const violations = [];

let pkg;
try { pkg = JSON.parse(readFileSync('package.json', 'utf8')); }
catch { console.error('forbidden-deps: cannot read package.json'); process.exit(1); }

const deps = pkg.dependencies ?? {};
const devDeps = pkg.devDependencies ?? {};

// (a) runtime allowlist — DIRECT dependencies only
for (const name of Object.keys(deps)) {
  if (!RUNTIME_ALLOWLIST.has(name)) {
    violations.push(`runtime dependency '${name}' is not in the allowlist {${[...RUNTIME_ALLOWLIST].join(', ')}}`);
  }
}

// (c) non-registry specifiers — across direct deps + devDeps; the vendored SDK tarball is the sole exception
for (const [name, spec] of [...Object.entries(deps), ...Object.entries(devDeps)]) {
  if (typeof spec !== 'string' || !NON_REGISTRY.test(spec)) continue;
  if (name === VENDORED_SDK_NAME && VENDORED_SDK_SPEC.test(spec)) continue; // allowed: vendored SDK tgz
  violations.push(`dependency '${name}' uses a non-registry specifier '${spec}'`);
}

// (b) denylist anywhere in the lockfile (covers direct + transitive)
let lock = '';
try { lock = readFileSync('pnpm-lock.yaml', 'utf8'); }
catch { violations.push('pnpm-lock.yaml not found'); }
for (const bad of DENYLIST) {
  const esc = bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a package name token in a pnpm lockfile is bounded by start/indent/quote/paren and followed by @ / : ' "
  const re = new RegExp(`(?:^|[\\s/'"(])${esc}(?:[@/:'"\\s])`, 'm');
  if (re.test(lock)) {
    violations.push(`forbidden package '${bad}' present in pnpm-lock.yaml`);
  }
}
// @trading-platform scope: deny every @trading-platform/* EXCEPT the standalone @trading-platform/sdk.
const TP_SCOPE_RE = /(?:^|[\s/'"(])@trading-platform\/([a-z0-9-]+)/gm;
for (const m of lock.matchAll(TP_SCOPE_RE)) {
  if (m[1] !== 'sdk') {
    violations.push(`forbidden package '@trading-platform/${m[1]}' present in pnpm-lock.yaml`);
  }
}

if (violations.length) {
  console.error(`Forbidden-dependency violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  process.exit(1);
}
console.log('forbidden-deps OK');
```

- [ ] **Step 5: Run the guard to verify it now PASSES**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
node scripts/verify_no_forbidden_deps.mjs
```

Expected: `forbidden-deps OK`.

- [ ] **Step 6: Fix the Dockerfile so the vendored tarball is present before install**

The build and runtime stages run `pnpm install` BEFORE copying sources; the `file:./vendor/...tgz` dependency requires `vendor/` to exist at install time. In `Dockerfile`, add a `COPY vendor ./vendor` line immediately after each `COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./` line (there are two — build stage and runtime stage), so each `pnpm install` sees the tarball. The build stage becomes:

```dockerfile
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
COPY vendor ./vendor
# --ignore-scripts is safe for the build stage: esbuild (a dev dep) needs no post-install
# script to be usable as a bundler; tsc (the actual build tool) does not need it at all.
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts
```

and the runtime stage becomes:

```dockerfile
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
COPY vendor ./vendor
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
```

- [ ] **Step 7: Commit (mock)**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git add vendor/trading-platform-sdk-0.3.0.tgz package.json pnpm-lock.yaml scripts/verify_no_forbidden_deps.mjs Dockerfile
git commit -m "build(004): vendor @trading-platform/sdk tgz; admit it in forbidden-deps guard (A3)

First SDK vendoring in the mock. Guard relaxed minimally: @trading-platform/sdk added to the
runtime allowlist; the @trading-platform scope is policed to deny everything except /sdk; the one
vendored ./vendor/*.tgz file: specifier is allowed. pg/ccxt/exchange + private platform stay denied.
Dockerfile copies vendor/ before pnpm install in both stages."
```

---

## Task 3: Three-file split + version rewire + sub-directory-scoped isolation guard (mock)

**Files:**
- Create: `src/contract/ops-read/dto.sdk.ts` (the single SDK seam)
- Create: `src/contract/ops-read/dto.local.ts` (health/coverage/discover/page-envelope, mock-local)
- Modify: `src/contract/ops-read/dto.ts` (becomes a barrel)
- Modify: `src/contract/ops-read/version.ts` (re-export from the seam)
- Create: `scripts/verify_contract_isolation.ts` (TS rewrite — pure predicate + sub-dir SDK rule)
- Delete: `scripts/verify_contract_isolation.mjs` (replaced by the `.ts` version)
- Modify: `package.json` (`verify:contract-isolation` script → `tsx`)
- Test: `test/contract/isolation_guard.test.ts`

> **Why convert `.mjs` → `.ts`:** the unit test (Step 7) imports the guard's `violationFor`, and `pnpm typecheck` compiles `test/`. A `.mjs` import has no declarations → tsc TS7016. The repo's `verify_no_secrets.ts` already establishes the testable `.ts` + `tsx` pattern; we follow it.

- [ ] **Step 1: Create the SDK seam file (the ONLY contract file that imports the SDK)**

Create `src/contract/ops-read/dto.sdk.ts`:

```typescript
// A3 SDK SEAM — the ONLY file in src/contract/** permitted to import @trading-platform/sdk
// (machine-enforced by scripts/verify_contract_isolation.mjs). Live bot-results primitives are
// the SDK's contract (feature 004); this file re-exports them verbatim. research-read/dto.ts and
// every other contract file MUST stay dependency-free.
export type {
  BotMode, BotRunStatus, TradeSide, OpsSeverity, BotRunStrategyRef,
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  OperationalEvent, DecisionLogEntry,
} from '@trading-platform/sdk/ops-read';
export { OPS_READ_CONTRACT_VERSION } from '@trading-platform/sdk/ops-read';
export type { OpsReadContractVersion } from '@trading-platform/sdk/ops-read';
```

- [ ] **Step 2: Create the mock-local file (health/coverage/discover/page-envelope)**

Create `src/contract/ops-read/dto.local.ts` (moved verbatim from the current `dto.ts`; bot-results types now come from the seam via a relative import):

```typescript
import type {
  PageEnvelope,
  SourceAvailability,
  OpsResourceAvailability,
} from '../common/envelopes.js';
import type { OpsCapabilities } from '../common/capabilities.js';
import type { BotRunRecord, ClosedTrade, OperationalEvent, DecisionLogEntry } from './dto.sdk.js';

// --- health + coverage ---
export type OpsHealthStatus = 'ok' | 'degraded' | 'down';
export interface RuntimeHealthIndicators {
  readonly ready: boolean;
  readonly freshnessOk: boolean;
  readonly pipelineOk: boolean;
  readonly serviceOk: boolean;
  readonly botOk: boolean;
}
export interface RuntimeHealthEntry {
  readonly source: string;
  readonly status: OpsHealthStatus;
  readonly indicators: RuntimeHealthIndicators;
  readonly availability: SourceAvailability;
  readonly capturedAtMs: number;
}
export interface RuntimeHealthCollection {
  readonly entries: readonly RuntimeHealthEntry[];
  readonly asOf: number;
}
export interface MarketServiceHealthSnapshot {
  readonly status: OpsHealthStatus;
  readonly diagnostics: Record<string, unknown>;
  readonly streamAgeMs: number | null;
  readonly availability: SourceAvailability;
  readonly asOf: number;
}
export interface ExecutionHealthSnapshot {
  readonly status: OpsHealthStatus;
  readonly recentCounts: Record<string, number>;
  readonly lastEventMs: number | null;
  readonly availability: SourceAvailability;
  readonly asOf: number;
}
export type OpsMarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker';
export type OpsCoverageState = 'present' | 'missing' | 'stale' | 'unsupported';
export interface SourceCoverageEntry {
  readonly source: string;
  readonly kind: OpsMarketDataKind;
  readonly state: OpsCoverageState;
  readonly freshnessAgeMs: number | null;
}
export interface SourceCoverageSnapshot {
  readonly entries: readonly SourceCoverageEntry[];
  readonly availability: SourceAvailability;
  readonly asOf: number;
}

// --- discover ---
export interface OpsResourcePagination {
  readonly cursor: true;
  readonly maxPageItems: number;
  readonly maxWindowMs?: number;
}
export interface OpsResourceDescriptor {
  readonly name: string;
  readonly supportedFilters: readonly string[];
  readonly pagination: OpsResourcePagination | null;
  readonly fields: readonly string[];
  readonly availability?: OpsResourceAvailability;
}
export interface OpsCapabilityDescriptor {
  readonly opsContractVersion: string;
  readonly capabilities: OpsCapabilities;
  readonly resources: readonly OpsResourceDescriptor[];
}

// convenience aliases for handlers (bot-results types sourced from the SDK seam)
export type RunsPage = PageEnvelope<BotRunRecord>;
export type TradesPage = PageEnvelope<ClosedTrade>;
export type EventsPage = PageEnvelope<OperationalEvent>;
export type DecisionsPage = PageEnvelope<DecisionLogEntry>;
```

- [ ] **Step 3: Rewrite dto.ts as a barrel, and rewire version.ts through the seam**

Replace the full contents of `src/contract/ops-read/dto.ts` with:

```typescript
// Ops Read contract barrel. Bot-results primitives come from the SDK (dto.sdk.ts, A3 source of truth);
// health/coverage/discover/page-envelope stay mock-local (dto.local.ts) until a future lift. The import
// path '../ops-read/dto.js' is unchanged for all consumers (bundle.ts, handlers, readers).
export type * from './dto.sdk.js';
export type * from './dto.local.js';
```

Replace the full contents of `src/contract/ops-read/version.ts` with:

```typescript
// OPS_READ_CONTRACT_VERSION is owned by the SDK (A3). Re-exported through the SDK seam (dto.sdk.ts)
// so this file stays free of a direct SDK import (the seam is the only permitted SDK importer).
export { OPS_READ_CONTRACT_VERSION } from './dto.sdk.js';
export type { OpsReadContractVersion } from './dto.sdk.js';
```

- [ ] **Step 4: Typecheck (passes) and run isolation guard (FAILS — demonstrates the seam is caught)**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm typecheck
node scripts/verify_contract_isolation.mjs
```

Expected: `pnpm typecheck` exits 0 (types resolve from the vendored SDK). `verify_contract_isolation.mjs` FAILS with `src/contract/ops-read/dto.sdk.ts: non-stdlib package import '@trading-platform/sdk/ops-read' (contract layer must stay dependency-free)`.

- [ ] **Step 5: Rewrite the isolation guard as TypeScript — pure predicate + sub-directory SDK rule**

Create `scripts/verify_contract_isolation.ts`:

```typescript
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = 'src/contract';
const IMPORT_RE = /^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm;

// A3 (feature 004): @trading-platform/sdk is the ONE permitted external import in the contract layer,
// and ONLY in this single seam file. Every other contract file (notably research-read/dto.ts) MUST stay
// dependency-free — this is the machine guarantee that research-read remains extractable.
const SDK_SEAM_FILE = 'src/contract/ops-read/dto.sdk.ts';
const SDK_PKG_RE = /^@trading-platform\/sdk(?:\/.*)?$/;

/** Returns a violation string for an import `spec` seen in `file`, or null if the import is allowed. */
export function violationFor(file: string, spec: string): string | null {
  const norm = file.split('\\').join('/');
  if (spec.startsWith('node:')) return null;
  const isRelative = spec.startsWith('.');
  if (!isRelative) {
    if (SDK_PKG_RE.test(spec)) {
      if (norm === SDK_SEAM_FILE) return null; // the sole permitted SDK seam
      return `${file}: '@trading-platform/sdk' may be imported ONLY in ${SDK_SEAM_FILE} (A3 SDK seam) — found in a different contract file`;
    }
    return `${file}: non-stdlib package import '${spec}' (contract layer must stay dependency-free)`;
  }
  // relative imports must resolve to somewhere inside src/contract
  const depth = norm.split('/').length - 1 - ROOT.split('/').length; // dirs below ROOT
  const climbs = (spec.match(/\.\.\//g) || []).length;
  if (climbs > depth) return `${file}: relative import '${spec}' escapes ${ROOT}`;
  return null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Scan the whole contract tree and return all violations. */
export function scanViolations(root: string = ROOT): string[] {
  const out: string[] = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const v = violationFor(file, m[1] as string);
      if (v) out.push(v);
    }
  }
  return out;
}

function main(): void {
  const violations = scanViolations();
  if (violations.length) {
    console.error(`Contract isolation violations:\n${violations.join('\n')}`);
    process.exit(1);
  }
  console.log('contract isolation OK');
}

// Run main() only when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
```

Delete the old script and point the npm script at the `.ts` version:

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git rm scripts/verify_contract_isolation.mjs
```

In `package.json` `scripts`, change `verify:contract-isolation` from `node scripts/verify_contract_isolation.mjs` to:

```json
    "verify:contract-isolation": "tsx scripts/verify_contract_isolation.ts",
```

- [ ] **Step 6: Run the isolation guard to verify it now PASSES**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm verify:contract-isolation
```

Expected: `contract isolation OK` (the seam file is now permitted; everything else still constrained).

- [ ] **Step 7: Write the guard unit test (the machine guarantee for research-read)**

Create `test/contract/isolation_guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { violationFor } from '../../scripts/verify_contract_isolation.js';

describe('verify_contract_isolation: A3 SDK-seam rule', () => {
  it('allows @trading-platform/sdk ONLY in the seam file', () => {
    expect(violationFor('src/contract/ops-read/dto.sdk.ts', '@trading-platform/sdk/ops-read')).toBeNull();
  });

  it('rejects @trading-platform/sdk in research-read (it must stay extractable)', () => {
    const v = violationFor('src/contract/research-read/dto.ts', '@trading-platform/sdk/ops-read');
    expect(v).toContain('ONLY in src/contract/ops-read/dto.sdk.ts');
  });

  it('rejects @trading-platform/sdk even in a sibling ops-read file', () => {
    expect(violationFor('src/contract/ops-read/dto.local.ts', '@trading-platform/sdk')).not.toBeNull();
  });

  it('still rejects any other bare package anywhere in the contract layer', () => {
    expect(violationFor('src/contract/ops-read/dto.sdk.ts', 'lodash')).toContain('dependency-free');
  });

  it('allows node: and in-tree relative imports', () => {
    expect(violationFor('src/contract/ops-read/dto.local.ts', './dto.sdk.js')).toBeNull();
    expect(violationFor('src/contract/snapshot/bundle.ts', '../ops-read/dto.js')).toBeNull();
    expect(violationFor('src/contract/ops-read/version.ts', 'node:path')).toBeNull();
  });

  it('flags a relative import that escapes the contract root', () => {
    expect(violationFor('src/contract/ops-read/dto.ts', '../../snapshot/loader.js')).toContain('escapes');
  });
});
```

- [ ] **Step 8: Run the test + the full local check**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm test -- test/contract/isolation_guard.test.ts
pnpm check
```

Expected: the new test passes; `pnpm check` (`typecheck && verify:contract-isolation && test`) exits 0.

- [ ] **Step 9: Commit (mock)**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git add src/contract/ops-read/ scripts/verify_contract_isolation.ts package.json test/contract/isolation_guard.test.ts
# (scripts/verify_contract_isolation.mjs deletion was already staged via `git rm` in Step 5)
git commit -m "refactor(004): ops-read 3-file split; SDK seam in dto.sdk.ts; sub-dir-scoped isolation guard

dto.sdk.ts re-exports the bot-results core from @trading-platform/sdk/ops-read (the sole permitted
SDK importer in src/contract/**); dto.local.ts keeps health/coverage/discover/page-envelope; dto.ts
is a barrel (zero churn for consumers). version.ts re-exports OPS_READ_CONTRACT_VERSION through the
seam. verify_contract_isolation now machine-guarantees research-read/dto.ts stays SDK-free (unit-tested)."
```

---

## Task 4: Vendored-SDK verify step + check:ci wiring (mock)

**Files:**
- Create: `scripts/verify_vendored_sdk.ts`
- Modify: `package.json` (`verify:vendored-sdk` script + add to `check:ci`)
- Test: `test/contract/vendored_sdk.test.ts`

- [ ] **Step 1: Write the failing test for the specifier checker**

Create `test/contract/vendored_sdk.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkSpecifier } from '../../scripts/verify_vendored_sdk.js';

describe('verify_vendored_sdk: checkSpecifier', () => {
  it('accepts a vendored ./vendor/*.tgz file: specifier', () => {
    const errs = checkSpecifier({ dependencies: { '@trading-platform/sdk': 'file:./vendor/trading-platform-sdk-0.3.0.tgz' } });
    // existence of the file is environment-dependent; assert no SPECIFIER-shape error
    expect(errs.some((e) => e.includes('not a vendored'))).toBe(false);
    expect(errs.some((e) => e.includes('missing from dependencies'))).toBe(false);
  });

  it('rejects a registry or non-vendored specifier', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': '^0.3.0' } })
      .some((e) => e.includes('not a vendored'))).toBe(true);
  });

  it('rejects a missing dependency', () => {
    expect(checkSpecifier({ dependencies: {} }).some((e) => e.includes('missing from dependencies'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm test -- test/contract/vendored_sdk.test.ts
```

Expected: FAIL — `Cannot find module '../../scripts/verify_vendored_sdk.js'`.

- [ ] **Step 3: Write the verify script**

Create `scripts/verify_vendored_sdk.ts`:

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { OPS_READ_CONTRACT_VERSION } from '@trading-platform/sdk/ops-read';

// The ops-read contract version the mock's fixtures + compat gate pin. The SDK is the source of truth;
// this constant is the value we REQUIRE the vendored SDK to carry (drift = hard fail).
const EXPECTED_OPS_VERSION = 'ops.3';
const SPEC_RE = /^file:(\.\/vendor\/trading-platform-sdk-\d+\.\d+\.\d+\.tgz)$/;

interface PkgJson { dependencies?: Record<string, string> }

/** Pure: returns a list of specifier problems ([] = clean). */
export function checkSpecifier(pkg: PkgJson): string[] {
  const errs: string[] = [];
  const spec = pkg.dependencies?.['@trading-platform/sdk'];
  if (!spec) { errs.push('@trading-platform/sdk missing from dependencies'); return errs; }
  const m = SPEC_RE.exec(spec);
  if (!m) { errs.push(`@trading-platform/sdk specifier '${spec}' is not a vendored ./vendor/*.tgz file:`); return errs; }
  if (!existsSync(m[1])) errs.push(`vendored tarball ${m[1]} does not exist`);
  return errs;
}

function main(): void {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PkgJson;
  const errs = checkSpecifier(pkg);
  if (OPS_READ_CONTRACT_VERSION !== EXPECTED_OPS_VERSION) {
    errs.push(`vendored SDK OPS_READ_CONTRACT_VERSION '${OPS_READ_CONTRACT_VERSION}' != expected '${EXPECTED_OPS_VERSION}'`);
  }
  if (errs.length) {
    console.error(`vendored-sdk check failed:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`vendored-sdk OK (@trading-platform/sdk ops-read ${OPS_READ_CONTRACT_VERSION})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
```

- [ ] **Step 4: Add the npm script and wire into check:ci**

In `package.json` `scripts`, add:

```json
    "verify:vendored-sdk": "tsx scripts/verify_vendored_sdk.ts",
```

and change `check:ci` from:

```json
    "check:ci": "pnpm check && pnpm verify:no-forbidden-deps && pnpm verify:no-secrets",
```

to:

```json
    "check:ci": "pnpm check && pnpm verify:no-forbidden-deps && pnpm verify:no-secrets && pnpm verify:vendored-sdk",
```

- [ ] **Step 5: Run the test + the verify script to confirm PASS**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm test -- test/contract/vendored_sdk.test.ts
pnpm verify:vendored-sdk
```

Expected: test passes; `vendored-sdk OK (@trading-platform/sdk ops-read ops.3)`.

- [ ] **Step 6: Commit (mock)**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git add scripts/verify_vendored_sdk.ts package.json test/contract/vendored_sdk.test.ts
git commit -m "feat(004): verify:vendored-sdk — pin tgz specifier + assert embedded ops.3; wire into check:ci"
```

---

## Task 5: Barrel-equivalence compile-time guard + full green (mock)

**Files:**
- Create: `test/contract/ops_read_shape.types.ts` (compile-time only; checked by `pnpm typecheck`)

- [ ] **Step 1: Write the compile-time shape guard**

This file is NOT a vitest test (it has no `.test.ts` suffix) — it is compiled by `pnpm typecheck` (tsconfig includes `test`). It fails the build if the barrel drops a re-export or a lifted shape drifts.

Create `test/contract/ops_read_shape.types.ts`:

```typescript
// Compile-time guard (checked by `pnpm typecheck`, NOT vitest): the ops-read barrel must keep
// re-exporting the lifted bot-results types with their exact shapes. A dropped re-export or a silent
// shape drift through the SDK lift becomes a tsc error here. The SDK conformance gate already pins
// SDK ≡ operations/dto.ts; this pins the mock barrel ≡ the lifted shapes.
import type {
  BotMode, BotRunStatus, TradeSide, OpsSeverity, BotRunStrategyRef,
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  OperationalEvent, DecisionLogEntry,
} from '../../src/contract/ops-read/dto.js';

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type _BotRunRecord = Assert<Mutual<BotRunRecord, {
  readonly runId: string; readonly mode: BotMode; readonly status: BotRunStatus;
  readonly strategy: BotRunStrategyRef;
  readonly startedAtMs: number; readonly finishedAtMs: number | null;
  readonly lastSeenMs: number; readonly symbols: readonly string[];
}>>;

type _ClosedTrade = Assert<Mutual<ClosedTrade, {
  readonly tradeId: string; readonly runId: string; readonly symbol: string; readonly side: TradeSide;
  readonly openedAtMs: number; readonly closedAtMs: number | null;
  readonly realizedPnl: string; readonly pnlPct: string;
  readonly isWin: boolean | null; readonly closeReason: string | null;
}>>;

type _RunSummary = Assert<Mutual<RunSummary, ClosedTradesAggregate & {
  readonly runId: string; readonly excludesReconcile: boolean; readonly asOf: number;
}>>;

type _DecisionLogEntry = Assert<Mutual<DecisionLogEntry, {
  readonly category: string; readonly runId: string; readonly botId: string; readonly symbol: string;
  readonly side: TradeSide; readonly reason: string; readonly tsMs: number; readonly safeMessage: string;
}>>;

// Touch the remaining re-exports so a missing barrel export is a compile error.
export type _Touch = [OpsSeverity, OperationalEvent, _BotRunRecord, _ClosedTrade, _RunSummary, _DecisionLogEntry];
```

- [ ] **Step 2: Typecheck to verify the guard compiles clean**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm typecheck
```

Expected: exit 0. (If a shape drifted, tsc reports `Type 'false' does not satisfy the constraint 'true'` at the offending alias.)

- [ ] **Step 3: Run the full CI gate green**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm check:ci
```

Expected: exit 0 — `typecheck`, `verify:contract-isolation` (`contract isolation OK`), `test` (all suites incl. existing snapshot loader/compat/validate/app + the two new guard tests), `verify:no-forbidden-deps` (`forbidden-deps OK`), `verify:no-secrets` (`no-secrets OK ...`), `verify:vendored-sdk` (`vendored-sdk OK ...`).

- [ ] **Step 4: Commit (mock)**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git add test/contract/ops_read_shape.types.ts
git commit -m "test(004): compile-time barrel-equivalence guard for the lifted ops-read shapes"
```

---

## Task 6: Docs + offline-install smoke + final verification (mock)

**Files:**
- Modify: `CLAUDE.md` (record the A3 posture)
- Modify: `README.md` (note the vendored SDK)

- [ ] **Step 1: Record the A3 posture in CLAUDE.md**

In `CLAUDE.md`, under the `## What this repo is (do not drift)` section, add a bullet after the `src/contract/**` line:

```markdown
- A3 (feature 004): the live bot-results contract is OWNED by `@trading-platform/sdk` (subpath
  `/ops-read`), consumed via a vendored tarball (`vendor/*.tgz`) and re-exported through the single
  seam `src/contract/ops-read/dto.sdk.ts` (the only contract file allowed to import the SDK; enforced
  by `verify_contract_isolation`). This is NOT a private-platform-runtime import — `pg`/`ccxt`/exchange
  SDKs and the private platform package stay forbidden (`verify_no_forbidden_deps`). `research-read/dto.ts`
  stays mock-owned and SDK-free.
```

- [ ] **Step 2: Note the vendored SDK in README.md**

In `README.md`, add a short subsection (place it near the existing architecture/safety notes):

```markdown
### Vendored SDK (`@trading-platform/sdk`)

The live bot-results contract types come from `@trading-platform/sdk/ops-read`, vendored as
`vendor/trading-platform-sdk-<version>.tgz` (a `file:` dependency — no registry/auth needed, offline-installable).
To refresh it: in `trading-platform`, run `npm run build:sdk` then `npm pack` in `packages/sdk` with
`--pack-destination <mock>/vendor/`, bump the specifier in `package.json`, then `pnpm install` and run
`pnpm check:ci` (the `verify:vendored-sdk` gate asserts the specifier shape and the embedded `ops.3`).
```

- [ ] **Step 3: Offline-install smoke (the no-registry/no-auth Docker invariant)**

Confirm the vendored tarball makes install work without a registry:

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm install --offline --frozen-lockfile
```

Expected: exit 0 (the `file:` tarball resolves locally; no network needed). This mirrors the Docker build, which now copies `vendor/` before `pnpm install`.

> If a full container check is desired and Docker is available: `docker build -t trading-mock-platform .` should succeed; it exercises the `COPY vendor ./vendor` fix from Task 2.

- [ ] **Step 4: Final cross-cutting verification**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
pnpm check:ci
cd /home/alexxxnikolskiy/projects/trading-platform && npm run build && npm run gates:033
```

Expected: mock `check:ci` exits 0 (guard 002 family all green); platform `gates:033` exits 0 (SDK conformance green).

- [ ] **Step 5: Commit (mock)**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git add CLAUDE.md README.md
git commit -m "docs(004): record A3 posture (SDK owns live contract via vendored tgz; research-read stays SDK-free)"
```

---

## Self-review checklist (planner)

- **Spec coverage:** SDK surface (Task 1) ✓; own-declared + conformance mechanism (Task 1) ✓; own version axis `ops.3` (Task 1 version.ts) ✓; `live:false`/backtest untouched (Task 1 Step 10) ✓; vendored tgz + forbidden-deps relaxation (Task 2) ✓; three-file split (Task 3) ✓; mandatory sub-directory isolation + research-read guarantee (Task 3, unit-tested) ✓; SDK source-of-truth version + exact-pin verify (Task 4) ✓; barrel equivalence (Task 5) ✓; out-of-scope respected (no research-read/lab/backtest/health changes) ✓; Docker/offline invariant (Task 2 Dockerfile + Task 6 smoke) ✓.
- **Type/name consistency:** the 11 lifted type names are identical across the SDK dto.ts, the conformance fixture, the seam re-export, the barrel guard, and `operations/dto.ts`. `OPS_READ_CONTRACT_VERSION = 'ops.3'` consistent across platform, SDK, mock, and the `verify_vendored_sdk` expectation.
- **No placeholders:** every code/edit step contains full content; every run step has an exact command + expected output.
