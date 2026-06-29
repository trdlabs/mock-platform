import type {
  BotRunRecord, ClosedTrade, OperationalEvent, DecisionLogEntry, TradeEvidence,
  RuntimeHealthCollection, MarketServiceHealthSnapshot, ExecutionHealthSnapshot,
  SourceCoverageSnapshot,
} from '../ops-read/dto.js';
import type { AnalysisSnapshot } from '../analysis/dto.js';
import type { ResearchRunResult } from '../research-read/dto.js';
import type { OhlcvBar, FundingEntry, OpenInterestEntry, LiquidationEntry, CanonicalRowV2 } from '../historical-read/dto.js';

export interface HistoricalBundle {
  readonly barsBySymbolAndTimeframe: Readonly<Record<string, Readonly<Record<string, readonly OhlcvBar[]>>>>;
  readonly fundingBySymbol: Readonly<Record<string, readonly FundingEntry[]>>;
  readonly openInterestBySymbol: Readonly<Record<string, readonly OpenInterestEntry[]>>;
  readonly liquidationsBySymbol: Readonly<Record<string, readonly LiquidationEntry[]>>;
  readonly rowsBySymbol?: Record<string, readonly CanonicalRowV2[]>;
}

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
  readonly tradeEvidenceByTrade: Readonly<Record<string, TradeEvidence>>;
  readonly runtimeHealth: RuntimeHealthCollection;
  readonly marketHealth: MarketServiceHealthSnapshot;
  readonly executionHealth: ExecutionHealthSnapshot;
  readonly coverage: SourceCoverageSnapshot;
  readonly analysisByRun: Readonly<Record<string, AnalysisSnapshot>>;
  readonly researchByRun: Readonly<Record<string, ResearchRunResult>>;
  readonly replay: { readonly frames: readonly ReplayFrame[] };
  /** Phase 008: historical read surface. Optional — absent in pre-008 snapshots. */
  readonly historical?: HistoricalBundle;
}
