import type {
  PageEnvelope,
  SourceAvailability,
  OpsResourceAvailability,
} from '../common/envelopes.js';
import type { OpsCapabilities } from '../common/capabilities.js';
import type { BotRunRecord, ClosedTrade, OperationalEvent, DecisionLogEntry, TradeEvidence } from './dto.sdk.js';

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
export type TradeEvidencePage = PageEnvelope<TradeEvidence>;
