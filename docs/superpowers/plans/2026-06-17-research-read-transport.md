# Live Surface B Transport (feature 003) Implementation Plan

> **For agentic workers:** Implement this plan task-by-task using the project's installed execution workflow. Each task is TDD (write the failing test → run it red → implement the minimum → run it green → commit). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone **stdio MCP gateway** that speaks lab's MCP-031 research contract over `@modelcontextprotocol/sdk`, projecting the sanitized snapshot into the SDK's wire shapes, so `trading-lab` reads the mock through its current SDK/MCP path with zero lab-side code changes.

**Architecture:** A new stdio entrypoint registers the 8 MCP-031 tools on a low-level `Server`. READ tools (`discover_research_contract`, `list_datasets`, `get_run_status`, `get_run_result`) project from `SnapshotBundle`; MUTATING tools (`validate_module`, `submit_run`, `cancel_run`) return the SDK `{ok:false,error}` with reason `backtesting_moved_to_trading_backtester`. Contract types are hand-mirrored into an import-clean `src/contract/research-read/mcp/`. **Surface A (Ops Read HTTP/WS) is untouched.** stdout carries JSON-RPC only; all logs/audit go to stderr.

**Tech Stack:** TypeScript (ESM/NodeNext), `@modelcontextprotocol/sdk@^1.29.0` (server + client, low-level `Server` + `setRequestHandler` — no zod needed), vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-17-research-read-transport-design.md`.

**Source-of-truth facts (from lab's vendored SDK `@trading-platform/sdk@0.3.0`, read-only):**
- MCP-031 `CONTRACT_VERSION = "017.2"`; `SUPPORTED_CONTRACT_VERSIONS = ["017.1","017.2"]`.
- `METRIC_CATALOG = ["pnl","sharpe","max_drawdown","win_rate","total_trades","profit_factor","top_trade_contribution_pct"]`; `ROBUSTNESS_CATALOG = ["walk_forward","oos_split"]`.
- Lab's `assertContractCompatible` throws unless `descriptor.contractVersion === expected || descriptor.supportedContractVersions.includes(expected)` — `supportedContractVersions` **must be an array**.
- `RunResultSummary`: `comparison?` is the ONLY safely-omittable field; `validationIssues`/`coverage`/`artifactRefs` are required arrays (may be `[]`); `metrics` is a required `Record<string,number>`; `evidence{seed,contractVersion,moduleVersions}` required.
- `GatewayError{category,code,message}` — all required (lab's error constructors read all three).
- Lab's `extractToolResult` prefers `structuredContent`, else JSON-parses concatenated `content` text. The mock returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }` (reliable path; no `outputSchema` needed).
- `@modelcontextprotocol/sdk@1.29.0` server API: `Server` from `@modelcontextprotocol/sdk/server/index.js`, `setRequestHandler(ListToolsRequestSchema|CallToolRequestSchema, …)` from `@modelcontextprotocol/sdk/types.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.

---

## File Structure

```
src/contract/research-read/mcp/version.ts   # NEW — MCP-031 catalogs/versions/tool names (import-clean)
src/contract/research-read/mcp/dto.ts       # NEW — hand-mirrored MCP-031 tool I/O DTOs (import-clean)
src/research-read/mcp/errors.ts             # NEW — gatewayError + backtestUnavailable
src/research-read/mcp/projections.ts        # NEW — pure SnapshotBundle → MCP-031 projections
src/research-read/mcp/server.ts             # NEW — dispatchTool (pure) + buildResearchServer (SDK)
src/access/research-access.ts               # NEW — research token allowlist + STDERR audit
src/bin/start-research-mcp.ts               # NEW — stdio entrypoint (fail-closed startup auth, stderr logs)
package.json                                # MODIFY — add @modelcontextprotocol/sdk + start:research-mcp
scripts/verify_no_forbidden_deps.mjs        # MODIFY — add @modelcontextprotocol/sdk to the allowlist
docker-compose.mock.yml / README.md         # MODIFY — document lab GATEWAY_* wiring + MOCK_RESEARCH_TOKENS
test/research-read/mcp/{errors,projections,server}.test.ts   # NEW
test/research-read/mcp/integration.test.ts  # NEW — real stdio Client↔gateway end-to-end
```

**Invariants:** `src/contract/research-read/mcp/**` imports nothing outside `src/contract` (the contract-isolation guard covers it — pure types). The SDK is imported only in `server.ts` + `bin/start-research-mcp.ts` + the integration test. `tsconfig` includes `src`/`test`, all run under strict settings; relative imports use `.js`.

---

## Task 1: Mirror the MCP-031 contract (import-clean)

**Files:**
- Create: `src/contract/research-read/mcp/version.ts`, `src/contract/research-read/mcp/dto.ts`

> Pure types/consts — no unit test of their own; covered by `pnpm verify:contract-isolation` + later tasks' typecheck.

- [ ] **Step 1: Create `src/contract/research-read/mcp/version.ts`**

```ts
export const MCP031_CONTRACT_VERSION = '017.2';
export const MCP031_SUPPORTED_CONTRACT_VERSIONS = ['017.1', '017.2'] as const;
export const MCP031_METRIC_CATALOG = [
  'pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct',
] as const;
export const MCP031_ROBUSTNESS_CATALOG = ['walk_forward', 'oos_split'] as const;
export const MCP031_MARKET_DATA_KINDS = ['openInterest', 'liquidations', 'funding', 'taker'] as const;
export const GATEWAY_TOOL_NAMES = [
  'discover_research_contract', 'list_datasets', 'validate_module', 'submit_run',
  'cancel_run', 'get_run_status', 'get_run_result', 'read_artifact',
] as const;
export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[number];
```

- [ ] **Step 2: Create `src/contract/research-read/mcp/dto.ts`** (verbatim mirror of the fields lab reads; `comparison?` optional, everything else required)

```ts
// --- shared ---
export type MarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker';
export type MarketDataCoverageState = 'present' | 'missing' | 'stale' | 'unsupported';
export type MarketDataAccess = 'point_in_time' | 'as_of_freshness' | 'bucket_flow';
export type RunMode = 'single' | 'baseline_variant' | 'strategy_overlay';

export interface MarketDataKindDescriptor {
  readonly kind: MarketDataKind;
  readonly access: MarketDataAccess;
  readonly coverageStates: readonly MarketDataCoverageState[];
  readonly presentZeroDistinct: boolean;
  readonly since: string;
}
export interface RunModeDescriptor {
  readonly mode: RunMode;
  readonly description: string;
}

// --- discover_research_contract ---
export interface ResearchCapabilityDescriptor {
  readonly contractVersion: string;
  readonly supportedContractVersions: readonly string[];
  readonly marketDataKinds: readonly MarketDataKindDescriptor[];
  readonly runModes: readonly RunModeDescriptor[];
  readonly metricCatalog: readonly string[];
  readonly robustnessCatalog: readonly string[];
}

// --- list_datasets ---
export interface CoveredKind {
  readonly kind: MarketDataKind;
  readonly state: MarketDataCoverageState;
}
export interface DatasetDescriptor {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly dateRange: { readonly from: string; readonly to: string };
  readonly timeframe: string;
  readonly coveredKinds: readonly CoveredKind[];
}
export interface ListDatasetsResult {
  readonly datasets: readonly DatasetDescriptor[];
}

// --- run status ---
export type NonTerminalRunStatus = 'accepted' | 'queued' | 'running';
export type TerminalRunStatus = 'completed' | 'failed' | 'canceled' | 'expired' | 'timed_out';
export type RunStatus = NonTerminalRunStatus | TerminalRunStatus;
export interface RunTimeline {
  readonly acceptedAtMs: number;
  readonly queuedAtMs?: number;
  readonly startedAtMs?: number;
  readonly terminalAtMs?: number;
}
export interface RunStatusView {
  readonly jobId: string;
  readonly runId: string;
  readonly status: RunStatus;
  readonly correlationId?: string;
  readonly workflowId?: string;
  readonly timeline: RunTimeline;
  readonly terminalCode?: string;
}

// --- errors (shared ok:false arm) ---
export type GatewayErrorCategory =
  | 'validation_error' | 'missing_dataset' | 'unsupported_data_needs'
  | 'sandbox_module_error' | 'runner_failure' | 'internal_gateway_error';
export interface GatewayError {
  readonly category: GatewayErrorCategory;
  readonly code: string;
  readonly message: string;
}
export type GatewayFailure = { readonly ok: false; readonly error: GatewayError };

export type RunStatusResult =
  | { readonly ok: true; readonly view: RunStatusView }
  | GatewayFailure;

// --- run result ---
export type RunKind = 'baseline-only' | 'baseline-vs-variant';
export type ContentHash = `sha256:${string}`;
export type ArtifactType =
  | 'run-summary' | 'metrics' | 'trades' | 'decision-records' | 'simulated-orders'
  | 'simulated-fills' | 'risk-decisions' | 'equity-curve' | 'validation-issues'
  | 'deferred-robustness' | 'sandbox-errors' | 'comparison';
export interface Ref { readonly id: string; readonly version: string }
export interface ValidationIssueDTO {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly path: string;
}
export interface ComparisonSummaryDTO {
  readonly baseline: Record<string, number>;
  readonly variant: Record<string, number>;
  readonly deltas: Record<string, number>;
}
export interface CoverageEntryDTO {
  readonly symbol: string;
  readonly kind: MarketDataKind;
  readonly state: MarketDataCoverageState;
  readonly coveredMinutes: number;
  readonly gapMinutes: number;
}
export interface ArtifactReference {
  readonly artifactId: ContentHash;
  readonly artifactType: ArtifactType;
  readonly availability: { readonly status: 'available' | 'unavailable' | 'not_applicable'; readonly reasonCode?: string };
  readonly approxItemCount?: number;
}
export interface RunResultSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly runKind: RunKind;
  readonly validationIssues: readonly ValidationIssueDTO[];
  readonly metrics: Record<string, number>;
  readonly comparison?: ComparisonSummaryDTO;
  readonly coverage: readonly CoverageEntryDTO[];
  readonly artifactRefs: readonly ArtifactReference[];
  readonly evidence: { readonly seed: number; readonly contractVersion: string; readonly moduleVersions: readonly Ref[] };
}
export type RunResultResult =
  | { readonly ok: true; readonly kind: 'summary'; readonly summary: RunResultSummary }
  | { readonly ok: true; readonly kind: 'status'; readonly view: RunStatusView }
  | GatewayFailure;

// --- mutating tool results (mock always returns the ok:false arm) ---
export interface ValidationReport {
  readonly status: 'accepted' | 'accepted_with_warnings' | 'rejected';
  readonly issues: readonly ValidationIssueDTO[];
  readonly executed: false;
}
export type ValidateModuleResult = { readonly ok: true; readonly report: ValidationReport } | GatewayFailure;
export interface RunJobHandle {
  readonly jobId: string;
  readonly runId: string;
  readonly status: 'accepted';
  readonly effectiveSeed: number;
  readonly requestFingerprint: string;
  readonly correlationId?: string;
  readonly workflowId?: string;
  readonly idempotentReplay: boolean;
}
export type SubmitRunResult = { readonly ok: true; readonly handle: RunJobHandle } | GatewayFailure;
export type CancelRunResult = { readonly ok: true; readonly view: RunStatusView } | GatewayFailure;
export interface ArtifactPage {
  readonly artifactId: ContentHash;
  readonly artifactType: string;
  readonly page: readonly unknown[];
  readonly total: number;
  readonly offset: number;
  readonly nextCursor?: string;
}
export type ReadArtifactResult = { readonly ok: true; readonly page: ArtifactPage } | GatewayFailure;
```

> **Pre-implementation verifications (LOCKED — checked against lab's vendored `@trading-platform/sdk@0.3.0` `.d.ts` + `trading-lab/src`):**
> - **`runKind` / `evidence.seed` are decode-only structural fields.** `runKind` is never branched on in `trading-lab/src` (0 usages); `evidence.seed` is never read from a result (only `evidence.contractVersion` is, in `platform-comparison.ts`). So `runKind:'baseline-only'` + `evidence.seed:0` are safe structural defaults. Lab gates on `summary.comparison !== undefined` (NOT `runKind`), so a `baseline-only` summary with `comparison` omitted is coherent — lab treats it as "no comparison" and never calls `mapPlatformComparison` on it.
> - **`metricCatalog` is a capability declaration, not a presence requirement.** No lab code cross-checks catalog keys against `summary.metrics` (which may even be `{}`). Omitting `top_trade_contribution_pct`/`sharpe` from `metrics` is safe. (The only metric enforcement is on `comparison.baseline/variant`, which the mock omits → never reached.)
> - **`read_artifact` serves backtest/research-RUN artifacts** (keyed by `submit_run`'s `runId`; all `ArtifactType` values are simulation outputs) → the mock returns `backtestUnavailable()` (Task 6), NOT a `validation_error`. Lab does not call it today.
> - **MCP protocol version:** a single `@modelcontextprotocol/sdk@1.29.0` resolves in lab's tree; `@trading-platform/sdk@0.3.0` peer-deps `^1.29.0` (optional, not bundled). The mock's `^1.29.0` server is wire-identical to lab's client — no framing drift (Task 2 pins it).

- [ ] **Step 3: Verify typecheck + isolation**

Run: `pnpm typecheck && pnpm verify:contract-isolation`
Expected: clean; `contract isolation OK` (the new `mcp/` files have no non-stdlib/escaping imports).

- [ ] **Step 4: Commit**

```bash
git add src/contract/research-read/mcp/
git commit -m "feat(contract): hand-mirror MCP-031 research gateway tool I/O types (import-clean)"
```

---

## Task 2: Add `@modelcontextprotocol/sdk` + extend the 002 dep allowlist

**Files:**
- Modify: `package.json`, `scripts/verify_no_forbidden_deps.mjs`

- [ ] **Step 1: Add the dependency + script to `package.json`**

In `dependencies` add (keeping alphabetical-ish order is fine):
```json
"@modelcontextprotocol/sdk": "^1.29.0",
```
In `scripts` add:
```json
"start:research-mcp": "node dist/src/bin/start-research-mcp.js",
```

- [ ] **Step 2: Extend the runtime allowlist in `scripts/verify_no_forbidden_deps.mjs`**

Change the allowlist line:
```js
const RUNTIME_ALLOWLIST = new Set(['hono', '@hono/node-server', '@hono/node-ws', 'ajv']);
```
to:
```js
const RUNTIME_ALLOWLIST = new Set(['hono', '@hono/node-server', '@hono/node-ws', 'ajv', '@modelcontextprotocol/sdk']);
```

- [ ] **Step 3: Install + verify the guard stays green**

Run: `pnpm install && pnpm verify:no-forbidden-deps`
Expected: install succeeds (public deps only); prints `forbidden-deps OK`.

> Risk check: the SDK pulls transitive prod deps (e.g. `zod`, `express`, `cross-spawn`). The allowlist is direct-deps-only (so transitive deps don't trip it) and none of the SDK's transitive deps are denylisted (`trading-platform`/`pg`/`ccxt`/exchange SDKs). If `pnpm verify:no-forbidden-deps` DOES report a denylist hit, stop and report it — do not weaken the denylist.

- [ ] **Step 4: Confirm the dep-guard test still passes**

Run: `pnpm vitest run test/scripts/no-forbidden-deps.test.ts`
Expected: PASS (the real-repo case now installs the SDK and still prints OK because it's allowlisted).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/verify_no_forbidden_deps.mjs
git commit -m "build: add @modelcontextprotocol/sdk + allowlist it in the dep guard"
```

---

## Task 3: Gateway errors

**Files:**
- Create: `src/research-read/mcp/errors.ts`
- Test: `test/research-read/mcp/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { gatewayError, backtestUnavailable, BACKTEST_UNAVAILABLE_REASON } from '../../../src/research-read/mcp/errors.js';

describe('gateway errors', () => {
  it('gatewayError builds the required {category,code,message}', () => {
    expect(gatewayError('validation_error', 'x', 'msg')).toEqual({ category: 'validation_error', code: 'x', message: 'msg' });
  });
  it('backtestUnavailable is an ok:false envelope carrying the migration reason', () => {
    const r = backtestUnavailable();
    expect(r.ok).toBe(false);
    expect(r.error.category).toBe('internal_gateway_error');
    expect(r.error.message).toBe(BACKTEST_UNAVAILABLE_REASON);
    expect(BACKTEST_UNAVAILABLE_REASON).toBe('backtesting_moved_to_trading_backtester');
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL (module not found).**

Run: `pnpm vitest run test/research-read/mcp/errors.test.ts`

- [ ] **Step 3: Write `src/research-read/mcp/errors.ts`**

```ts
import type { GatewayError, GatewayErrorCategory, GatewayFailure } from '../../contract/research-read/mcp/dto.js';

export function gatewayError(category: GatewayErrorCategory, code: string, message: string): GatewayError {
  return { category, code, message };
}

export const BACKTEST_UNAVAILABLE_REASON = 'backtesting_moved_to_trading_backtester';

/** Every mutating/backtest tool returns this — no backtest is executed, simulated, or faked. */
export function backtestUnavailable(): GatewayFailure {
  return { ok: false, error: gatewayError('internal_gateway_error', 'backtest_unavailable', BACKTEST_UNAVAILABLE_REASON) };
}
```

- [ ] **Step 4: Run it — Expected: PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/research-read/mcp/errors.ts test/research-read/mcp/errors.test.ts
git commit -m "feat(research-mcp): gateway errors + backtest-unavailable envelope"
```

