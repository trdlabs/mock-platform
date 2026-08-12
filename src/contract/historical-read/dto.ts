import type { SourceAvailability, PageEnvelope } from '../common/envelopes.js';
import type { CanonicalRowV2 } from './dto.sdk.js';

// --- primitives ---

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface OhlcvBar {
  readonly tsMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface FundingEntry {
  readonly tsMs: number;
  readonly symbol: string;
  readonly rate: number;
}

export interface OpenInterestEntry {
  readonly tsMs: number;
  readonly symbol: string;
  readonly openInterestUsd: number;
}

export interface LiquidationEntry {
  readonly tsMs: number;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly sizeUsd: number;
}

// --- coverage / availability ---

export interface HistoricalCoverageEntry {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly fromMs: number;
  readonly toMs: number;
  readonly barCount: number;
  readonly availability: SourceAvailability;
}

export interface HistoricalCoverageSnapshot {
  readonly entries: readonly HistoricalCoverageEntry[];
  readonly symbols: readonly string[];
  readonly timeframes: readonly Timeframe[];
  readonly availability: SourceAvailability;
  readonly asOf: number;
}

// --- discover ---

export type HistoricalResourceAvailability = SourceAvailability | 'unsupported';

export interface HistoricalResourceDescriptor {
  readonly name: string;
  readonly supportedFilters: readonly string[];
  readonly pagination: { readonly cursor: true; readonly maxPageItems: number } | null;
  readonly fields: readonly string[];
  readonly availability: HistoricalResourceAvailability;
  /**
   * 100 (Д1) — закрытый словарь видов, принимаемых фильтром `kinds`. Только у
   * ресурсов, поддерживающих проекцию: объявить фильтр и не сказать, какие
   * значения допустимы, значит заставить потребителя угадывать словарь по 400-кам.
   */
  readonly kinds?: readonly string[];
}

export interface HistoricalCapabilities {
  readonly readOnly: true;
  readonly execution: false;
  readonly mutation: false;
  readonly liveIngestion: false;
}

export interface HistoricalCapabilityDescriptor {
  readonly historicalContractVersion: string;
  readonly capabilities: HistoricalCapabilities;
  readonly resources: readonly HistoricalResourceDescriptor[];
  readonly symbols: readonly string[];
  readonly timeframes: readonly Timeframe[];
  /** Д3 (3.3б) — состояние индекса доступности, диагностически. */
  readonly availability: import('./availability.js').AvailabilityDescriptor;
}

// --- canonical row v2 (sourced from trading-platform SDK via the historical SDK seam, 19 fields) ---

export type { CanonicalRowV2 };

// --- page aliases ---

export type BarsPage = PageEnvelope<OhlcvBar>;
export type FundingPage = PageEnvelope<FundingEntry>;
export type OpenInterestPage = PageEnvelope<OpenInterestEntry>;
export type LiquidationsPage = PageEnvelope<LiquidationEntry>;
export type RowsPage = PageEnvelope<CanonicalRowV2>;
