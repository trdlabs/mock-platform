import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { HistoricalCoverageSnapshot, Timeframe } from '../../contract/historical-read/dto.js';

const ALL_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function handleHistoricalCoverage(bundle: SnapshotBundle, asOf: number): HistoricalCoverageSnapshot {
  if (!bundle.historical) {
    return { entries: [], symbols: [], timeframes: [], availability: 'unavailable', asOf };
  }

  const hist = bundle.historical;
  const barSymbols = Object.keys(hist.barsBySymbolAndTimeframe);
  const rowSymbols = Object.keys(hist.rowsBySymbol ?? {});
  const symbols = [...new Set([...barSymbols, ...rowSymbols])].sort();

  const entriesFromBars = symbols.flatMap((symbol) => {
    const byTf = hist.barsBySymbolAndTimeframe[symbol] ?? {};
    return Object.keys(byTf)
      .sort()
      .map((tf) => {
        const bars = byTf[tf] ?? [];
        return {
          symbol,
          timeframe: tf as Timeframe,
          fromMs: bars.length > 0 ? bars[0]!.tsMs : 0,
          toMs: bars.length > 0 ? bars[bars.length - 1]!.tsMs : 0,
          barCount: bars.length,
          availability: bars.length > 0 ? ('available' as const) : ('unavailable' as const),
        };
      });
  });

  const native1mEntries = rowSymbols.flatMap((symbol) => {
    const rows = hist.rowsBySymbol?.[symbol] ?? [];
    if (rows.length === 0) return [];
    return [{
      symbol,
      timeframe: '1m' as Timeframe,
      fromMs: rows[0]!.minute_ts,
      toMs: rows[rows.length - 1]!.minute_ts,
      barCount: rows.length,
      availability: 'available' as const,
    }];
  });

  const native1mSymbols = new Set(native1mEntries.map((entry) => entry.symbol));
  const entries = [
    ...entriesFromBars.filter((entry) => !(entry.timeframe === '1m' && native1mSymbols.has(entry.symbol))),
    ...native1mEntries,
  ].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.timeframe.localeCompare(b.timeframe));

  const presentTimeframes = [...new Set(entries.map((e) => e.timeframe))].sort() as Timeframe[];

  return {
    entries,
    symbols,
    timeframes: presentTimeframes.length > 0 ? presentTimeframes : ALL_TIMEFRAMES,
    availability: 'available',
    asOf,
  };
}