---

## Task 4: Snapshot → MCP-031 projections

**Files:**
- Create: `src/research-read/mcp/projections.ts`
- Test: `test/research-read/mcp/projections.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { discoverDescriptor, listDatasets, runStatus, runResult } from '../../../src/research-read/mcp/projections.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [
    { runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' },
      startedAtMs: 100, finishedAtMs: 900, lastSeenMs: 900, symbols: ['ETHUSDT'] },
    { runId: 'r2', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] },
    { runId: 'r3', mode: 'live', status: 'weird', strategy: { name: 's', version: '1' },
      startedAtMs: 5, finishedAtMs: null, lastSeenMs: 6, symbols: ['BTCUSDT'] },
  ],
  researchByRun: {
    r1: { summary: { runRef: 'r1', mode: 'paper',
      metrics: { netPnlUsd: '24.25', winRate: 50, maxDrawdownPct: '0.90', profitFactor: '2.33', sharpe: { available: false }, totalTrades: 2 },
      asOf: 900 }, trades: [], decisions: [], analysisContext: 'ok' },
  },
} as unknown as SnapshotBundle;

describe('projections', () => {
  it('discover returns contract 017.2 with a supportedContractVersions array', () => {
    const d = discoverDescriptor();
    expect(d.contractVersion).toBe('017.2');
    expect(d.supportedContractVersions).toContain('017.2');
    expect(Array.isArray(d.marketDataKinds)).toBe(true);
    expect(d.metricCatalog).toContain('pnl');
  });
  it('list_datasets is valid-empty (datasets array present, empty)', () => {
    expect(listDatasets()).toEqual({ datasets: [] });
  });
  it('runStatus maps a finished run to completed (terminal)', () => {
    const r = runStatus(bundle, 'r1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.status).toBe('completed');
    expect(r.view.runId).toBe('r1');
    expect(r.view.timeline.acceptedAtMs).toBe(100);
  });
  it('runStatus maps a running run to running', () => {
    const r = runStatus(bundle, 'r2');
    expect(r.ok && r.view.status).toBe('running');
  });
  it('runStatus returns an error envelope for an unknown run (no throw)', () => {
    const r = runStatus(bundle, 'rX');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.category).toBe('validation_error');
  });
  it('runResult projects metrics capability-aware (sharpe omitted; required arrays present)', () => {
    const r = runResult(bundle, 'r1');
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'summary') return;
    expect(r.summary.metrics.pnl).toBeCloseTo(24.25);
    expect(r.summary.metrics.win_rate).toBe(50);
    expect(r.summary.metrics.profit_factor).toBeCloseTo(2.33);
    expect('sharpe' in r.summary.metrics).toBe(false);             // {available:false} → omitted, not fabricated
    expect(r.summary.validationIssues).toEqual([]);                // required array present
    expect(r.summary.coverage).toEqual([]);
    expect(r.summary.artifactRefs).toEqual([]);
    expect(r.summary.comparison).toBeUndefined();                  // optional → omitted
    expect(r.summary.evidence.contractVersion).toBe('017.2');
  });
  it('runResult returns an error envelope for an unknown run', () => {
    const r = runResult(bundle, 'rX');
    expect(r.ok).toBe(false);
  });
  it('runResult on a non-terminal (running) run returns the status arm, NOT a fabricated summary', () => {
    const r = runResult(bundle, 'r2');
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'status') return;
    expect(r.view.status).toBe('running');
  });
  it('an unexpected run status never silently becomes completed — it errors (unmappable_status)', () => {
    const s = runStatus(bundle, 'r3');
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.error.code).toBe('unmappable_status');
    expect(runResult(bundle, 'r3').ok).toBe(false);
  });
});
```

