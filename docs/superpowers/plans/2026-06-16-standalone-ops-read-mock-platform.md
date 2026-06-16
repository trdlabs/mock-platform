# Standalone Ops Read Mock Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `trading-mock-platform` — a standalone, read-only, snapshot-backed service that imitates the private `trading-platform` **read** surfaces (Ops Read HTTP/WS for `trading-office`, plus a Research Read seam for `trading-lab`) closely enough that downstreams switch to it by URL/token/config, with zero npm coupling to the private platform.

**Architecture:** A2.5 — ports-and-adapters mirror of `trading-platform/src/operations`, with an **import-clean, extractable** `src/contract/**` layer. One sanitized snapshot bundle feeds two read surfaces: **Surface A = Ops Read** (HTTP GET + WS replay, Tier-1 `ops.3` parity + Tier-2 `ops.4` analysis) and **Surface B = Research Read** (contract + snapshot→DTO adapter + capability descriptor; transport deferred — seam only). The runtime reads + verifies already-sanitized snapshots; the exporter/sanitizer is operator-side and out of scope. Backtesting is NEVER implemented or faked here.

**Tech Stack:** TypeScript (ESM / NodeNext, Node 22+), Hono + `@hono/node-server` + `@hono/node-ws`, `ajv` for snapshot schema validation, `vitest` for tests, `pnpm`. No `pg`/`ccxt`/exchange/parquet deps in MVP (dependency-level safety; market-bar/parquet ingestion is a later increment).

**Source-of-truth references (read-only, in the private repo — do NOT import):**
- Tier-1 DTO shapes: `trading-platform/src/operations/dto.ts` (`ops.3`)
- HTTP route table + access posture: `trading-platform/specs/033-platform-ops-read-api/contracts/transport-adapters.md`
- WS `LiveUpdate`: `trading-platform/src/operations/subscription-service.ts`
- Tier-2 analysis: `trading-platform/specs/039-ops-read-mock-package/contracts/analysis-snapshot.md`
- Research read DTOs: vendored SDK types in `trading-lab/vendor/trading-platform-sdk/` (`RunStatusView`, `RunResultView`, `RunResultSummary`, `ComparisonSummaryDTO`)

**Framing rule (must hold in all docs/comments):** office = direct Ops Read HTTP consumer; lab = platform bot-results/research-read consumer via the current SDK/MCP path (runtime integration deferred in this feature); trading-backtester = future separate executor for hypothesis/backtest lifecycle. Never state that lab is "not a consumer."

---

## File Structure

```
trading-mock-platform/
  package.json  tsconfig.json  vitest.config.ts  .gitignore  .env.example
  Dockerfile  docker-compose.mock.yml  README.md
  scripts/verify_contract_isolation.mjs        # CI guard: src/contract imports nothing outside src/contract
  docs/superpowers/plans/2026-06-16-standalone-ops-read-mock-platform.md
  src/
    contract/                                   # import-clean, extractable → future @trading/contracts
      common/envelopes.ts errors.ts capabilities.ts
      ops-read/dto.ts version.ts
      analysis/dto.ts version.ts
      research-read/dto.ts tools.ts version.ts
      snapshot/manifest.ts bundle.ts version.ts
      index.ts
    snapshot/
      checksums.ts compat.ts loader.ts registry.ts
      readers/runs.ts trades.ts events.ts decisions.ts health.ts coverage.ts analysis.ts research.ts
    safety/secret-scan.ts
    access/config.ts auth.ts audit.ts
    ops/pagination.ts ids.ts dispatch.ts
      handlers/discover.ts runs.ts summary.ts trades.ts events.ts decisions.ts health.ts coverage.ts analysis.ts
    research-read/adapter.ts capabilities.ts
    events/replay.ts ws-adapter.ts
    http/app.ts
    bin/start-mock-ops.ts
  data/snapshots/
    fixtures/2026-06-16-synthetic/manifest.json checksums.json ops/bundle.json
    .gitkeep
  test/
    contract/isolation.test.ts
    snapshot/{checksums,compat,loader}.test.ts
    safety/secret-scan.test.ts
    access/{config,auth}.test.ts
    ops/{pagination,ids,discover,runs,summary,trades,events,decisions,health,coverage,analysis}.test.ts
    research-read/adapter.test.ts
    events/replay.test.ts
    http/app.test.ts
    conformance/golden.test.ts
```

**Import-direction invariant (machine-checked by `scripts/verify_contract_isolation.mjs`):** every file under `src/contract/**` may import only from `src/contract/**` or Node stdlib. Everything else may import `src/contract/**`. This is what makes the contract layer extractable later.

---

## Phase 0 — Repo scaffolding

