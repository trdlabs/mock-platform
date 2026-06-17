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
