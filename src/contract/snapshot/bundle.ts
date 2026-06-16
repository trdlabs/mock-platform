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
