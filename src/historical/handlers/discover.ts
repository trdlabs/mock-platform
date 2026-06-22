import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { HistoricalCapabilityDescriptor, HistoricalCapabilities, HistoricalResourceDescriptor, Timeframe } from '../../contract/historical-read/dto.js';
import { HISTORICAL_READ_CONTRACT_VERSION } from '../../contract/historical-read/version.js';
import { MAX_PAGE } from '../../ops/pagination.js';

const CAPABILITIES: HistoricalCapabilities = {
  readOnly: true,
  execution: false,
  mutation: false,
  liveIngestion: false,
};

const RESOURCES: readonly HistoricalResourceDescriptor[] = [
  {
    name: 'rows',
    supportedFilters: ['symbols', 'fromMs', 'toMs'],
    pagination: { cursor: true, maxPageItems: MAX_PAGE },
    fields: [],
    availability: 'available',
  },
  {
    name: 'historical-coverage',
    supportedFilters: [],
    pagination: null,
    fields: ['entries', 'symbols', 'timeframes', 'availability', 'asOf'],
    availability: 'available',
  },
];

const ALL_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function buildHistoricalDiscover(bundle: SnapshotBundle): HistoricalCapabilityDescriptor {
  const hist = bundle.historical;
  // Mirror the platform's real path: a symbol is discoverable iff it has CanonicalRowV2 rows
  // (the /historical/rows resource). Union with bars-keyed symbols keeps bars-only fixtures listed too.
  const symbols = hist
    ? [...new Set([...Object.keys(hist.barsBySymbolAndTimeframe), ...Object.keys(hist.rowsBySymbol ?? {})])].sort()
    : [];

  const presentTimeframes = hist
    ? ([...new Set(
        Object.values(hist.barsBySymbolAndTimeframe).flatMap((byTf) => Object.keys(byTf)),
      )].sort() as Timeframe[])
    : ALL_TIMEFRAMES;

  return {
    historicalContractVersion: HISTORICAL_READ_CONTRACT_VERSION,
    capabilities: CAPABILITIES,
    resources: hist ? RESOURCES : RESOURCES.map((r) => ({ ...r, availability: 'unavailable' as const })),
    symbols,
    timeframes: presentTimeframes,
  };
}