> **mapStatus is exhaustive over the closed `BotRunStatus` set (`running|finished|crashed|aborted`)** — `default→completed` is removed. An unexpected status (which the AJV-validated snapshot should never contain) yields an explicit `internal_gateway_error/unmappable_status`, never a false `completed`. Non-terminal runs use the `RunResultResult` **status arm** rather than a fabricated summary.
```

- [ ] **Step 2: Run it — Expected: FAIL (module not found).**

Run: `pnpm vitest run test/research-read/mcp/projections.test.ts`

- [ ] **Step 3: Write `src/research-read/mcp/projections.ts`**

```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { ResearchMetrics } from '../../contract/research-read/dto.js';
import type {
  ResearchCapabilityDescriptor, ListDatasetsResult, RunStatus, RunStatusResult,
  RunStatusView, RunResultResult, RunResultSummary,
} from '../../contract/research-read/mcp/dto.js';
import {
  MCP031_CONTRACT_VERSION, MCP031_SUPPORTED_CONTRACT_VERSIONS,
  MCP031_METRIC_CATALOG, MCP031_ROBUSTNESS_CATALOG,
} from '../../contract/research-read/mcp/version.js';
import { readResearchResult } from '../../snapshot/readers/research.js';
import { gatewayError } from './errors.js';

