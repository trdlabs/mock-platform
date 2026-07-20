// A3 SDK SEAM — the ONLY file in src/contract/** permitted to import @trdlabs/sdk
// (machine-enforced by scripts/verify_contract_isolation.ts). Live bot-results primitives are
// the SDK's contract (feature 004); this file re-exports them verbatim. research-read/dto.ts and
// every other contract file MUST stay dependency-free.
export type {
  BotMode, BotRunStatus, TradeSide, OpsSeverity, BotRunStrategyRef,
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  OperationalEvent, DecisionLogEntry,
  TradeEvidence, TradeLifecycleEvent, OpsTradeLifecycleEventType, CloseReason,
} from '@trdlabs/sdk/ops-read';
export { OPS_READ_CONTRACT_VERSION } from '@trdlabs/sdk/ops-read';
export type { OpsReadContractVersion } from '@trdlabs/sdk/ops-read';
