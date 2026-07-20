import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { HistoricalCapabilityDescriptor, HistoricalCapabilities, HistoricalResourceDescriptor, Timeframe } from '../../contract/historical-read/dto.js';
import { HISTORICAL_READ_CONTRACT_VERSION } from '../../contract/historical-read/version.js';
import { MAX_PAGE } from '../../ops/pagination.js';
import { hasMinuteGrainBars } from '../../snapshot/readers/rows-from-perkind.js';

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

  // Native CanonicalRowV2 rows are minute-grain (the /historical/rows resource), so advertise 1m
  // whenever any symbol has native rows — even when bars only cover 1h/1d — so a `SYMBOL:1m` dataset
  // resolves against them. Mirrors the real platform, where minute rows back a 1m dataset.
  // Minute-grain bars count too: they can back genuine minute rows. Coarser bars cannot
  // (audit P1-2), so a bars-only 1h/1d snapshot advertises neither 1m nor the rows resource.
  const hasNativeRows = hist
    ? Object.values(hist.rowsBySymbol ?? {}).some((rows) => rows.length > 0)
      || Object.keys(hist.barsBySymbolAndTimeframe ?? {}).some((s) => hasMinuteGrainBars(hist, s))
    : false;
  const presentTimeframes = hist
    ? ([...new Set([
        ...Object.values(hist.barsBySymbolAndTimeframe).flatMap((byTf) => Object.keys(byTf)),
        ...(hasNativeRows ? ['1m'] : []),
      ])].sort() as Timeframe[])
    : ALL_TIMEFRAMES;

  return {
    historicalContractVersion: HISTORICAL_READ_CONTRACT_VERSION,
    capabilities: CAPABILITIES,
    // The rows resource is only "available" when something can actually back minute rows.
    // A bars-only 1h/1d snapshot marks it unavailable rather than serving hourly bars as
    // minute rows; historical-coverage stays available so the bars remain discoverable.
    resources: hist
      ? RESOURCES.map((r) => (r.name === 'rows' && !hasNativeRows
        ? { ...r, availability: 'unavailable' as const }
        : r))
      : RESOURCES.map((r) => ({ ...r, availability: 'unavailable' as const })),
    symbols,
    timeframes: presentTimeframes,
  };
}