export function discoverDescriptor(): ResearchCapabilityDescriptor {
  return {
    contractVersion: MCP031_CONTRACT_VERSION,
    supportedContractVersions: [...MCP031_SUPPORTED_CONTRACT_VERSIONS],
    marketDataKinds: [], // capability-aware: the mock exposes no point-in-time market data here
    runModes: [{ mode: 'single', description: 'snapshot replay (read-only mock)' }],
    metricCatalog: [...MCP031_METRIC_CATALOG],
    robustnessCatalog: [...MCP031_ROBUSTNESS_CATALOG],
  };
}

/** Valid-empty: the mock has no historical datasets (future /historical scope). Not an error. */
export function listDatasets(): ListDatasetsResult {
  return { datasets: [] };
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'canceled', 'expired', 'timed_out']);

/** Maps the closed snapshot BotRunStatus set to an MCP RunStatus. Returns null for ANY unexpected value
 *  so the caller emits an explicit error — an unknown/intermediate status must NEVER silently become
 *  'completed' (that would be a false "success" for lab). No default→completed. */
function mapStatus(botStatus: string): RunStatus | null {
  switch (botStatus) {
    case 'finished': return 'completed';
    case 'running': return 'running';
    case 'crashed': return 'failed';
    case 'aborted': return 'canceled';
    default: return null;
  }
}