### Task 0: Project bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "trading-mock-platform",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "verify:contract-isolation": "node scripts/verify_contract_isolation.mjs",
    "check": "pnpm typecheck && pnpm verify:contract-isolation && pnpm test",
    "start": "node dist/src/bin/start-mock-ops.js",
    "dev": "tsx src/bin/start-mock-ops.ts"
  },
  "dependencies": {
    "@hono/node-server": "^1.19.0",
    "@hono/node-ws": "^1.3.0",
    "ajv": "^8.20.0",
    "hono": "^4.12.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test", "scripts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.log
# real sanitized snapshots are mounted at runtime, never committed
/data/snapshots/*
!/data/snapshots/.gitkeep
!/data/snapshots/fixtures/
```

- [ ] **Step 5: Create `.env.example`**

```bash
# --- trading-mock-platform runtime config ---
MOCK_OPS_PORT=8839                 # default matches trading-office's TRADING_PLATFORM_READ_URL default
MOCK_OPS_BIND=127.0.0.1            # loopback default; Docker sets 0.0.0.0 (then MOCK_OPS_TOKENS is REQUIRED)
MOCK_OPS_TOKENS=                  # comma-separated sha256-hex token allowlist; empty = loopback-trusted only
MOCK_SNAPSHOT_DIR=./data/snapshots
MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic   # which snapshot to serve (dir under MOCK_SNAPSHOT_DIR)
MOCK_REPLAY_MODE=loop             # once | loop  (WS /ops/events replay)
MOCK_REPLAY_SPEED=1               # speed multiplier (>0)
```

- [ ] **Step 6: Install + commit**

```bash
pnpm install
git add -A && git commit -m "chore: scaffold trading-mock-platform (package, tsconfig, vitest)"
```

---

## Phase 1 — Contract layer (import-clean, extractable)

> Types carry no runtime behavior, so most contract tasks have no unit test of their own — they are exercised by later tests. The one behavioral guarantee here (import isolation) IS tested, in Task 1.7.

### Task 1.1: Common envelopes, errors, capabilities

**Files:**
- Create: `src/contract/common/envelopes.ts`, `src/contract/common/errors.ts`, `src/contract/common/capabilities.ts`

- [ ] **Step 1: Create `src/contract/common/envelopes.ts`**

```ts
export type FreshnessMarker = 'fresh' | 'stale' | 'degraded';
export type SourceAvailability = 'available' | 'degraded' | 'unavailable';
export type OpsResourceAvailability = SourceAvailability | 'unsupported';

export interface PageWindow {
  readonly fromMs?: number;
  readonly toMs?: number;
}

export interface PageEnvelope<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly asOf: number;
  readonly window: PageWindow;
  readonly freshness: FreshnessMarker;
}
```

- [ ] **Step 2: Create `src/contract/common/errors.ts`**

```ts
export type OpsErrorCategory =
  | 'validation_error'
  | 'not_found'
  | 'unsupported_query'
  | 'internal_read_error';

export interface OpsError {
  readonly category: OpsErrorCategory;
  readonly code: string;
  readonly message: string;
}

export function isOpsError(value: unknown): value is OpsError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'category' in value &&
    'code' in value &&
    'message' in value
  );
}
```

- [ ] **Step 3: Create `src/contract/common/capabilities.ts`**

```ts
/** Surface A (Ops Read) authority declaration — all non-readOnly flags are literally false. */
export interface OpsCapabilities {
  readonly readOnly: true;
  readonly execution: false;
  readonly credentials: false;
  readonly ingestion: false;
  readonly mutation: false;
}

export const OPS_CAPABILITIES: OpsCapabilities = {
  readOnly: true,
  execution: false,
  credentials: false,
  ingestion: false,
  mutation: false,
};
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(contract): common envelopes, errors, capabilities"
```

### Task 1.2: Ops Read (Tier-1) DTOs + version

**Files:**
- Create: `src/contract/ops-read/version.ts`, `src/contract/ops-read/dto.ts`

- [ ] **Step 1: Create `src/contract/ops-read/version.ts`**

```ts
export const OPS_READ_CONTRACT_VERSION = 'ops.3';
```

- [ ] **Step 2: Create `src/contract/ops-read/dto.ts`** (MVP subset of `trading-platform/src/operations/dto.ts`; positions/run-state/log-refs/candidates intentionally omitted)

```ts
import type {
  PageEnvelope,
  SourceAvailability,
  OpsResourceAvailability,
} from '../common/envelopes.js';
import type { OpsCapabilities } from '../common/capabilities.js';

// --- runs ---
export type BotMode = 'live' | 'paper' | 'backtest';
export type BotRunStatus = 'running' | 'finished' | 'crashed' | 'aborted';
export interface BotRunStrategyRef { readonly name: string; readonly version: string; }
export interface BotRunRecord {
  readonly runId: string;          // opaque
  readonly mode: BotMode;
  readonly status: BotRunStatus;
  readonly strategy: BotRunStrategyRef;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly lastSeenMs: number;
  readonly symbols: readonly string[];
}

// --- trades + summary ---
export type TradeSide = 'long' | 'short';
export interface ClosedTrade {
  readonly tradeId: string;        // opaque
  readonly runId: string;          // opaque
  readonly symbol: string;
  readonly side: TradeSide;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly realizedPnl: string;    // numeric-as-string
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
  readonly runId: string;          // opaque
  readonly excludesReconcile: boolean;
  readonly asOf: number;
}

// --- events + decisions ---
export type OpsSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export interface OperationalEvent {
  readonly category: string;
  readonly severity: OpsSeverity | null;
  readonly runId: string;          // opaque
  readonly tradeId: string | null; // opaque
  readonly tsMs: number;
  readonly safeMessage: string;
}
export interface DecisionLogEntry {
  readonly category: string;
  readonly runId: string;          // opaque
  readonly botId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly reason: string;
  readonly tsMs: number;
  readonly safeMessage: string;
}

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

// convenience aliases for handlers
export type RunsPage = PageEnvelope<BotRunRecord>;
export type TradesPage = PageEnvelope<ClosedTrade>;
export type EventsPage = PageEnvelope<OperationalEvent>;
export type DecisionsPage = PageEnvelope<DecisionLogEntry>;
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(contract): ops-read tier-1 DTOs (ops.3)"
```

### Task 1.3: Analysis (Tier-2) DTOs + version

**Files:**
- Create: `src/contract/analysis/version.ts`, `src/contract/analysis/dto.ts`

- [ ] **Step 1: Create `src/contract/analysis/version.ts`**

```ts
export const ANALYSIS_CONTRACT_VERSION = 'ops.4';
```

- [ ] **Step 2: Create `src/contract/analysis/dto.ts`**

```ts
import type { FreshnessMarker } from '../common/envelopes.js';
import type { BotMode, BotRunStrategyRef, TradeSide } from '../ops-read/dto.js';

/** Capability-aware omission: a field that cannot be safely/reliably sourced. Never fabricate instead. */
export interface CapabilityAbsent {
  readonly available: false;
  readonly reason?: string;
}
export type Capable<T> = T | CapabilityAbsent;

export interface AnalysisIdentity {
  readonly mode: BotMode;
  readonly strategy: BotRunStrategyRef;
  readonly symbols: readonly string[];
}
export interface AnalysisPeriod {
  readonly fromMs: number;
  readonly toMs: number;
}
export interface AnalysisMetrics {
  readonly pnl: string;
  readonly winRate: number;
  readonly maxDrawdown: string;
  readonly totalTrades: number;
  /** OMITTED (field absent) when absolute gross loss == 0 — do not emit Infinity. */
  readonly profitFactor?: string;
  readonly topTradeContributionPct: number;
}
export interface AnalysisTrade {
  readonly tradeId: string;        // opaque
  readonly symbol: string;
  readonly side: TradeSide;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly realizedPnl: string;
  readonly entryReason: string | null;
  readonly exitReason: string | null;
}
export interface AnalysisFeatures {
  readonly oi: boolean;
  readonly liquidation: boolean;
  readonly dump: boolean;
  readonly bounce: boolean;
}
export interface SlTpBeEvent {
  readonly tradeId: string;        // opaque
  readonly kind: 'sl' | 'tp' | 'be';
  readonly tsMs: number;
}
export interface AnalysisSnapshot {
  readonly runRef: string;         // opaque
  readonly opsContractVersion: string;   // 'ops.4'
  readonly asOf: number;
  readonly freshness: FreshnessMarker;
  readonly identity: AnalysisIdentity;
  readonly period: AnalysisPeriod;
  readonly healthContext: string;
  readonly metrics: AnalysisMetrics;
  readonly trades: readonly AnalysisTrade[];
  readonly strategyConfig: Capable<Record<string, unknown>>;
  readonly dcaCount: Capable<number>;
  readonly slTpBeEvents: Capable<readonly SlTpBeEvent[]>;
  readonly features: Capable<AnalysisFeatures>;
  readonly summaryPatterns: readonly string[];
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(contract): analysis tier-2 snapshot DTO (ops.4) with capability-aware omission"
```

### Task 1.4: Research Read DTOs, tools, version

**Files:**
- Create: `src/contract/research-read/version.ts`, `src/contract/research-read/dto.ts`, `src/contract/research-read/tools.ts`

- [ ] **Step 1: Create `src/contract/research-read/version.ts`**

```ts
export const RESEARCH_READ_CONTRACT_VERSION = 'research.1';
```

- [ ] **Step 2: Create `src/contract/research-read/dto.ts`** (hand-mirrored read side of the SDK research surface; NO import of the SDK)

```ts
import type { Capable } from '../analysis/dto.js';

/** Read-only capability descriptor for Surface B. Mutating tools are explicitly false. */
export interface ResearchCapabilityDescriptor {
  readonly researchReadContractVersion: string;
  readonly capabilities: {
    readonly read: true;
    readonly mutation: false;
    readonly backtestSubmission: false;
    readonly backtestResults: false;
  };
  /** Why mutating/backtest surfaces are absent here. */
  readonly note: 'backtesting_moved_to_trading_backtester';
}

export interface ResearchMetrics {
  readonly netPnlUsd: string;
  readonly winRate: number;
  readonly maxDrawdownPct: string;
  readonly profitFactor?: string;   // omitted when gross loss == 0
  readonly sharpe: Capable<string>; // not always safely derivable
  readonly totalTrades: number;
}
export interface ResearchTrade {
  readonly tradeId: string;         // opaque
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly realizedPnl: string;
}
export interface ResearchDecision {
  readonly category: string;
  readonly symbol: string;
  readonly reason: string;
  readonly tsMs: number;
}
export interface ResearchRunSummary {
  readonly runRef: string;          // opaque
  readonly mode: 'live' | 'paper' | 'backtest';
  readonly metrics: ResearchMetrics;
  readonly asOf: number;
}
export interface ResearchRunResult {
  readonly summary: ResearchRunSummary;
  readonly trades: readonly ResearchTrade[];
  readonly decisions: readonly ResearchDecision[];
  readonly analysisContext: string;
}
```

- [ ] **Step 3: Create `src/contract/research-read/tools.ts`**

```ts
export interface ResearchToolDescriptor {
  readonly name: string;
  readonly available: boolean;
  readonly reason?: string;
}

/** Surface B tool catalog: read tools available; every mutating/backtest tool unavailable. */
export const RESEARCH_TOOLS: readonly ResearchToolDescriptor[] = [
  { name: 'listBotResults', available: true },
  { name: 'getRunSummary', available: true },
  { name: 'listTrades', available: true },
  { name: 'listDecisions', available: true },
  { name: 'getAnalysisContext', available: true },
  { name: 'submitOverlayRun', available: false, reason: 'backtesting_moved_to_trading_backtester' },
  { name: 'validateModule', available: false, reason: 'backtesting_moved_to_trading_backtester' },
  { name: 'getBacktestResult', available: false, reason: 'backtesting_moved_to_trading_backtester' },
];
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(contract): research-read DTOs + read-only tool catalog (backtest tools unavailable)"
```

### Task 1.5: Snapshot manifest + bundle schema + version

**Files:**
- Create: `src/contract/snapshot/version.ts`, `src/contract/snapshot/manifest.ts`, `src/contract/snapshot/bundle.ts`

- [ ] **Step 1: Create `src/contract/snapshot/version.ts`**

```ts
export const SNAPSHOT_SCHEMA_VERSION = 'snapshot.1';
```

- [ ] **Step 2: Create `src/contract/snapshot/manifest.ts`**

```ts
/** All contract/version coordinates a snapshot is bound to. Validated at startup (fail-closed). */
export interface SnapshotVersions {
  readonly snapshotSchemaVersion: string;
  readonly opsReadContractVersion: string;
  readonly researchReadContractVersion: string;
  readonly analysisContractVersion: string;
  readonly exporterVersion: string;
  readonly sourcePlatformCommit: string;
  readonly redactionPolicyVersion: string;
}
export interface SnapshotManifest {
  readonly ref: string;
  readonly createdAtMs: number;
  readonly versions: SnapshotVersions;
  readonly bundleRef: string;       // relative path to bundle.json
  readonly checksumsRef: string;    // relative path to checksums.json
}
```

- [ ] **Step 3: Create `src/contract/snapshot/bundle.ts`** (the union of allowlisted sanitized data feeding BOTH surfaces)

```ts
import type {
  BotRunRecord, ClosedTrade, OperationalEvent, DecisionLogEntry,
  RuntimeHealthCollection, MarketServiceHealthSnapshot, ExecutionHealthSnapshot,
  SourceCoverageSnapshot,
} from '../ops-read/dto.js';
import type { AnalysisSnapshot } from '../analysis/dto.js';
import type { ResearchRunResult } from '../research-read/dto.js';

/** One deterministic replay frame: emit the named WS resource at this offset from stream start. */
export interface ReplayFrame {
  readonly offsetMs: number;
  readonly resource: 'runs' | 'runtime-health';
}
export interface SnapshotBundle {
  readonly runs: readonly BotRunRecord[];
  readonly tradesByRun: Readonly<Record<string, readonly ClosedTrade[]>>;
  readonly eventsByRun: Readonly<Record<string, readonly OperationalEvent[]>>;
  readonly decisionsByRun: Readonly<Record<string, readonly DecisionLogEntry[]>>;
  readonly runtimeHealth: RuntimeHealthCollection;
  readonly marketHealth: MarketServiceHealthSnapshot;
  readonly executionHealth: ExecutionHealthSnapshot;
  readonly coverage: SourceCoverageSnapshot;
  readonly analysisByRun: Readonly<Record<string, AnalysisSnapshot>>;
  readonly researchByRun: Readonly<Record<string, ResearchRunResult>>;
  readonly replay: { readonly frames: readonly ReplayFrame[] };
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(contract): snapshot manifest + bundle schema (shared by both surfaces)"
```

### Task 1.6: Contract barrel export

**Files:**
- Create: `src/contract/index.ts`

- [ ] **Step 1: Create `src/contract/index.ts`**

```ts
export * from './common/envelopes.js';
export * from './common/errors.js';
export * from './common/capabilities.js';
export * from './ops-read/dto.js';
export * from './ops-read/version.js';
export * from './analysis/dto.js';
export * from './analysis/version.js';
export * from './research-read/dto.js';
export * from './research-read/tools.js';
export * from './research-read/version.js';
export * from './snapshot/manifest.js';
export * from './snapshot/bundle.js';
export * from './snapshot/version.js';
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(contract): barrel export"
```

### Task 1.7: Contract isolation guard (the extractability guarantee)

**Files:**
- Create: `scripts/verify_contract_isolation.mjs`
- Test: `test/contract/isolation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('contract isolation', () => {
  it('verify script exits 0 on a clean contract layer', () => {
    const run = () => execFileSync('node', ['scripts/verify_contract_isolation.mjs'], { encoding: 'utf8' });
    expect(run).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/contract/isolation.test.ts`
Expected: FAIL — `Cannot find module 'scripts/verify_contract_isolation.mjs'` (script not created yet).

- [ ] **Step 3: Write `scripts/verify_contract_isolation.mjs`**

```js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/contract';
const IMPORT_RE = /^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    const isRelative = spec.startsWith('.');
    const isNodeStdlib = spec.startsWith('node:');
    if (isNodeStdlib) continue;
    if (!isRelative) {
      violations.push(`${file}: non-stdlib package import '${spec}' (contract layer must stay dependency-free)`);
      continue;
    }
    // relative imports must resolve to somewhere inside src/contract
    // any '../' that climbs above src/contract is a leak
    const depth = file.split('/').length - 1 - ROOT.split('/').length; // dirs below ROOT
    const climbs = (spec.match(/\.\.\//g) || []).length;
    if (climbs > depth) {
      violations.push(`${file}: relative import '${spec}' escapes ${ROOT}`);
    }
  }
}

if (violations.length) {
  console.error('Contract isolation violations:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('contract isolation OK');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/contract/isolation.test.ts`
Expected: PASS (prints `contract isolation OK`).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contract): machine-checked import-isolation guard (extractability)"
```

---

## Phase 2 — Snapshot layer

### Task 2.1: Checksums verification

**Files:**
- Create: `src/snapshot/checksums.ts`
- Test: `test/snapshot/checksums.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyChecksum } from '../../src/snapshot/checksums.js';

describe('verifyChecksum', () => {
  it('passes when sha256 matches', () => {
    const buf = Buffer.from('hello');
    const want = createHash('sha256').update(buf).digest('hex');
    expect(() => verifyChecksum('a.json', buf, want)).not.toThrow();
  });
  it('throws a clear error when sha256 mismatches', () => {
    expect(() => verifyChecksum('a.json', Buffer.from('hello'), 'deadbeef'))
      .toThrow(/checksum mismatch.*a\.json/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/snapshot/checksums.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/snapshot/checksums.ts`**

```ts
import { createHash } from 'node:crypto';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function verifyChecksum(name: string, data: Buffer, expectedHex: string): void {
  const actual = sha256Hex(data);
  if (actual !== expectedHex) {
    throw new Error(`snapshot checksum mismatch for ${name}: expected ${expectedHex}, got ${actual}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/snapshot/checksums.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(snapshot): sha256 checksum verification (fail-closed)"
```

### Task 2.2: Version compatibility gate (fail-closed)

**Files:**
- Create: `src/snapshot/compat.ts`
- Test: `test/snapshot/compat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { assertSnapshotCompatible } from '../../src/snapshot/compat.js';
import type { SnapshotVersions } from '../../src/contract/snapshot/manifest.js';

const base: SnapshotVersions = {
  snapshotSchemaVersion: 'snapshot.1',
  opsReadContractVersion: 'ops.3',
  researchReadContractVersion: 'research.1',
  analysisContractVersion: 'ops.4',
  exporterVersion: 'exp.1',
  sourcePlatformCommit: 'abc123',
  redactionPolicyVersion: 'redact.1',
};

describe('assertSnapshotCompatible', () => {
  it('accepts a snapshot whose major contract versions are supported', () => {
    expect(() => assertSnapshotCompatible(base)).not.toThrow();
  });
  it('fails closed on unsupported snapshot schema major', () => {
    expect(() => assertSnapshotCompatible({ ...base, snapshotSchemaVersion: 'snapshot.2' }))
      .toThrow(/unsupported snapshotSchemaVersion 'snapshot\.2'/i);
  });
  it('fails closed on unsupported ops-read contract major', () => {
    expect(() => assertSnapshotCompatible({ ...base, opsReadContractVersion: 'ops.99' }))
      .toThrow(/unsupported opsReadContractVersion/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/snapshot/compat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/snapshot/compat.ts`**

```ts
import type { SnapshotVersions } from '../contract/snapshot/manifest.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../contract/snapshot/version.js';
import { OPS_READ_CONTRACT_VERSION } from '../contract/ops-read/version.js';
import { ANALYSIS_CONTRACT_VERSION } from '../contract/analysis/version.js';
import { RESEARCH_READ_CONTRACT_VERSION } from '../contract/research-read/version.js';

/** A dotted version 'name.N' is compatible when name matches and N <= supported N (additive-optional = minor). */
function majorOf(v: string): { name: string; n: number } {
  const [name, n] = v.split('.');
  return { name: name ?? '', n: Number(n ?? 'NaN') };
}
function check(field: string, got: string, supported: string): void {
  const g = majorOf(got);
  const s = majorOf(supported);
  if (g.name !== s.name || !Number.isInteger(g.n) || g.n > s.n) {
    throw new Error(
      `unsupported ${field} '${got}' (this mock supports '${supported}' and earlier-minor of the same major)`,
    );
  }
}

export function assertSnapshotCompatible(v: SnapshotVersions): void {
  check('snapshotSchemaVersion', v.snapshotSchemaVersion, SNAPSHOT_SCHEMA_VERSION);
  check('opsReadContractVersion', v.opsReadContractVersion, OPS_READ_CONTRACT_VERSION);
  check('analysisContractVersion', v.analysisContractVersion, ANALYSIS_CONTRACT_VERSION);
  check('researchReadContractVersion', v.researchReadContractVersion, RESEARCH_READ_CONTRACT_VERSION);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/snapshot/compat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(snapshot): fail-closed version compatibility gate"
```

### Task 2.3: Snapshot loader (manifest + checksums + compat + bundle)

**Files:**
- Create: `src/snapshot/loader.ts`
- Test: `test/snapshot/loader.test.ts`

- [ ] **Step 1: Write the failing test** (writes a tiny snapshot to a temp dir, loads it)

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../../src/snapshot/checksums.js';
import { loadSnapshot } from '../../src/snapshot/loader.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(dir, 'ops'), { recursive: true });
  const bundle = {
    runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {},
    runtimeHealth: { entries: [], asOf: 1 },
    marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
    executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
    coverage: { entries: [], availability: 'available', asOf: 1 },
    analysisByRun: {}, researchByRun: {}, replay: { frames: [] },
  };
  const bundleStr = JSON.stringify(bundle);
  writeFileSync(join(dir, 'ops', 'bundle.json'), bundleStr);
  const checksums = { 'ops/bundle.json': sha256Hex(bundleStr) };
  writeFileSync(join(dir, 'checksums.json'), JSON.stringify(checksums));
  const manifest = {
    ref: 'test', createdAtMs: 1, bundleRef: 'ops/bundle.json', checksumsRef: 'checksums.json',
    versions: {
      snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.3',
      researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
      exporterVersion: 'exp.1', sourcePlatformCommit: 'abc', redactionPolicyVersion: 'redact.1',
    },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
});

describe('loadSnapshot', () => {
  it('loads a valid snapshot with manifest, verified checksum, and bundle', () => {
    const snap = loadSnapshot(dir);
    expect(snap.manifest.ref).toBe('test');
    expect(snap.bundle.runs).toEqual([]);
  });
  it('fails closed when the bundle checksum is wrong', () => {
    const bad = mkdtempSync(join(tmpdir(), 'snap-bad-'));
    mkdirSync(join(bad, 'ops'), { recursive: true });
    writeFileSync(join(bad, 'ops', 'bundle.json'), '{"runs":[]}');
    writeFileSync(join(bad, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': 'deadbeef' }));
    writeFileSync(join(bad, 'manifest.json'), JSON.stringify({
      ref: 'bad', createdAtMs: 1, bundleRef: 'ops/bundle.json', checksumsRef: 'checksums.json',
      versions: {
        snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.3',
        researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
        exporterVersion: 'exp.1', sourcePlatformCommit: 'abc', redactionPolicyVersion: 'redact.1',
      },
    }));
    expect(() => loadSnapshot(bad)).toThrow(/checksum mismatch/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/snapshot/loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/snapshot/loader.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotManifest } from '../contract/snapshot/manifest.js';
import type { SnapshotBundle } from '../contract/snapshot/bundle.js';
import { verifyChecksum } from './checksums.js';
import { assertSnapshotCompatible } from './compat.js';
import { scanForSecrets } from '../safety/secret-scan.js';

export interface LoadedSnapshot {
  readonly dir: string;
  readonly manifest: SnapshotManifest;
  readonly bundle: SnapshotBundle;
}

export function loadSnapshot(dir: string): LoadedSnapshot {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as SnapshotManifest;
  assertSnapshotCompatible(manifest.versions);

  const checksums = JSON.parse(
    readFileSync(join(dir, manifest.checksumsRef), 'utf8'),
  ) as Record<string, string>;

  const bundleBuf = readFileSync(join(dir, manifest.bundleRef));
  const expected = checksums[manifest.bundleRef];
  if (!expected) throw new Error(`checksums.json missing entry for ${manifest.bundleRef}`);
  verifyChecksum(manifest.bundleRef, bundleBuf, expected);

  const bundleStr = bundleBuf.toString('utf8');
  scanForSecrets(manifest.bundleRef, bundleStr); // defense-in-depth (fail-closed)

  const bundle = JSON.parse(bundleStr) as SnapshotBundle;
  return { dir, manifest, bundle };
}
```

> NOTE: this imports `src/safety/secret-scan.js` (Task 3.1). Implement Task 3.1 first if executing strictly in order; the test above will still fail on the missing safety module until then. Reorder so Phase 3 Task 3.1 precedes this step, or stub `scanForSecrets` as a no-op export and fill it in Task 3.1.

- [ ] **Step 4: Run test to verify it passes** (after Task 3.1 exists)

Run: `pnpm vitest run test/snapshot/loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(snapshot): loader with manifest+compat+checksum+secret-scan (fail-closed)"
```

### Task 2.4: Registry (resolve MOCK_SNAPSHOT_REF → dir) + readers

**Files:**
- Create: `src/snapshot/registry.ts`, `src/snapshot/readers/runs.ts`, `.../trades.ts`, `.../events.ts`, `.../decisions.ts`, `.../health.ts`, `.../coverage.ts`, `.../analysis.ts`, `.../research.ts`

- [ ] **Step 1: Create `src/snapshot/registry.ts`**

```ts
import { join } from 'node:path';
import { loadSnapshot, type LoadedSnapshot } from './loader.js';

/** Resolve a snapshot ref under the snapshot root and load it once (eager, in-memory). */
export function openSnapshot(rootDir: string, ref: string): LoadedSnapshot {
  return loadSnapshot(join(rootDir, ref));
}
```

- [ ] **Step 2: Create the readers** (pure projections over the in-memory bundle; one file each)

`src/snapshot/readers/runs.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { BotRunRecord } from '../../contract/ops-read/dto.js';

export interface RunsFilter { mode?: string; status?: string; symbol?: string; }

export function readRuns(bundle: SnapshotBundle, f: RunsFilter): readonly BotRunRecord[] {
  return bundle.runs.filter((r) =>
    (f.mode ? r.mode === f.mode : true) &&
    (f.status ? r.status === f.status : true) &&
    (f.symbol ? r.symbols.includes(f.symbol) : true),
  );
}
```

`src/snapshot/readers/trades.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { ClosedTrade } from '../../contract/ops-read/dto.js';

export function readTrades(bundle: SnapshotBundle, runId: string): readonly ClosedTrade[] {
  return bundle.tradesByRun[runId] ?? [];
}
```

`src/snapshot/readers/events.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { OperationalEvent } from '../../contract/ops-read/dto.js';

export function readEvents(bundle: SnapshotBundle, runId: string): readonly OperationalEvent[] {
  return bundle.eventsByRun[runId] ?? [];
}
```

`src/snapshot/readers/decisions.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { DecisionLogEntry } from '../../contract/ops-read/dto.js';

export function readDecisions(bundle: SnapshotBundle, runId: string): readonly DecisionLogEntry[] {
  return bundle.decisionsByRun[runId] ?? [];
}
```

`src/snapshot/readers/health.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type {
  RuntimeHealthCollection, MarketServiceHealthSnapshot, ExecutionHealthSnapshot,
} from '../../contract/ops-read/dto.js';

export const readRuntimeHealth = (b: SnapshotBundle): RuntimeHealthCollection => b.runtimeHealth;
export const readMarketHealth = (b: SnapshotBundle): MarketServiceHealthSnapshot => b.marketHealth;
export const readExecutionHealth = (b: SnapshotBundle): ExecutionHealthSnapshot => b.executionHealth;
```

`src/snapshot/readers/coverage.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { SourceCoverageSnapshot } from '../../contract/ops-read/dto.js';

export function readCoverage(b: SnapshotBundle, source?: string, kind?: string): SourceCoverageSnapshot {
  if (!source && !kind) return b.coverage;
  return {
    ...b.coverage,
    entries: b.coverage.entries.filter((e) =>
      (source ? e.source === source : true) && (kind ? e.kind === kind : true)),
  };
}
```

`src/snapshot/readers/analysis.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { AnalysisSnapshot } from '../../contract/analysis/dto.js';

export function readAnalysis(b: SnapshotBundle, runId: string): AnalysisSnapshot | undefined {
  return b.analysisByRun[runId];
}
```

`src/snapshot/readers/research.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { ResearchRunResult } from '../../contract/research-read/dto.js';

export function readResearchResult(b: SnapshotBundle, runId: string): ResearchRunResult | undefined {
  return b.researchByRun[runId];
}
export function listResearchResults(b: SnapshotBundle): readonly ResearchRunResult[] {
  return Object.values(b.researchByRun);
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(snapshot): registry + per-surface readers over in-memory bundle"
```

---

## Phase 3 — Safety

### Task 3.1: Secret / forbidden-pattern scan (defense-in-depth)

**Files:**
- Create: `src/safety/secret-scan.ts`
- Test: `test/safety/secret-scan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { scanForSecrets } from '../../src/safety/secret-scan.js';

describe('scanForSecrets', () => {
  it('passes clean sanitized content', () => {
    expect(() => scanForSecrets('bundle.json', '{"runs":[{"runId":"r_opaque1"}]}')).not.toThrow();
  });
  it('fails closed on an exchange API key pattern', () => {
    expect(() => scanForSecrets('bundle.json', 'key=AKIA1234567890ABCD'))
      .toThrow(/forbidden pattern/i);
  });
  it('fails closed on an absolute host path', () => {
    expect(() => scanForSecrets('bundle.json', '{"p":"/home/operator/secret.log"}'))
      .toThrow(/forbidden pattern/i);
  });
  it('fails closed on a bearer/JWT-looking token', () => {
    expect(() => scanForSecrets('bundle.json', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aa.bb'))
      .toThrow(/forbidden pattern/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/safety/secret-scan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/safety/secret-scan.ts`**

```ts
/** Defense-in-depth blocklist over an already-sanitized snapshot. Sanitization is primarily an
 *  operator-side allowlist projection; this catches leaks that slipped through. Fail closed. */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['jwt / bearer token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/],
  ['absolute unix host path', /(?:"|')\/(?:home|root|etc|var|usr|opt)\//],
  ['windows host path', /[A-Za-z]:\\\\(?:Users|home)\\\\/],
  ['db connection url', /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"']+/],
];

export function scanForSecrets(name: string, content: string): void {
  for (const [label, re] of FORBIDDEN) {
    if (re.test(content)) {
      throw new Error(`snapshot safety: forbidden pattern '${label}' detected in ${name} — refusing to load`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/safety/secret-scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(safety): defense-in-depth secret/forbidden-pattern scan (fail-closed)"
```

---

## Phase 4 — Access posture

### Task 4.1: Config (fail-closed)

**Files:**
- Create: `src/access/config.ts`
- Test: `test/access/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { loadMockConfig } from '../../src/access/config.js';

describe('loadMockConfig', () => {
  it('defaults to loopback bind on port 8839', () => {
    const c = loadMockConfig({});
    expect(c.bind).toBe('127.0.0.1');
    expect(c.port).toBe(8839);
    expect(c.tokenAllowlist).toEqual([]);
  });
  it('FAILS CLOSED when bind is non-loopback and no tokens are set', () => {
    expect(() => loadMockConfig({ MOCK_OPS_BIND: '0.0.0.0' }))
      .toThrow(/non-loopback bind .* requires MOCK_OPS_TOKENS/i);
  });
  it('allows non-loopback bind when a token allowlist is provided', () => {
    const c = loadMockConfig({ MOCK_OPS_BIND: '0.0.0.0', MOCK_OPS_TOKENS: 'abc,def' });
    expect(c.bind).toBe('0.0.0.0');
    expect(c.tokenAllowlist).toEqual(['abc', 'def']);
  });
  it('rejects a non-positive replay speed', () => {
    expect(() => loadMockConfig({ MOCK_REPLAY_SPEED: '0' })).toThrow(/MOCK_REPLAY_SPEED/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/access/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/access/config.ts`**

```ts
export interface MockConfig {
  readonly port: number;
  readonly bind: string;
  readonly tokenAllowlist: readonly string[]; // sha256-hex
  readonly snapshotDir: string;
  readonly snapshotRef: string;
  readonly replayMode: 'once' | 'loop';
  readonly replaySpeed: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadMockConfig(env: Record<string, string | undefined>): MockConfig {
  const bind = env.MOCK_OPS_BIND ?? '127.0.0.1';
  const port = Number(env.MOCK_OPS_PORT ?? '8839');
  const tokenAllowlist = (env.MOCK_OPS_TOKENS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (!LOOPBACK.has(bind) && tokenAllowlist.length === 0) {
    throw new Error(
      `non-loopback bind '${bind}' requires MOCK_OPS_TOKENS (sha256-hex allowlist) — refusing to start anonymously`,
    );
  }
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid MOCK_OPS_PORT '${env.MOCK_OPS_PORT}'`);

  const replayMode = (env.MOCK_REPLAY_MODE ?? 'loop');
  if (replayMode !== 'once' && replayMode !== 'loop') throw new Error(`invalid MOCK_REPLAY_MODE '${replayMode}'`);
  const replaySpeed = Number(env.MOCK_REPLAY_SPEED ?? '1');
  if (!(replaySpeed > 0)) throw new Error(`invalid MOCK_REPLAY_SPEED '${env.MOCK_REPLAY_SPEED}' (must be > 0)`);

  return {
    port, bind, tokenAllowlist,
    snapshotDir: env.MOCK_SNAPSHOT_DIR ?? './data/snapshots',
    snapshotRef: env.MOCK_SNAPSHOT_REF ?? 'fixtures/2026-06-16-synthetic',
    replayMode, replaySpeed,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/access/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(access): fail-closed config (loopback default, no anonymous network)"
```

### Task 4.2: Auth (sha256 bearer allowlist) + redacted audit

**Files:**
- Create: `src/access/auth.ts`, `src/access/audit.ts`
- Test: `test/access/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { authorize } from '../../src/access/auth.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

describe('authorize', () => {
  it('allows any request when allowlist is empty (loopback-trusted)', () => {
    expect(authorize([], undefined).ok).toBe(true);
  });
  it('rejects a missing token when allowlist is non-empty', () => {
    expect(authorize([hash('secret')], undefined)).toEqual({ ok: false });
  });
  it('accepts a token whose sha256 is allowlisted', () => {
    const r = authorize([hash('secret')], 'secret');
    expect(r.ok).toBe(true);
  });
  it('rejects a token not in the allowlist', () => {
    expect(authorize([hash('secret')], 'wrong')).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/access/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/access/auth.ts`**

```ts
import { createHash } from 'node:crypto';

export interface AuthResult { readonly ok: boolean; readonly subject?: string; }

/** Empty allowlist = loopback-trusted (open). Otherwise sha256(token) must be allowlisted. */
export function authorize(allowlist: readonly string[], rawToken: string | undefined): AuthResult {
  if (allowlist.length === 0) return { ok: true, subject: 'local' };
  if (!rawToken) return { ok: false };
  const h = createHash('sha256').update(rawToken).digest('hex');
  if (allowlist.includes(h)) return { ok: true, subject: h.slice(0, 16) };
  return { ok: false };
}

/** Parse `Authorization: Bearer <t>` (case-insensitive). */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}
```

- [ ] **Step 4: Write `src/access/audit.ts`**

```ts
export interface AuditRecord {
  readonly tsMs: number;
  readonly subject: string;     // hash prefix or 'local'/'anonymous' — never the raw token
  readonly resource: string;
  readonly outcome: 'accepted' | 'rejected';
}

/** Emits a redacted audit line. Never logs tokens, payloads, host paths, or credentials. */
export function auditLog(rec: AuditRecord): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ kind: 'ops_audit', ...rec }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/access/auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(access): sha256 bearer auth + redacted audit log"
```

---

## Phase 5 — Ops Read handlers (Surface A, HTTP)

### Task 5.1: Pagination (opaque cursor + window clamp)

**Files:**
- Create: `src/ops/pagination.ts`
- Test: `test/ops/pagination.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, paginate } from '../../src/ops/pagination.js';

describe('pagination', () => {
  it('round-trips an opaque cursor', () => {
    const c = encodeCursor({ offset: 50 });
    expect(typeof c).toBe('string');
    expect(decodeCursor(c)).toEqual({ offset: 50 });
  });
  it('throws on a malformed cursor', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(/invalid cursor/i);
  });
  it('returns a page with nextCursor when more items remain', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const p = paginate(items, undefined, 2);
    expect(p.items).toEqual([0, 1]);
    expect(p.nextCursor).not.toBeNull();
    const p2 = paginate(items, p.nextCursor!, 2);
    expect(p2.items).toEqual([2, 3]);
  });
  it('returns null nextCursor on the last page', () => {
    const items = [0, 1];
    const p = paginate(items, undefined, 2);
    expect(p.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/ops/pagination.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ops/pagination.ts`**

```ts
import type { PageEnvelope, PageWindow, FreshnessMarker } from '../contract/common/envelopes.js';

interface CursorState { readonly offset: number; }

export function encodeCursor(s: CursorState): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
}
export function decodeCursor(cursor: string): CursorState {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
    if (typeof obj.offset !== 'number' || obj.offset < 0) throw new Error('bad offset');
    return obj;
  } catch {
    throw new Error(`invalid cursor`);
  }
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

export function paginate<T>(
  all: readonly T[],
  cursor: string | undefined,
  limit = DEFAULT_PAGE,
  opts: { asOf?: number; window?: PageWindow; freshness?: FreshnessMarker } = {},
): PageEnvelope<T> {
  const lim = Math.min(Math.max(1, limit), MAX_PAGE);
  const offset = cursor ? decodeCursor(cursor).offset : 0;
  const items = all.slice(offset, offset + lim);
  const nextCursor = offset + lim < all.length ? encodeCursor({ offset: offset + lim }) : null;
  return {
    items,
    nextCursor,
    asOf: opts.asOf ?? 0,
    window: opts.window ?? {},
    freshness: opts.freshness ?? 'fresh',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/ops/pagination.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ops): opaque-cursor pagination"
```

### Task 5.2: Opaque ids

**Files:**
- Create: `src/ops/ids.ts`
- Test: `test/ops/ids.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { decodeId } from '../../src/ops/ids.js';

describe('decodeId', () => {
  it('accepts an opaque id of the expected kind', () => {
    expect(decodeId('run', 'r_abc123')).toBe('r_abc123');
  });
  it('throws on an empty id', () => {
    expect(() => decodeId('run', '')).toThrow(/invalid run id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/ops/ids.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ops/ids.ts`**

```ts
/** In the mock, snapshot ids are ALREADY opaque (exporter encoded them). We only validate shape;
 *  we never decode to anything internal — there is no internal id space in the mock. */
export function decodeId(kind: 'run' | 'trade', raw: string): string {
  if (!raw || typeof raw !== 'string') throw new Error(`invalid ${kind} id`);
  return raw;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/ops/ids.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ops): opaque id validation (no internal id space)"
```

### Task 5.3: Discover handler

**Files:**
- Create: `src/ops/handlers/discover.ts`
- Test: `test/ops/discover.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildDiscover } from '../../src/ops/handlers/discover.js';

describe('buildDiscover', () => {
  it('declares ops.3, read-only capabilities, and a closed resource catalog', () => {
    const d = buildDiscover();
    expect(d.opsContractVersion).toBe('ops.3');
    expect(d.capabilities).toEqual({
      readOnly: true, execution: false, credentials: false, ingestion: false, mutation: false,
    });
    const names = d.resources.map((r) => r.name);
    expect(names).toContain('runs');
    expect(names).toContain('source-coverage');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/ops/discover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ops/handlers/discover.ts`**

```ts
import type { OpsCapabilityDescriptor, OpsResourceDescriptor } from '../../contract/ops-read/dto.js';
import { OPS_CAPABILITIES } from '../../contract/common/capabilities.js';
import { OPS_READ_CONTRACT_VERSION } from '../../contract/ops-read/version.js';
import { MAX_PAGE } from '../pagination.js';

const RESOURCES: readonly OpsResourceDescriptor[] = [
  { name: 'runs', supportedFilters: ['status', 'mode', 'symbol', 'cursor'],
    pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['runId', 'mode', 'status', 'strategy', 'startedAtMs', 'finishedAtMs', 'lastSeenMs', 'symbols'] },
  { name: 'summary', supportedFilters: ['excludeReconcile'], pagination: null, fields: ['runId', 'closedTrades', 'winratePct', 'pnlUsd'] },
  { name: 'trades', supportedFilters: ['runId', 'cursor'], pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['tradeId', 'runId', 'symbol', 'side', 'realizedPnl'] },
  { name: 'events', supportedFilters: ['runId', 'cursor'], pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['category', 'severity', 'runId', 'tsMs', 'safeMessage'] },
  { name: 'decisions', supportedFilters: ['runId', 'cursor'], pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['category', 'runId', 'symbol', 'reason', 'tsMs'] },
  { name: 'runtime-health', supportedFilters: [], pagination: null, fields: ['entries', 'asOf'], availability: 'available' },
  { name: 'market-health', supportedFilters: [], pagination: null, fields: ['status', 'availability', 'asOf'], availability: 'available' },
  { name: 'execution-health', supportedFilters: [], pagination: null, fields: ['status', 'availability', 'asOf'], availability: 'available' },
  { name: 'source-coverage', supportedFilters: ['source', 'kind'], pagination: null, fields: ['entries', 'availability', 'asOf'], availability: 'available' },
  { name: 'run-analysis', supportedFilters: [], pagination: null, fields: ['runRef', 'metrics', 'trades'] },
];

export function buildDiscover(): OpsCapabilityDescriptor {
  return {
    opsContractVersion: OPS_READ_CONTRACT_VERSION,
    capabilities: OPS_CAPABILITIES,
    resources: RESOURCES,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/ops/discover.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ops): discover handler (ops.3 closed catalog)"
```

### Task 5.4: Runs / summary / trades / events / decisions / health / coverage handlers

**Files:**
- Create: `src/ops/handlers/runs.ts`, `.../summary.ts`, `.../trades.ts`, `.../events.ts`, `.../decisions.ts`, `.../health.ts`, `.../coverage.ts`
- Test: `test/ops/runs.test.ts`, `test/ops/summary.test.ts`, `test/ops/trades.test.ts`, `test/ops/events.test.ts`, `test/ops/decisions.test.ts`, `test/ops/health.test.ts`, `test/ops/coverage.test.ts`

> These handlers take the in-memory `SnapshotBundle` + parsed args and return contract DTOs. They never throw to transport; missing data → `availability:'unavailable'` or a `not_found` `OpsError`, never a thrown exception across the transport boundary.

- [ ] **Step 1: Write `test/ops/runs.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { handleRuns } from '../../src/ops/handlers/runs.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [
    { runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] },
    { runId: 'r2', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: 9, lastSeenMs: 9, symbols: ['ETHUSDT'] },
  ],
} as unknown as SnapshotBundle;

describe('handleRuns', () => {
  it('returns a page of runs filtered by mode', () => {
    const page = handleRuns(bundle, { mode: 'live' }, 100);
    expect(page.items.map((r) => r.runId)).toEqual(['r1']);
    expect(page.items[0]!.strategy.name).toBe('s'); // office hard-requires strategy.name
  });
  it('returns all runs when no filter', () => {
    expect(handleRuns(bundle, {}, 100).items).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL (module not found).**

Run: `pnpm vitest run test/ops/runs.test.ts`

- [ ] **Step 3: Write the handlers**

`src/ops/handlers/runs.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RunsPage } from '../../contract/ops-read/dto.js';
import { readRuns, type RunsFilter } from '../../snapshot/readers/runs.js';
import { paginate } from '../pagination.js';

export function handleRuns(bundle: SnapshotBundle, filter: RunsFilter, asOf: number, cursor?: string): RunsPage {
  return paginate(readRuns(bundle, filter), cursor, undefined, { asOf });
}
```

`src/ops/handlers/summary.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RunSummary, ClosedTrade } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readTrades } from '../../snapshot/readers/trades.js';
import { decodeId } from '../ids.js';

export function handleSummary(bundle: SnapshotBundle, runIdRaw: string, asOf: number): RunSummary | OpsError {
  let runId: string;
  try { runId = decodeId('run', runIdRaw); }
  catch { return { category: 'validation_error', code: 'invalid_run_id', message: 'invalid run id' }; }
  const trades = readTrades(bundle, runId);
  if (trades.length === 0 && !bundle.tradesByRun[runId]) {
    return { category: 'not_found', code: 'run_not_found', message: 'run not found' };
  }
  return aggregate(runId, trades, asOf);
}

function aggregate(runId: string, trades: readonly ClosedTrade[], asOf: number): RunSummary {
  let wins = 0, losses = 0, breakeven = 0, pnl = 0;
  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    const p = Number(t.realizedPnl);
    pnl += p;
    if (t.isWin === true) wins++; else if (t.isWin === false) losses++; else breakeven++;
    const reason = t.closeReason ?? 'unknown';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }
  const closedTrades = trades.length;
  return {
    runId, excludesReconcile: true, asOf,
    closedTrades, wins, losses, breakeven,
    winratePct: closedTrades ? (wins / closedTrades) * 100 : 0,
    pnlUsd: pnl.toFixed(8),
    avgPnl: closedTrades ? (pnl / closedTrades).toFixed(8) : '0',
    exitReasons,
  };
}
```

`src/ops/handlers/trades.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { TradesPage } from '../../contract/ops-read/dto.js';
import { readTrades } from '../../snapshot/readers/trades.js';
import { paginate } from '../pagination.js';

export function handleTrades(bundle: SnapshotBundle, runId: string, asOf: number, cursor?: string): TradesPage {
  return paginate(readTrades(bundle, runId), cursor, undefined, { asOf });
}
```

`src/ops/handlers/events.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { EventsPage } from '../../contract/ops-read/dto.js';
import { readEvents } from '../../snapshot/readers/events.js';
import { paginate } from '../pagination.js';

export function handleEvents(bundle: SnapshotBundle, runId: string, asOf: number, cursor?: string): EventsPage {
  return paginate(readEvents(bundle, runId), cursor, undefined, { asOf });
}
```

`src/ops/handlers/decisions.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { DecisionsPage } from '../../contract/ops-read/dto.js';
import { readDecisions } from '../../snapshot/readers/decisions.js';
import { paginate } from '../pagination.js';

export function handleDecisions(bundle: SnapshotBundle, runId: string, asOf: number, cursor?: string): DecisionsPage {
  return paginate(readDecisions(bundle, runId), cursor, undefined, { asOf });
}
```

`src/ops/handlers/health.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import { readRuntimeHealth, readMarketHealth, readExecutionHealth } from '../../snapshot/readers/health.js';

export const handleRuntimeHealth = (b: SnapshotBundle) => readRuntimeHealth(b);
export const handleMarketHealth = (b: SnapshotBundle) => readMarketHealth(b);
export const handleExecutionHealth = (b: SnapshotBundle) => readExecutionHealth(b);
```

`src/ops/handlers/coverage.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import { readCoverage } from '../../snapshot/readers/coverage.js';

export function handleCoverage(b: SnapshotBundle, source?: string, kind?: string) {
  return readCoverage(b, source, kind);
}
```

- [ ] **Step 4: Write the remaining tests** (`summary`, `trades`, `events`, `decisions`, `health`, `coverage`)

`test/ops/summary.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handleSummary } from '../../src/ops/handlers/summary.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  tradesByRun: {
    r1: [
      { tradeId: 't1', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 2,
        realizedPnl: '10', pnlPct: '1', isWin: true, closeReason: 'tp' },
      { tradeId: 't2', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 2,
        realizedPnl: '-4', pnlPct: '-1', isWin: false, closeReason: 'sl' },
    ],
  },
} as unknown as SnapshotBundle;

describe('handleSummary', () => {
  it('aggregates wins/losses/pnl', () => {
    const s = handleSummary(bundle, 'r1', 100);
    expect(isOpsError(s)).toBe(false);
    if (isOpsError(s)) return;
    expect(s.closedTrades).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.pnlUsd).toBe('6.00000000');
  });
  it('returns not_found for an unknown run', () => {
    const s = handleSummary(bundle, 'rX', 100);
    expect(isOpsError(s) && s.category).toBe('not_found');
  });
  it('returns validation_error for an empty id', () => {
    const s = handleSummary(bundle, '', 100);
    expect(isOpsError(s) && s.category).toBe('validation_error');
  });
});
```

`test/ops/trades.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handleTrades } from '../../src/ops/handlers/trades.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { tradesByRun: { r1: [{ tradeId: 't1', runId: 'r1', symbol: 'B', side: 'long',
  openedAtMs: 1, closedAtMs: 2, realizedPnl: '1', pnlPct: '1', isWin: true, closeReason: 'tp' }] } } as unknown as SnapshotBundle;

describe('handleTrades', () => {
  it('returns trades for a run in a page envelope', () => {
    const p = handleTrades(bundle, 'r1', 100);
    expect(p.items).toHaveLength(1);
    expect(p.nextCursor).toBeNull();
  });
  it('returns an empty page for an unknown run', () => {
    expect(handleTrades(bundle, 'rX', 100).items).toEqual([]);
  });
});
```

`test/ops/events.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handleEvents } from '../../src/ops/handlers/events.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { eventsByRun: { r1: [{ category: 'startup', severity: 'info', runId: 'r1',
  tradeId: null, tsMs: 1, safeMessage: 'ok' }] } } as unknown as SnapshotBundle;

describe('handleEvents', () => {
  it('returns events for a run', () => {
    expect(handleEvents(bundle, 'r1', 100).items).toHaveLength(1);
  });
});
```

`test/ops/decisions.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handleDecisions } from '../../src/ops/handlers/decisions.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { decisionsByRun: { r1: [{ category: 'no_entry', runId: 'r1', botId: 'long_oi',
  symbol: 'BTCUSDT', side: 'long', reason: 'oi flat', tsMs: 1, safeMessage: 'skip' }] } } as unknown as SnapshotBundle;

describe('handleDecisions', () => {
  it('returns decisions for a run', () => {
    expect(handleDecisions(bundle, 'r1', 100).items).toHaveLength(1);
  });
});
```

`test/ops/health.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handleRuntimeHealth, handleMarketHealth, handleExecutionHealth } from '../../src/ops/handlers/health.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  runtimeHealth: { entries: [{ source: 'long_oi', status: 'ok',
    indicators: { ready: true, freshnessOk: true, pipelineOk: true, serviceOk: true, botOk: true },
    availability: 'available', capturedAtMs: 1 }], asOf: 1 },
  marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: 10, availability: 'available', asOf: 1 },
  executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
} as unknown as SnapshotBundle;

describe('health handlers', () => {
  it('runtime returns a collection', () => {
    expect(handleRuntimeHealth(bundle).entries).toHaveLength(1);
  });
  it('execution idle is availability=unavailable (not an error)', () => {
    expect(handleExecutionHealth(bundle).availability).toBe('unavailable');
  });
  it('market returns availability', () => {
    expect(handleMarketHealth(bundle).availability).toBe('available');
  });
});
```

`test/ops/coverage.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handleCoverage } from '../../src/ops/handlers/coverage.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { coverage: { entries: [
  { source: 'bybit', kind: 'openInterest', state: 'present', freshnessAgeMs: 1000 },
  { source: 'bybit', kind: 'funding', state: 'unsupported', freshnessAgeMs: null },
], availability: 'available', asOf: 1 } } as unknown as SnapshotBundle;

describe('handleCoverage', () => {
  it('returns all entries with no filter', () => {
    expect(handleCoverage(bundle).entries).toHaveLength(2);
  });
  it('filters by kind, preserving present vs unsupported distinction', () => {
    const c = handleCoverage(bundle, undefined, 'funding');
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]!.state).toBe('unsupported');
  });
});
```

- [ ] **Step 5: Run all Phase-5 handler tests — Expected: PASS.**

Run: `pnpm vitest run test/ops/runs.test.ts test/ops/summary.test.ts test/ops/trades.test.ts test/ops/events.test.ts test/ops/decisions.test.ts test/ops/health.test.ts test/ops/coverage.test.ts`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ops): runs/summary/trades/events/decisions/health/coverage handlers"
```

### Task 5.5: Analysis (Tier-2) handler

**Files:**
- Create: `src/ops/handlers/analysis.ts`
- Test: `test/ops/analysis.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { handleAnalysis } from '../../src/ops/handlers/analysis.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const analysis = {
  runRef: 'r1', opsContractVersion: 'ops.4', asOf: 1, freshness: 'fresh',
  identity: { mode: 'live', strategy: { name: 's', version: '1' }, symbols: ['BTCUSDT'] },
  period: { fromMs: 1, toMs: 9 }, healthContext: 'ok',
  metrics: { pnl: '6', winRate: 50, maxDrawdown: '4', totalTrades: 2, topTradeContributionPct: 80 },
  trades: [], strategyConfig: { available: false, reason: 'not_safely_sourced' },
  dcaCount: { available: false }, slTpBeEvents: { available: false },
  features: { available: false }, summaryPatterns: [],
};
const bundle = { analysisByRun: { r1: analysis } } as unknown as SnapshotBundle;

describe('handleAnalysis', () => {
  it('returns the analysis snapshot for a known run', () => {
    const r = handleAnalysis(bundle, 'r1');
    expect(isOpsError(r)).toBe(false);
    if (isOpsError(r)) return;
    expect(r.opsContractVersion).toBe('ops.4');
    expect(r.features).toEqual({ available: false }); // capability-aware omission preserved
  });
  it('returns not_found for an unknown run', () => {
    const r = handleAnalysis(bundle, 'rX');
    expect(isOpsError(r) && r.category).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL.**

Run: `pnpm vitest run test/ops/analysis.test.ts`

- [ ] **Step 3: Write `src/ops/handlers/analysis.ts`**

```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { AnalysisSnapshot } from '../../contract/analysis/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readAnalysis } from '../../snapshot/readers/analysis.js';
import { decodeId } from '../ids.js';

export function handleAnalysis(bundle: SnapshotBundle, runIdRaw: string): AnalysisSnapshot | OpsError {
  let runId: string;
  try { runId = decodeId('run', runIdRaw); }
  catch { return { category: 'validation_error', code: 'invalid_run_id', message: 'invalid run id' }; }
  const a = readAnalysis(bundle, runId);
  if (!a) return { category: 'not_found', code: 'run_not_found', message: 'run not found' };
  return a; // capability-aware omission is already encoded in the snapshot; never fabricate here
}
```

- [ ] **Step 4: Run it — Expected: PASS.**

Run: `pnpm vitest run test/ops/analysis.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ops): tier-2 analysis handler (capability-aware, never fabricates)"
```

---

## Phase 6 — WS replay (Surface A)

### Task 6.1: Deterministic replay sequence

**Files:**
- Create: `src/events/replay.ts`
- Test: `test/events/replay.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildReplaySequence } from '../../src/events/replay.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [{ runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
    startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] }],
  runtimeHealth: { entries: [], asOf: 1 },
  replay: { frames: [
    { offsetMs: 0, resource: 'runs' },
    { offsetMs: 1000, resource: 'runtime-health' },
    { offsetMs: 2000, resource: 'runs' },
  ] },
} as unknown as SnapshotBundle;

describe('buildReplaySequence', () => {
  it('is deterministic: same bundle+speed → identical ordered LiveUpdate sequence', () => {
    const a = buildReplaySequence(bundle, 1);
    const b = buildReplaySequence(bundle, 1);
    expect(a).toEqual(b);
    expect(a.map((f) => f.resource)).toEqual(['runs', 'runtime-health', 'runs']);
    expect(a[0]!.update.resource).toBe('runs');
    expect(typeof a[0]!.update.asOf).toBe('number');
  });
  it('scales delay by speed', () => {
    const fast = buildReplaySequence(bundle, 2);
    expect(fast[1]!.delayMs).toBe(500); // 1000ms / speed 2
    expect(fast[2]!.delayMs).toBe(500); // 2000-1000 = 1000ms / 2
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL.**

Run: `pnpm vitest run test/events/replay.test.ts`

- [ ] **Step 3: Write `src/events/replay.ts`**

```ts
import type { SnapshotBundle, ReplayFrame } from '../contract/snapshot/bundle.js';
import { handleRuns } from '../ops/handlers/runs.js';
import { handleRuntimeHealth } from '../ops/handlers/health.js';

/** Mirrors trading-platform OperationsSubscriptionService LiveUpdate. */
export interface LiveUpdate {
  readonly resource: 'runs' | 'runtime-health';
  readonly payload: unknown;
  readonly asOf: number;
}
export interface ReplayStep {
  readonly resource: ReplayFrame['resource'];
  readonly delayMs: number;    // time to wait BEFORE emitting this step (already speed-scaled)
  readonly update: LiveUpdate;
}

function projectionFor(bundle: SnapshotBundle, resource: ReplayFrame['resource'], asOf: number): LiveUpdate {
  if (resource === 'runs') return { resource, payload: handleRuns(bundle, {}, asOf), asOf };
  return { resource, payload: handleRuntimeHealth(bundle), asOf };
}

/** Pure, deterministic: the ordered steps for one pass through the snapshot's replay frames. */
export function buildReplaySequence(bundle: SnapshotBundle, speed: number): readonly ReplayStep[] {
  const frames = [...bundle.replay.frames].sort((a, b) => a.offsetMs - b.offsetMs);
  let prevOffset = 0;
  return frames.map((frame) => {
    const delayMs = Math.max(0, frame.offsetMs - prevOffset) / speed;
    prevOffset = frame.offsetMs;
    return { resource: frame.resource, delayMs, update: projectionFor(bundle, frame.resource, frame.offsetMs) };
  });
}
```

- [ ] **Step 4: Run it — Expected: PASS.**

Run: `pnpm vitest run test/events/replay.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(events): deterministic WS replay sequence (once/loop/speed)"
```

### Task 6.2: WS adapter (drives the sequence over a socket)

**Files:**
- Create: `src/events/ws-adapter.ts`

> This is thin glue around `buildReplaySequence` + `@hono/node-ws`. It is exercised end-to-end in the HTTP app test (Task 7.2 / Phase 8), so it has no separate unit test — keep it free of logic worth testing in isolation.

- [ ] **Step 1: Create `src/events/ws-adapter.ts`**

```ts
import type { WSContext } from 'hono/ws';
import type { SnapshotBundle } from '../contract/snapshot/bundle.js';
import { buildReplaySequence } from './replay.js';

export interface ReplayOptions { mode: 'once' | 'loop'; speed: number; }

/** Streams the deterministic replay sequence to one websocket. Read-only: inbound is ignored. */
export function startReplay(ws: WSContext, bundle: SnapshotBundle, opts: ReplayOptions): () => void {
  let cancelled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const runPass = async (): Promise<void> => {
    const steps = buildReplaySequence(bundle, opts.speed);
    for (const step of steps) {
      if (cancelled) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { timers.delete(t); resolve(); }, step.delayMs);
        timers.add(t);
      });
      if (cancelled) return;
      ws.send(JSON.stringify(step.update));
    }
    if (!cancelled && opts.mode === 'loop') await runPass();
  };

  void runPass();
  return () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add -A && git commit -m "feat(events): websocket replay adapter (read-only, no command channel)"
```

---

## Phase 7 — Research Read seam (Surface B)

### Task 7.1: Research-read capability + adapter (snapshot → DTO projection; no transport)

**Files:**
- Create: `src/research-read/capabilities.ts`, `src/research-read/adapter.ts`
- Test: `test/research-read/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { researchCapabilities } from '../../src/research-read/capabilities.js';
import { listResults, getResult } from '../../src/research-read/adapter.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  researchByRun: {
    r1: {
      summary: { runRef: 'r1', mode: 'paper',
        metrics: { netPnlUsd: '6', winRate: 50, maxDrawdownPct: '4', sharpe: { available: false }, totalTrades: 2 },
        asOf: 1 },
      trades: [], decisions: [], analysisContext: 'ok',
    },
  },
} as unknown as SnapshotBundle;

describe('research-read seam', () => {
  it('capability descriptor marks mutation + backtest unavailable with the migration reason', () => {
    const cap = researchCapabilities();
    expect(cap.capabilities).toEqual({ read: true, mutation: false, backtestSubmission: false, backtestResults: false });
    expect(cap.note).toBe('backtesting_moved_to_trading_backtester');
  });
  it('projects a research run result from the snapshot', () => {
    const r = getResult(bundle, 'r1');
    expect(r?.summary.metrics.netPnlUsd).toBe('6');
  });
  it('lists results', () => {
    expect(listResults(bundle)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL.**

Run: `pnpm vitest run test/research-read/adapter.test.ts`

- [ ] **Step 3: Write `src/research-read/capabilities.ts`**

```ts
import type { ResearchCapabilityDescriptor } from '../contract/research-read/dto.js';
import { RESEARCH_READ_CONTRACT_VERSION } from '../contract/research-read/version.js';

export function researchCapabilities(): ResearchCapabilityDescriptor {
  return {
    researchReadContractVersion: RESEARCH_READ_CONTRACT_VERSION,
    capabilities: { read: true, mutation: false, backtestSubmission: false, backtestResults: false },
    note: 'backtesting_moved_to_trading_backtester',
  };
}
```

- [ ] **Step 4: Write `src/research-read/adapter.ts`**

```ts
import type { SnapshotBundle } from '../contract/snapshot/bundle.js';
import type { ResearchRunResult } from '../contract/research-read/dto.js';
import { readResearchResult, listResearchResults } from '../snapshot/readers/research.js';

/** Surface B is READ-ONLY and transport-agnostic in this feature: a future src/mcp or HTTP adapter
 *  drives these functions. No mutating/backtest entry points exist. */
export function getResult(bundle: SnapshotBundle, runId: string): ResearchRunResult | undefined {
  return readResearchResult(bundle, runId);
}
export function listResults(bundle: SnapshotBundle): readonly ResearchRunResult[] {
  return listResearchResults(bundle);
}
```

- [ ] **Step 5: Run it — Expected: PASS.**

Run: `pnpm vitest run test/research-read/adapter.test.ts`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(research-read): seam — read-only adapter + capability (backtest unavailable, no transport)"
```

---

## Phase 8 — HTTP app wiring + entrypoint

### Task 8.1: Hono app (routes + auth middleware + WS upgrade)

**Files:**
- Create: `src/http/app.ts`
- Test: `test/http/app.test.ts`

- [ ] **Step 1: Write the failing test** (drives the app via `app.request`, the Hono test entry)

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';

const snap = {
  dir: '.', manifest: { ref: 't', createdAtMs: 1, bundleRef: 'b', checksumsRef: 'c',
    versions: { snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.3',
      researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
      exporterVersion: 'e', sourcePlatformCommit: 'x', redactionPolicyVersion: 'r' } },
  bundle: {
    runs: [{ runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] }],
    tradesByRun: { r1: [] }, eventsByRun: {}, decisionsByRun: {},
    runtimeHealth: { entries: [], asOf: 1 },
    marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
    executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
    coverage: { entries: [], availability: 'available', asOf: 1 },
    analysisByRun: {}, researchByRun: {}, replay: { frames: [] },
  },
} as unknown as LoadedSnapshot;

function makeApp(tokens: string[] = []) {
  return createApp({ snapshot: snap, tokenAllowlist: tokens, replay: { mode: 'once', speed: 1 } }).app;
}

describe('ops read http app', () => {
  it('GET /ops/discover returns ops.3 200 (reachability for office)', async () => {
    const res = await makeApp().request('/ops/discover');
    expect(res.status).toBe(200);
    expect((await res.json() as { opsContractVersion: string }).opsContractVersion).toBe('ops.3');
  });
  it('GET /ops/runs?mode=live returns a page with strategy.name present', async () => {
    const res = await makeApp().request('/ops/runs?mode=live');
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ strategy: { name: string } }> };
    expect(body.items[0]!.strategy.name).toBe('s');
  });
  it('GET /ops/runs/:id/summary on unknown run returns 404', async () => {
    const res = await makeApp().request('/ops/runs/rX/summary');
    expect(res.status).toBe(404);
  });
  it('rejects requests without a token when an allowlist is configured (401)', async () => {
    const res = await makeApp(['deadbeef']).request('/ops/runs');
    expect(res.status).toBe(401);
  });
  it('rejects POST (read-only surface)', async () => {
    const res = await makeApp().request('/ops/runs', { method: 'POST' });
    expect(res.status).toBe(404); // no POST route registered
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL.**

Run: `pnpm vitest run test/http/app.test.ts`

- [ ] **Step 3: Write `src/http/app.ts`**

```ts
import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { LoadedSnapshot } from '../snapshot/loader.js';
import { authorize, bearerFromHeader } from '../access/auth.js';
import { auditLog } from '../access/audit.js';
import { isOpsError, type OpsError } from '../contract/common/errors.js';
import { buildDiscover } from '../ops/handlers/discover.js';
import { handleRuns } from '../ops/handlers/runs.js';
import { handleSummary } from '../ops/handlers/summary.js';
import { handleTrades } from '../ops/handlers/trades.js';
import { handleEvents } from '../ops/handlers/events.js';
import { handleDecisions } from '../ops/handlers/decisions.js';
import { handleRuntimeHealth, handleMarketHealth, handleExecutionHealth } from '../ops/handlers/health.js';
import { handleCoverage } from '../ops/handlers/coverage.js';
import { handleAnalysis } from '../ops/handlers/analysis.js';
import { startReplay } from '../events/ws-adapter.js';

export interface AppDeps {
  readonly snapshot: LoadedSnapshot;
  readonly tokenAllowlist: readonly string[];
  readonly replay: { mode: 'once' | 'loop'; speed: number };
}

function httpStatus(e: OpsError): number {
  if (e.category === 'not_found') return 404;
  if (e.category === 'internal_read_error') return 500;
  return 400;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const bundle = deps.snapshot.bundle;
  const now = () => Date.now();

  // Auth middleware on /ops/* (HTTP). Empty allowlist = loopback-trusted.
  app.use('/ops/*', async (c, next) => {
    const auth = authorize(deps.tokenAllowlist, bearerFromHeader(c.req.header('authorization')));
    auditLog({ tsMs: now(), subject: auth.subject ?? 'anonymous', resource: c.req.path, outcome: auth.ok ? 'accepted' : 'rejected' });
    if (!auth.ok) {
      return c.json({ category: 'validation_error', code: 'unauthorized', message: 'authentication required' }, 401);
    }
    await next();
  });

  const respond = (c: Parameters<Parameters<typeof app.get>[1]>[0], result: unknown) =>
    isOpsError(result) ? c.json(result, httpStatus(result)) : c.json(result as object, 200);

  app.get('/ops/discover', (c) => c.json(buildDiscover(), 200));
  app.get('/ops/runs', (c) => c.json(handleRuns(bundle,
    { mode: c.req.query('mode'), status: c.req.query('status'), symbol: c.req.query('symbol') },
    now(), c.req.query('cursor')), 200));
  app.get('/ops/runs/:runId/summary', (c) => respond(c, handleSummary(bundle, c.req.param('runId'), now())));
  app.get('/ops/runs/:runId/analysis', (c) => respond(c, handleAnalysis(bundle, c.req.param('runId'))));
  app.get('/ops/trades', (c) => c.json(handleTrades(bundle, c.req.query('runId') ?? '', now(), c.req.query('cursor')), 200));
  app.get('/ops/events', (c) => c.json(handleEvents(bundle, c.req.query('runId') ?? '', now(), c.req.query('cursor')), 200));
  app.get('/ops/decisions', (c) => c.json(handleDecisions(bundle, c.req.query('runId') ?? '', now(), c.req.query('cursor')), 200));
  app.get('/ops/health/runtime', (c) => c.json(handleRuntimeHealth(bundle), 200));
  app.get('/ops/health/market', (c) => c.json(handleMarketHealth(bundle), 200));
  app.get('/ops/health/execution', (c) => c.json(handleExecutionHealth(bundle), 200));
  app.get('/ops/coverage', (c) => c.json(handleCoverage(bundle, c.req.query('source'), c.req.query('kind')), 200));

  // WS replay shares the /ops/events path (GET → list; upgrade → stream). Read-only: inbound ignored.
  app.get('/ops/events', upgradeWebSocket(() => {
    let stop: (() => void) | null = null;
    return {
      onOpen: (_evt, ws) => { stop = startReplay(ws, bundle, deps.replay); },
      onClose: () => { stop?.(); },
    };
  }));

  return { app, injectWebSocket };
}
```

> NOTE: `/ops/events` is registered twice (HTTP GET list handler AND the WS upgrade). Hono dispatches the upgrade only for WebSocket requests; a plain GET hits the list handler. Keep both registrations.

- [ ] **Step 4: Run it — Expected: PASS.**

Run: `pnpm vitest run test/http/app.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(http): Hono app — ops read routes + auth middleware + WS replay upgrade"
```

### Task 8.2: Entrypoint

**Files:**
- Create: `src/bin/start-mock-ops.ts`

- [ ] **Step 1: Create `src/bin/start-mock-ops.ts`**

```ts
import { serve } from '@hono/node-server';
import { loadMockConfig } from '../access/config.js';
import { openSnapshot } from '../snapshot/registry.js';
import { createApp } from '../http/app.js';

function main(): void {
  const cfg = loadMockConfig(process.env);
  const snapshot = openSnapshot(cfg.snapshotDir, cfg.snapshotRef);
  const { app, injectWebSocket } = createApp({
    snapshot,
    tokenAllowlist: cfg.tokenAllowlist,
    replay: { mode: cfg.replayMode, speed: cfg.replaySpeed },
  });
  const server = serve({ fetch: app.fetch, hostname: cfg.bind, port: cfg.port }, (info) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      kind: 'startup', bind: cfg.bind, port: info.port,
      snapshotRef: cfg.snapshotRef, opsContractVersion: snapshot.manifest.versions.opsReadContractVersion,
      authRequired: cfg.tokenAllowlist.length > 0,
    }));
  });
  injectWebSocket(server);
}

main();
```

- [ ] **Step 2: Typecheck + smoke-run against the fixture (fixture exists after Phase 9; run this step then)**

Run: `pnpm typecheck`
Then (after Task 9.1): `MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic pnpm dev` → in another shell `curl -s localhost:8839/ops/discover | head -c 200` → expect JSON with `"opsContractVersion":"ops.3"`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(bin): start-mock-ops entrypoint (loopback default, WS injected)"
```

---

## Phase 9 — Synthetic fixture + conformance

### Task 9.1: Tiny synthetic fixture (committed to git)

**Files:**
- Create: `data/snapshots/.gitkeep`, `data/snapshots/fixtures/2026-06-16-synthetic/ops/bundle.json`, `.../checksums.json`, `.../manifest.json`

> The fixture must satisfy the documented fixture floor as far as a *synthetic* sample safely can: ≥2 runs, live + paper, ≥1 winning and ≥1 losing closed trade, one analysis snapshot with rich fields marked `{available:false}` (capability-aware), coverage showing `present` vs `unsupported`.

- [ ] **Step 1: Create `data/snapshots/.gitkeep`** (empty file)

- [ ] **Step 2: Create `data/snapshots/fixtures/2026-06-16-synthetic/ops/bundle.json`**

```json
{
  "runs": [
    { "runId": "run_live_001", "mode": "live", "status": "running",
      "strategy": { "name": "long_oi", "version": "1.0.0" },
      "startedAtMs": 1718500000000, "finishedAtMs": null, "lastSeenMs": 1718503600000, "symbols": ["BTCUSDT"] },
    { "runId": "run_paper_002", "mode": "paper", "status": "finished",
      "strategy": { "name": "short_oi", "version": "1.0.0" },
      "startedAtMs": 1718400000000, "finishedAtMs": 1718486400000, "lastSeenMs": 1718486400000, "symbols": ["ETHUSDT"] }
  ],
  "tradesByRun": {
    "run_paper_002": [
      { "tradeId": "trade_win_01", "runId": "run_paper_002", "symbol": "ETHUSDT", "side": "long",
        "openedAtMs": 1718410000000, "closedAtMs": 1718420000000, "realizedPnl": "42.50000000",
        "pnlPct": "2.10", "isWin": true, "closeReason": "tp" },
      { "tradeId": "trade_loss_01", "runId": "run_paper_002", "symbol": "ETHUSDT", "side": "short",
        "openedAtMs": 1718430000000, "closedAtMs": 1718440000000, "realizedPnl": "-18.25000000",
        "pnlPct": "-0.90", "isWin": false, "closeReason": "sl" }
    ]
  },
  "eventsByRun": {
    "run_paper_002": [
      { "category": "run_started", "severity": "info", "runId": "run_paper_002", "tradeId": null,
        "tsMs": 1718400000000, "safeMessage": "paper run started" },
      { "category": "run_finished", "severity": "info", "runId": "run_paper_002", "tradeId": null,
        "tsMs": 1718486400000, "safeMessage": "paper run finished" }
    ]
  },
  "decisionsByRun": {
    "run_paper_002": [
      { "category": "no_entry", "runId": "run_paper_002", "botId": "short_oi", "symbol": "ETHUSDT",
        "side": "short", "reason": "oi_flat", "tsMs": 1718405000000, "safeMessage": "skip: OI not rising" }
    ]
  },
  "runtimeHealth": {
    "entries": [
      { "source": "long_oi", "status": "ok",
        "indicators": { "ready": true, "freshnessOk": true, "pipelineOk": true, "serviceOk": true, "botOk": true },
        "availability": "available", "capturedAtMs": 1718503600000 }
    ],
    "asOf": 1718503600000
  },
  "marketHealth": { "status": "ok", "diagnostics": { "symbolsTracked": 2 }, "streamAgeMs": 1200, "availability": "available", "asOf": 1718503600000 },
  "executionHealth": { "status": "ok", "recentCounts": {}, "lastEventMs": null, "availability": "unavailable", "asOf": 1718503600000 },
  "coverage": {
    "entries": [
      { "source": "bybit", "kind": "openInterest", "state": "present", "freshnessAgeMs": 1500 },
      { "source": "bybit", "kind": "liquidations", "state": "present", "freshnessAgeMs": 2000 },
      { "source": "bybit", "kind": "funding", "state": "unsupported", "freshnessAgeMs": null }
    ],
    "availability": "available", "asOf": 1718503600000
  },
  "analysisByRun": {
    "run_paper_002": {
      "runRef": "run_paper_002", "opsContractVersion": "ops.4", "asOf": 1718503600000, "freshness": "fresh",
      "identity": { "mode": "paper", "strategy": { "name": "short_oi", "version": "1.0.0" }, "symbols": ["ETHUSDT"] },
      "period": { "fromMs": 1718400000000, "toMs": 1718486400000 },
      "healthContext": "runtime ok during window",
      "metrics": { "pnl": "24.25000000", "winRate": 50, "maxDrawdown": "18.25000000", "totalTrades": 2, "profitFactor": "2.33", "topTradeContributionPct": 100 },
      "trades": [
        { "tradeId": "trade_win_01", "symbol": "ETHUSDT", "side": "long", "openedAtMs": 1718410000000, "closedAtMs": 1718420000000, "realizedPnl": "42.50000000", "entryReason": "oi_breakout", "exitReason": "tp" },
        { "tradeId": "trade_loss_01", "symbol": "ETHUSDT", "side": "short", "openedAtMs": 1718430000000, "closedAtMs": 1718440000000, "realizedPnl": "-18.25000000", "entryReason": "oi_breakout", "exitReason": "sl" }
      ],
      "strategyConfig": { "available": false, "reason": "not_in_sanitized_export" },
      "dcaCount": { "available": false, "reason": "not_safely_sourced" },
      "slTpBeEvents": { "available": false, "reason": "not_safely_sourced" },
      "features": { "available": false, "reason": "market_features_out_of_scope_in_001" },
      "summaryPatterns": ["one winning TP, one losing SL"]
    }
  },
  "researchByRun": {
    "run_paper_002": {
      "summary": { "runRef": "run_paper_002", "mode": "paper",
        "metrics": { "netPnlUsd": "24.25000000", "winRate": 50, "maxDrawdownPct": "0.90", "profitFactor": "2.33", "sharpe": { "available": false, "reason": "insufficient_sample" }, "totalTrades": 2 },
        "asOf": 1718503600000 },
      "trades": [
        { "tradeId": "trade_win_01", "symbol": "ETHUSDT", "side": "long", "openedAtMs": 1718410000000, "closedAtMs": 1718420000000, "realizedPnl": "42.50000000" },
        { "tradeId": "trade_loss_01", "symbol": "ETHUSDT", "side": "short", "openedAtMs": 1718430000000, "closedAtMs": 1718440000000, "realizedPnl": "-18.25000000" }
      ],
      "decisions": [
        { "category": "no_entry", "symbol": "ETHUSDT", "reason": "oi_flat", "tsMs": 1718405000000 }
      ],
      "analysisContext": "paper run, OI strategy, 2 trades"
    }
  },
  "replay": { "frames": [
    { "offsetMs": 0, "resource": "runs" },
    { "offsetMs": 1000, "resource": "runtime-health" },
    { "offsetMs": 2000, "resource": "runs" }
  ] }
}
```

- [ ] **Step 3: Generate `checksums.json` and `manifest.json`**

Run (computes the bundle's sha256 and writes both files):
```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = "data/snapshots/fixtures/2026-06-16-synthetic";
const buf = readFileSync(`${dir}/ops/bundle.json`);
const hex = createHash("sha256").update(buf).digest("hex");
writeFileSync(`${dir}/checksums.json`, JSON.stringify({ "ops/bundle.json": hex }, null, 2) + "\n");
writeFileSync(`${dir}/manifest.json`, JSON.stringify({
  ref: "2026-06-16-synthetic", createdAtMs: 1718503600000,
  bundleRef: "ops/bundle.json", checksumsRef: "checksums.json",
  versions: { snapshotSchemaVersion: "snapshot.1", opsReadContractVersion: "ops.3",
    researchReadContractVersion: "research.1", analysisContractVersion: "ops.4",
    exporterVersion: "synthetic.1", sourcePlatformCommit: "synthetic", redactionPolicyVersion: "redact.1" } }, null, 2) + "\n");
console.log("wrote", hex);
'
```

- [ ] **Step 4: Verify the fixture loads**

Run: `node --input-type=module -e 'import("./dist/src/snapshot/loader.js").then(m => { const s = m.loadSnapshot("data/snapshots/fixtures/2026-06-16-synthetic"); console.log(s.bundle.runs.length, "runs"); })'`
(First `pnpm build`.) Expected: `2 runs`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(fixture): tiny synthetic snapshot (2 runs live+paper, win+loss, capability-aware analysis)"
```

### Task 9.2: Golden conformance test (end-to-end over the fixture)

**Files:**
- Test: `test/conformance/golden.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { openSnapshot } from '../../src/snapshot/registry.js';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';

let snap: LoadedSnapshot;
beforeAll(() => { snap = openSnapshot('data/snapshots', 'fixtures/2026-06-16-synthetic'); });
const app = () => createApp({ snapshot: snap, tokenAllowlist: [], replay: { mode: 'once', speed: 1 } }).app;

describe('golden conformance over the synthetic fixture', () => {
  it('office happy path: /ops/runs?mode=live items each carry strategy.name + numeric *Ms', async () => {
    const res = await app().request('/ops/runs?mode=live');
    const body = await res.json() as { items: Array<{ strategy: { name: string }; startedAtMs: number; lastSeenMs: number }> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const r of body.items) {
      expect(typeof r.strategy.name).toBe('string');
      expect(Number.isFinite(r.startedAtMs)).toBe(true);
      expect(Number.isFinite(r.lastSeenMs)).toBe(true);
    }
  });
  it('coverage preserves present vs unsupported', async () => {
    const res = await app().request('/ops/coverage');
    const body = await res.json() as { entries: Array<{ kind: string; state: string }> };
    expect(body.entries.find((e) => e.kind === 'funding')!.state).toBe('unsupported');
  });
  it('analysis is capability-aware: features omitted as {available:false}', async () => {
    const res = await app().request('/ops/runs/run_paper_002/analysis');
    const body = await res.json() as { features: { available: boolean } };
    expect(body.features.available).toBe(false);
  });
  it('summary aggregates the win + loss correctly', async () => {
    const res = await app().request('/ops/runs/run_paper_002/summary');
    const body = await res.json() as { wins: number; losses: number; pnlUsd: string };
    expect(body.wins).toBe(1);
    expect(body.losses).toBe(1);
    expect(body.pnlUsd).toBe('24.25000000');
  });
});
```

- [ ] **Step 2: Run it — Expected: PASS.**

Run: `pnpm vitest run test/conformance/golden.test.ts`

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(conformance): golden end-to-end checks over the synthetic fixture"
```

---

## Phase 10 — Docker + docs

### Task 10.1: Dockerfile + compose (no private-platform dependency)

**Files:**
- Create: `Dockerfile`, `docker-compose.mock.yml`, `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```dockerignore
node_modules
dist
.git
*.log
/data/snapshots/*
!/data/snapshots/fixtures
```

- [ ] **Step 2: Create `Dockerfile`** (build context = this repo only; no `file:` deps, no private registry, no GitHub auth)

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
COPY --from=build /app/dist ./dist
# bake the synthetic fixture for default/demo; real snapshots are mounted at runtime
COPY data/snapshots/fixtures ./data/snapshots/fixtures
ENV MOCK_OPS_BIND=0.0.0.0 MOCK_OPS_PORT=8839
EXPOSE 8839
# NOTE: with a non-loopback bind, MOCK_OPS_TOKENS is REQUIRED (fail-closed) — set it in compose/run.
CMD ["node", "dist/src/bin/start-mock-ops.js"]
```

- [ ] **Step 3: Create `docker-compose.mock.yml`**

```yaml
# Demo profile: office runs against trading-mock-platform with NO private trading-platform build.
services:
  trading-mock-platform:
    build: .
    image: trading-mock-platform:dev
    environment:
      MOCK_OPS_BIND: "0.0.0.0"
      MOCK_OPS_PORT: "8839"
      MOCK_OPS_TOKENS: "${MOCK_OPS_TOKENS:?set MOCK_OPS_TOKENS to a sha256-hex of your demo token}"
      MOCK_SNAPSHOT_REF: "fixtures/2026-06-16-synthetic"
      MOCK_REPLAY_MODE: "loop"
      MOCK_REPLAY_SPEED: "1"
    # mount real sanitized snapshots here in non-demo use (kept out of git/image):
    # volumes:
    #   - ./data/snapshots/real:/app/data/snapshots/real:ro
    ports:
      - "8839:8839"

  # trading-office points at the mock purely via env (no code change, no platform build):
  #   OFFICE_CONNECTOR_MODE=trading-lab
  #   OFFICE_PLATFORM_ENABLED=true
  #   TRADING_PLATFORM_READ_URL=http://trading-mock-platform:8839
  #   TRADING_PLATFORM_READ_TOKEN=<the raw demo token whose sha256 is in MOCK_OPS_TOKENS>
```

- [ ] **Step 4: Build the image (verify no private dependency)**

Run: `docker build -t trading-mock-platform:dev .`
Expected: build succeeds with only public npm deps; no prompt for GitHub/private-registry auth.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(docker): self-contained image + mock compose profile (no private-platform build)"
```

### Task 10.2: README + CLAUDE.md update + safety/contract docs

**Files:**
- Create: `README.md`, `docs/contracts/snapshot-format.md`, `docs/contracts/sanitization-policy.md`, `docs/contracts/future-historical.md`
- Modify: `CLAUDE.md` (append a "What this repo is" section consistent with the framing rule)

- [ ] **Step 1: Create `README.md`**

```markdown
# trading-mock-platform

Standalone, read-only, snapshot-backed mock of the **read surfaces** of the private `trading-platform`.
Lets `trading-office` (and, in a later increment, `trading-lab`) run in demo/course/research environments
without the private live platform, exchanges, credentials, prod DB, or VPS.

## Surfaces
- **Surface A — Ops Read** (consumer: trading-office): HTTP GET (`ops.3` parity) + WS `/ops/events` replay,
  plus Tier-2 `/ops/runs/:id/analysis` (`ops.4`, capability-aware).
- **Surface B — Research Read** (consumer: trading-lab): contract + snapshot→DTO adapter + read-only
  capability descriptor. Transport (MCP/HTTP) is a future increment — this feature ships the seam only.

It does NOT execute or simulate trading or backtesting, hold credentials, reach an exchange/prod DB, or
ingest live data. Backtest/hypothesis execution belongs to the future separate `trading-backtester`.

## Run
```bash
cp .env.example .env
pnpm install && pnpm build
MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic pnpm start
curl -s localhost:8839/ops/discover
```

## Point trading-office at the mock (no code change)
```
OFFICE_CONNECTOR_MODE=trading-lab
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://localhost:8839
TRADING_PLATFORM_READ_TOKEN=<non-empty>
```

## Consumers (framing)
- trading-office = direct Ops Read HTTP consumer.
- trading-lab = platform bot-results/research-read consumer via the current SDK/MCP path (mock integration deferred here).
- trading-backtester = future separate executor for hypothesis/backtest lifecycle.

## Safety
Read-only; sha256-hashed token allowlist; loopback by default; fail-closed if bound non-loopback without a token.
Snapshots are verified on load (manifest + checksums + version-compat + secret-scan). The exporter/sanitizer
runs operator-side near the private platform and is out of scope here — see `docs/contracts/`.
```

- [ ] **Step 2: Create `docs/contracts/snapshot-format.md`** — document the `SnapshotManifest` + `SnapshotBundle` shapes (the contract the operator-side exporter must produce), the versions block, and the fixture floor (≥2 runs; live+paper; ≥1 win + ≥1 loss; DCA/SL/TP/BE + OI/liquidation features where safely sourced else `{available:false}`; raw exports never in git).

- [ ] **Step 3: Create `docs/contracts/sanitization-policy.md`** — document the two-layer model: (1) operator-side allowlist/default-deny projection (what fields may exist), (2) runtime defense-in-depth (`src/safety/secret-scan.ts`) blocklist patterns + fail-closed. Enumerate forbidden content: credentials, DB schema, exchange internals, host paths, account ids, raw order/execution ids, tokens, prod infra.

- [ ] **Step 4: Create `docs/contracts/future-historical.md`** — record (DESIGN ONLY, do not implement) the future backtester seam: `GET /historical/discover`, dataset request/export lifecycle, async job boundary; backtester stores its own lifecycle/results; the mock never executes backtests. Note the contract layer is isolated so a `/historical/*` adapter can be added without touching Ops Read.

- [ ] **Step 5: Append to `CLAUDE.md`**

```markdown

## What this repo is (do not drift)
trading-mock-platform mirrors the READ surfaces of the private trading-platform from sanitized snapshots.
- It MUST NOT import private platform runtime/core/db/execution/exchange/config, nor require the private
  repo/package/GitHub auth at Docker build/run.
- `src/contract/**` is import-clean and extractable (guard: `pnpm verify:contract-isolation`).
- Two surfaces from one snapshot: Ops Read (office, HTTP/WS) and Research Read (lab, seam only here).
- No backtesting is implemented or faked; backtest tools are `unavailable` (reason
  `backtesting_moved_to_trading_backtester`). Execution belongs to the future trading-backtester.
- Framing: office = Ops Read consumer; lab = research-read consumer (integration deferred); backtester = future.
```

- [ ] **Step 6: Final check + commit**

Run: `pnpm check` (typecheck + contract-isolation + full test suite)
Expected: all green.

```bash
git add -A && git commit -m "docs: README, CLAUDE.md guardrails, snapshot/sanitization/future-historical contracts"
```

---

## Self-Review

**1. Spec coverage** — mapping each requirement to a task:
- Standalone boundary, no npm import from platform → Tasks 0, 1.7 (isolation guard), 10.1 (Docker independence).
- Snapshot-backed storage + registry/loader + tiny fixture → Tasks 2.1–2.4, 9.1.
- Ops Read HTTP endpoints (P0+P1-lite) → Tasks 5.3–5.5, 8.1.
- Rich analysis (Tier-2, capability-aware) → Tasks 1.3, 5.5, 9.1.
- WS replay (once/loop/speed, deterministic, runs+runtime-health) → Tasks 6.1–6.2, 8.1.
- Safety/privacy (read-only, no creds/DB/exchange, fail-closed, audit, sanitization, manifest/checksums) → Tasks 2.1–2.3, 3.1, 4.1–4.2, 8.1, 10.2.
- Research Read seam (Surface B, mutating/backtest unavailable) → Tasks 1.4, 7.1.
- Contract versioning (7 versions, fail-closed on unsupported) → Tasks 1.5, 2.2.
- Docker: office/lab run against mock without private build → Tasks 10.1, 10.2.
- Future backtester boundary (seam only) → Task 10.2 (`future-historical.md`).
- Out of scope honored: no exporter code, no backtesting, no positions/state/log-refs/candidates, no parquet/market-bar ingestion → reflected by their absence + docs.

**2. Placeholder scan** — Tasks 10.2 Steps 2–4 describe doc files by content outline rather than full prose; that is acceptable for prose docs but each lists exactly what must be written. All *code* steps contain complete code. No `TODO`/"add error handling"/"similar to Task N" in code steps.

**3. Type consistency** — `SnapshotBundle` field names (`tradesByRun`, `eventsByRun`, `decisionsByRun`, `analysisByRun`, `researchByRun`, `runtimeHealth`, `marketHealth`, `executionHealth`, `coverage`, `replay.frames`) are used identically across readers (2.4), handlers (5.4–5.5), replay (6.1), fixture (9.1), and tests. `LiveUpdate`/`ReplayStep`, `MockConfig`, `AuthResult`, `OpsError`, `PageEnvelope`, `AnalysisSnapshot`/`Capable`/`CapabilityAbsent`, `ResearchCapabilityDescriptor` are each defined once and reused by exact name. Handler names (`handleRuns`/`handleSummary`/`handleTrades`/`handleEvents`/`handleDecisions`/`handleRuntimeHealth`/`handleMarketHealth`/`handleExecutionHealth`/`handleCoverage`/`handleAnalysis`) match between definitions, the app (8.1), and tests.

**Ordering note for executors:** Task 2.3 (loader) imports `src/safety/secret-scan.ts` from Task 3.1. Implement **Phase 3 Task 3.1 before Phase 2 Task 2.3** (or land the loader with a no-op `scanForSecrets` and wire the real one in 3.1). All other tasks are in dependency order.
