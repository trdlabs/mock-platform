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