function statusView(runId: string, status: RunStatus, startedAtMs: number): RunStatusView {
  return { jobId: `job_${runId}`, runId, status, timeline: { acceptedAtMs: startedAtMs } };
}

export function runStatus(bundle: SnapshotBundle, runId: string): RunStatusResult {
  const run = bundle.runs.find((r) => r.runId === runId);
  if (!run) return { ok: false, error: gatewayError('validation_error', 'run_not_found', 'run not found') };
  const status = mapStatus(run.status);
  if (status === null) return { ok: false, error: gatewayError('internal_gateway_error', 'unmappable_status', `unmappable run status '${run.status}'`) };
  return { ok: true, view: statusView(runId, status, run.startedAtMs) };
}

function toNum(s: string): number | undefined {
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Capability-aware: include only the catalog metrics we can safely source from the snapshot; never fabricate. */
function projectMetrics(rm: ResearchMetrics): Record<string, number> {
  const m: Record<string, number> = {};
  const pnl = toNum(rm.netPnlUsd); if (pnl !== undefined) m.pnl = pnl;
  m.win_rate = rm.winRate;
  const mdd = toNum(rm.maxDrawdownPct); if (mdd !== undefined) m.max_drawdown = mdd;
  m.total_trades = rm.totalTrades;
  if (rm.profitFactor !== undefined) { const pf = toNum(rm.profitFactor); if (pf !== undefined) m.profit_factor = pf; }
  if (typeof rm.sharpe === 'string') { const sh = toNum(rm.sharpe); if (sh !== undefined) m.sharpe = sh; }
  // top_trade_contribution_pct has no snapshot source on the research summary → omitted (capability-aware)
  return m;
}

export function runResult(bundle: SnapshotBundle, runId: string): RunResultResult {
  const run = bundle.runs.find((r) => r.runId === runId);
  if (!run) return { ok: false, error: gatewayError('validation_error', 'run_not_found', 'run not found') };
  const status = mapStatus(run.status);
  if (status === null) return { ok: false, error: gatewayError('internal_gateway_error', 'unmappable_status', `unmappable run status '${run.status}'`) };
  // Non-terminal run → the union's status arm (no summary exists yet); never a fabricated terminal summary.
  if (!TERMINAL_STATUSES.has(status)) return { ok: true, kind: 'status', view: statusView(runId, status, run.startedAtMs) };
  const research = readResearchResult(bundle, runId);
  if (!research) return { ok: false, error: gatewayError('validation_error', 'result_unavailable', 'no result summary for this run') };
  const summary: RunResultSummary = {
    runId,
    status,
    runKind: 'baseline-only',
    validationIssues: [],
    metrics: projectMetrics(research.summary.metrics),
    // comparison omitted (optional; capability-aware — no baseline/variant in the mock)
    coverage: [],
    artifactRefs: [],
    evidence: { seed: 0, contractVersion: MCP031_CONTRACT_VERSION, moduleVersions: [] },
  };
  return { ok: true, kind: 'summary', summary };
}
```

> `evidence.seed: 0` is a required structural field with no snapshot source — a benign structural default, not fabricated trading data.

- [ ] **Step 4: Run it — Expected: PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/research-read/mcp/projections.ts test/research-read/mcp/projections.test.ts
git commit -m "feat(research-mcp): snapshot → MCP-031 projections (capability-aware, never fabricates)"
```

---

## Task 5: Research access (token allowlist + stderr audit)

**Files:**
- Create: `src/access/research-access.ts`
- Test: `test/access/research-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { researchTokenAllowlist, auditResearchTool } from '../../src/access/research-access.js';

describe('research access', () => {
  it('parses MOCK_RESEARCH_TOKENS into a trimmed sha256 allowlist', () => {
    expect(researchTokenAllowlist({ MOCK_RESEARCH_TOKENS: ' a , b ,' })).toEqual(['a', 'b']);
    expect(researchTokenAllowlist({})).toEqual([]);
  });
  it('auditResearchTool writes to STDERR (never stdout) and never logs a token', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    auditResearchTool({ tsMs: 1, subject: 'local', resource: 'discover_research_contract', outcome: 'accepted' });
    expect(outSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledOnce();
    const line = String(errSpy.mock.calls[0]![0]);
    expect(line).toContain('research_audit');
    expect(line).toContain('discover_research_contract');
    errSpy.mockRestore(); outSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL (module not found).**

Run: `pnpm vitest run test/access/research-access.test.ts`

- [ ] **Step 3: Write `src/access/research-access.ts`**

```ts
import type { AuditRecord } from './audit.js';

/** sha256-hex allowlist for the research gateway (mirror of Surface A's MOCK_OPS_TOKENS). Empty = spawn-trusted. */
export function researchTokenAllowlist(env: Record<string, string | undefined>): string[] {
  return (env.MOCK_RESEARCH_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Redacted audit to STDERR — stdout is reserved for JSON-RPC framing on the stdio gateway.
 *  Never logs the raw token (subject is a hash prefix / 'local'). */
export function auditResearchTool(rec: AuditRecord): void {
  process.stderr.write(`${JSON.stringify({ kind: 'research_audit', ...rec })}\n`);
}
```

- [ ] **Step 4: Run it — Expected: PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/access/research-access.ts test/access/research-access.test.ts
git commit -m "feat(access): research token allowlist + stderr-only audit (stdio-safe)"
```

---

## Task 6: MCP server (pure dispatch + SDK wiring)

**Files:**
- Create: `src/research-read/mcp/server.ts`
- Test: `test/research-read/mcp/server.test.ts`

- [ ] **Step 1: Write the failing test** (tests the pure `dispatchTool`; no transport needed)

```ts
import { describe, it, expect, vi } from 'vitest';
import { dispatchTool, type ToolCtx } from '../../../src/research-read/mcp/server.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [{ runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' },
    startedAtMs: 100, finishedAtMs: 900, lastSeenMs: 900, symbols: ['ETHUSDT'] }],
  researchByRun: { r1: { summary: { runRef: 'r1', mode: 'paper',
    metrics: { netPnlUsd: '24.25', winRate: 50, maxDrawdownPct: '0.90', profitFactor: '2.33', sharpe: { available: false }, totalTrades: 2 },
    asOf: 900 }, trades: [], decisions: [], analysisContext: 'ok' } },
} as unknown as SnapshotBundle;

function parse(res: { content: Array<{ type: 'text'; text: string }> }): unknown {
  return JSON.parse(res.content.map((c) => c.text).join(''));
}

describe('dispatchTool', () => {
  const audit = vi.fn();
  const ctx: ToolCtx = { bundle, audit };

  it('discover_research_contract → 017.2 descriptor (audited accepted)', () => {
    const r = parse(dispatchTool('discover_research_contract', {}, ctx)) as { contractVersion: string };
    expect(r.contractVersion).toBe('017.2');
    expect(audit).toHaveBeenCalledWith('discover_research_contract', 'accepted');
  });
  it('get_run_result reads runId from args', () => {
    const r = parse(dispatchTool('get_run_result', { runId: 'r1' }, ctx)) as { ok: boolean; summary?: { metrics: Record<string, number> } };
    expect(r.ok).toBe(true);
    expect(r.summary!.metrics.pnl).toBeCloseTo(24.25);
  });
  it.each(['validate_module', 'submit_run', 'cancel_run', 'read_artifact'])('%s → backtest-unavailable (audited rejected)', (name) => {
    const r = parse(dispatchTool(name, {}, ctx)) as { ok: boolean; error: { message: string } };
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe('backtesting_moved_to_trading_backtester');
    expect(audit).toHaveBeenCalledWith(name, 'rejected');
  });
  it('unknown tool → validation error envelope (never throws)', () => {
    const r = parse(dispatchTool('nope', {}, ctx)) as { ok: boolean; error: { category: string } };
    expect(r.ok).toBe(false);
    expect(r.error.category).toBe('validation_error');
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL (module not found).**

Run: `pnpm vitest run test/research-read/mcp/server.test.ts`

- [ ] **Step 3: Write `src/research-read/mcp/server.ts`** (low-level `Server` — no zod/inputSchema-as-zod needed)

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import { GATEWAY_TOOL_NAMES } from '../../contract/research-read/mcp/version.js';
import { discoverDescriptor, listDatasets, runStatus, runResult } from './projections.js';
import { backtestUnavailable, gatewayError } from './errors.js';

export interface McpToolResult { content: Array<{ type: 'text'; text: string }> }
export interface ToolCtx {
  readonly bundle: SnapshotBundle;
  readonly audit: (tool: string, outcome: 'accepted' | 'rejected') => void;
}

function asResult(obj: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

/** Pure tool dispatch. Read tools project the snapshot; mutating tools return the unavailable envelope.
 *  Never throws — every path returns an MCP text result lab's `extractToolResult` can JSON-parse. */
export function dispatchTool(name: string, args: unknown, ctx: ToolCtx): McpToolResult {
  const a = (args ?? {}) as Record<string, unknown>;
  const runId = typeof a.runId === 'string' ? a.runId : '';
  switch (name) {
    case 'discover_research_contract': ctx.audit(name, 'accepted'); return asResult(discoverDescriptor());
    case 'list_datasets': ctx.audit(name, 'accepted'); return asResult(listDatasets());
    case 'get_run_status': ctx.audit(name, 'accepted'); return asResult(runStatus(ctx.bundle, runId));
    case 'get_run_result': ctx.audit(name, 'accepted'); return asResult(runResult(ctx.bundle, runId));
    case 'validate_module':
    case 'submit_run':
    case 'cancel_run':
    // read_artifact serves backtest/research-RUN artifacts (keyed by submit_run's runId; all ArtifactType
    // values are simulation outputs) — the honest "moved" reason, not a validation_error.
    case 'read_artifact': ctx.audit(name, 'rejected'); return asResult(backtestUnavailable());
    default: return asResult({ ok: false, error: gatewayError('validation_error', 'unknown_tool', `unknown tool ${name}`) });
  }
}

export function buildResearchServer(ctx: ToolCtx): Server {
  const server = new Server(
    { name: 'trading-mock-research-gateway', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GATEWAY_TOOL_NAMES.map((name) => ({
      name,
      description: `MCP-031 ${name} (read-only mock)`,
      inputSchema: { type: 'object' as const, properties: { runId: { type: 'string' as const } } },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => dispatchTool(req.params.name, req.params.arguments, ctx));
  return server;
}
```

- [ ] **Step 4: Run it + typecheck — Expected: PASS / clean.**

Run: `pnpm vitest run test/research-read/mcp/server.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/research-read/mcp/server.ts test/research-read/mcp/server.test.ts
git commit -m "feat(research-mcp): MCP server — 8 tools, read→projections, mutating→unavailable"
```

---

## Task 7: stdio entrypoint + end-to-end integration test

**Files:**
- Create: `src/bin/start-research-mcp.ts`
- Test: `test/research-read/mcp/integration.test.ts`

- [ ] **Step 1: Write the failing test** (spawns the real entrypoint via tsx; connects an MCP client over stdio)

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseToolResult(res: { structuredContent?: unknown; content?: unknown }): unknown {
  if (res.structuredContent !== undefined) return res.structuredContent;
  const content = res.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text).join('');
    if (text) return JSON.parse(text);
  }
  return content;
}

let client: Client | undefined;
let transport: StdioClientTransport | undefined;

describe('research MCP gateway (real stdio, end-to-end)', () => {
  it('lab-style client reads the gateway over stdio (proves stdout is clean JSON-RPC)', async () => {
    transport = new StdioClientTransport({
      command: 'tsx',
      args: ['src/bin/start-research-mcp.ts'],
      env: { ...process.env, MOCK_SNAPSHOT_REF: 'fixtures/2026-06-16-synthetic' },
    });
    client = new Client({ name: 'test-lab', version: '0' });
    await client.connect(transport); // handshake FAILS if the gateway pollutes stdout

    const discover = parseToolResult(await client.callTool({ name: 'discover_research_contract', arguments: {} })) as { contractVersion: string; supportedContractVersions: string[] };
    expect(discover.contractVersion).toBe('017.2');
    expect(discover.supportedContractVersions).toContain('017.2');

    const datasets = parseToolResult(await client.callTool({ name: 'list_datasets', arguments: {} })) as { datasets: unknown[] };
    expect(datasets.datasets).toEqual([]);

    const status = parseToolResult(await client.callTool({ name: 'get_run_status', arguments: { runId: 'run_paper_002' } })) as { ok: boolean; view?: { status: string } };
    expect(status.ok).toBe(true);
    expect(status.view!.status).toBe('completed');

    const result = parseToolResult(await client.callTool({ name: 'get_run_result', arguments: { runId: 'run_paper_002' } })) as { ok: boolean; kind?: string; summary?: { metrics: Record<string, number> } };
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('summary');
    expect(result.summary!.metrics.pnl).toBeCloseTo(24.25);

    // non-terminal (running) run → the status arm, never a fabricated terminal summary
    const live = parseToolResult(await client.callTool({ name: 'get_run_result', arguments: { runId: 'run_live_001' } })) as { ok: boolean; kind?: string; view?: { status: string } };
    expect(live.ok).toBe(true);
    expect(live.kind).toBe('status');
    expect(live.view!.status).toBe('running');

    const submit = parseToolResult(await client.callTool({ name: 'submit_run', arguments: {} })) as { ok: boolean; error?: { message: string } };
    expect(submit.ok).toBe(false);
    expect(submit.error!.message).toBe('backtesting_moved_to_trading_backtester');
  }, 30000);
});

afterAll(async () => { await client?.close(); await transport?.close(); });
```

- [ ] **Step 2: Run it — Expected: FAIL** (entrypoint does not exist → spawn/connect fails).

Run: `pnpm vitest run test/research-read/mcp/integration.test.ts`

- [ ] **Step 3: Write `src/bin/start-research-mcp.ts`** (fail-closed startup auth; ALL logging to stderr)

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authorize } from '../access/auth.js';
import { researchTokenAllowlist, auditResearchTool } from '../access/research-access.js';
import { openSnapshot } from '../snapshot/registry.js';
import { buildResearchServer } from '../research-read/mcp/server.js';
import { MCP031_CONTRACT_VERSION } from '../contract/research-read/mcp/version.js';

async function main(): Promise<void> {
  const env = process.env;
  const snapshotDir = env.MOCK_SNAPSHOT_DIR ?? './data/snapshots';
  const snapshotRef = env.MOCK_SNAPSHOT_REF ?? 'fixtures/2026-06-16-synthetic';

  // Fail-closed startup auth (reuses Surface A's sha256 allowlist semantics; empty = spawn-trusted).
  const allowlist = researchTokenAllowlist(env);
  const auth = authorize(allowlist, env.MOCK_RESEARCH_TOKEN);
  if (!auth.ok) {
    process.stderr.write('research gateway: unauthorized (MOCK_RESEARCH_TOKEN not in MOCK_RESEARCH_TOKENS)\n');
    process.exit(1);
  }

  const snapshot = openSnapshot(snapshotDir, snapshotRef);
  // stderr ONLY — stdout is reserved for JSON-RPC framing.
  process.stderr.write(`${JSON.stringify({ kind: 'research_startup', snapshotRef, contractVersion: MCP031_CONTRACT_VERSION, authRequired: allowlist.length > 0 })}\n`);

  const subject = auth.subject ?? 'local';
  const server = buildResearchServer({
    bundle: snapshot.bundle,
    audit: (tool, outcome) => auditResearchTool({ tsMs: Date.now(), subject, resource: tool, outcome }),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`research gateway fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run it — Expected: PASS** (the client connects + reads all tools).

Run: `pnpm vitest run test/research-read/mcp/integration.test.ts`

> If `connect` hangs/fails: confirm nothing in the gateway path writes to stdout (no `console.log`; `auditResearchTool` + startup log use `process.stderr`; the snapshot loader doesn't log). If `tsx` isn't found, ensure deps are installed (`tsx` is a devDep).

- [ ] **Step 5: Commit**

```bash
git add src/bin/start-research-mcp.ts test/research-read/mcp/integration.test.ts
git commit -m "feat(bin): stdio research MCP gateway entrypoint (fail-closed, stderr-only logging)"
```

---

## Task 8: Docker + README wiring

**Files:**
- Modify: `README.md`, `docker-compose.mock.yml`

> No Dockerfile change needed: `tsc` already builds `src/bin/start-research-mcp.ts` into `dist`, and the runtime stage's `pnpm install --prod` now includes `@modelcontextprotocol/sdk`. Lab spawns the gateway via `docker run -i`.

- [ ] **Step 1: Append a Surface B section to `README.md`**

```markdown
## Surface B — Research Read (trading-lab, stdio MCP gateway)

`trading-lab` reads the mock through its current MCP-over-stdio path — point it at the gateway with env only, no lab code change:

```
TRADING_PLATFORM_INTEGRATION=mcp
TRADING_PLATFORM_GATEWAY_COMMAND=docker
TRADING_PLATFORM_GATEWAY_ARGS=run -i --rm -e MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic trading-mock-platform:dev node dist/src/bin/start-research-mcp.js
# optional access control (sha256-hex allowlist; empty = spawn-trusted):
#   pass MOCK_RESEARCH_TOKENS (expected) into the container and MOCK_RESEARCH_TOKEN (raw) via the spawn env
```

The gateway speaks the MCP-031 contract (`017.2`): `discover_research_contract`, `list_datasets` (empty — historical datasets are the future `/historical` scope), `get_run_status`, `get_run_result` are served read-only from the snapshot; `validate_module` / `submit_run` / `cancel_run` return `{ok:false, error}` with reason `backtesting_moved_to_trading_backtester` — **no backtesting is implemented or faked here**. stdout carries JSON-RPC only; all logs/audit go to stderr. Backtest/hypothesis execution belongs to the future `trading-backtester`.
```

- [ ] **Step 2: Add a documenting comment to `docker-compose.mock.yml`**

Append (the gateway is spawned on demand by lab, not a long-running service — so it's a comment, not a service):
```yaml
  # Surface B (Research Read) is a stdio MCP gateway spawned on demand by trading-lab, not a service:
  #   docker run -i --rm -e MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic \
  #     trading-mock-platform:dev node dist/src/bin/start-research-mcp.js
  # Point lab at it via TRADING_PLATFORM_INTEGRATION=mcp + GATEWAY_COMMAND=docker + the GATEWAY_ARGS above.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docker-compose.mock.yml
git commit -m "docs(research-mcp): document lab GATEWAY_* wiring for the Surface B stdio gateway"
```

---

## Task 9: Final gate

- [ ] **Step 1: Run the full local guard set**

Run: `pnpm check:ci`
Expected: green — typecheck + `verify:contract-isolation` (incl. the new `contract/research-read/mcp/**`) + all tests (incl. the new projections/errors/server/access/integration tests) + `verify:no-forbidden-deps` (SDK allowlisted) + `verify:no-secrets`.

- [ ] **Step 2: Confirm the Docker image still builds public-only**

Run: `docker build -t trading-mock-platform:ci .`
Expected: succeeds with public deps only (now including `@modelcontextprotocol/sdk`), no private/registry auth. (If `docker` is unavailable in the environment, note it — CI's `docker` job will run it.)

- [ ] **Step 3: Smoke the gateway against the fixture**

Run: `pnpm build && printf '' | MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic node dist/src/bin/start-research-mcp.js 2>/tmp/gw.err & sleep 1; kill %1 2>/dev/null; grep -q research_startup /tmp/gw.err && echo "startup OK (logged to stderr)"`
Expected: prints `startup OK (logged to stderr)` — confirming the gateway boots and logs to stderr (stdout stays empty until a client drives it).

- [ ] **Step 4: Commit any docs touch-ups (if needed) and stop for review**

(No code commit expected here — Task 9 is verification. If a touch-up was needed, commit it with a `chore(research-mcp): …` message.)

---

## Self-Review

**1. Spec coverage:**
- Stdio MCP gateway speaking MCP-031 → Tasks 1 (contract), 6 (server), 7 (entrypoint).
- READ projections (discover/list_datasets/get_run_status/get_run_result) from snapshot → Task 4.
- MUTATING tools unavailable with `backtesting_moved_to_trading_backtester` → Tasks 3 + 6.
- `list_datasets` valid-empty-with-reason → Task 4 (`{datasets:[]}`; reason documented in README/code comment — the SDK shape has no reason field).
- Fidelity: mirror only fields lab reads; `comparison`/`coverage`/`evidence`/`artifactRefs` capability-aware (comparison omitted; required arrays present as `[]`) → Tasks 1 + 4; **acceptance condition** (adapter survives omissions) is grounded in the extracted throw-risk map and proven by the Task 7 integration test (a lab-style client decodes every response).
- `@modelcontextprotocol/sdk` pinned `^1.29` + 002 allowlist extended → Task 2.
- Contract mirroring read-only + import-clean → Task 1 (+ `verify:contract-isolation` in Task 9).
- stdio cleanliness (stdout JSON-RPC only; logs/audit to stderr) → Task 5 (stderr audit) + Task 7 (stderr-only entrypoint) + the integration test's clean handshake.
- Fail-closed auth/audit over stdio → Task 5 + Task 7 (startup `authorize`, exit on failure).
- 002 CI stays green; docker public-only → Tasks 2, 9.
- Surface A untouched → no Surface-A files modified anywhere in the plan.
- Out of scope honored (no backtest exec/lifecycle/sim; no historical datasets; no lab changes) → reflected by absence + the unavailable envelopes.

**2. Placeholder scan:** every code step has complete code; the only non-unit-tested artifacts (Docker/README, compose comment) are validated by `pnpm check:ci` + `docker build` + the smoke. No `TODO`/"add error handling"/"similar to Task N".

**3. Type consistency:** the mirrored DTO names (`ResearchCapabilityDescriptor`, `RunStatusResult`, `RunResultResult`, `RunResultSummary`, `GatewayError`, `GatewayFailure`) are defined once in Task 1 and used by Tasks 3/4/6. `dispatchTool(name,args,ctx)`/`buildResearchServer(ctx)`/`ToolCtx`/`McpToolResult` (Task 6) match the server test + entrypoint usage. `discoverDescriptor`/`listDatasets`/`runStatus`/`runResult` (Task 4) match the server dispatch. `researchTokenAllowlist`/`auditResearchTool` (Task 5) match the entrypoint. `MCP031_CONTRACT_VERSION='017.2'` is consistent across version.ts, projections, entrypoint, and tests.

**Execution order:** 1 (contract) → 2 (dep+allowlist, so the SDK is installed before 6/7 import it) → 3 (errors) → 4 (projections, need errors) → 5 (access) → 6 (server, needs SDK+projections+errors) → 7 (entrypoint+integration, needs server+access+SDK) → 8 (docs) → 9 (gate). As written.
