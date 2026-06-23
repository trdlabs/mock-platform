// Demo/back-compat seam: synthesize `CanonicalRowV2` rows from the legacy per-kind historical series
// (`barsBySymbolAndTimeframe` + funding + open-interest + liquidations) when a snapshot bundle predates
// the merged `rowsBySymbol` shape introduced with historical.2.
//
// Why: the `historical.2` rows-only endpoint reads ONLY `bundle.historical.rowsBySymbol`. Snapshots
// captured by the older fetch-snapshot tooling (e.g. the demo `2026-06-12-real-top5` fixture) carry the
// per-kind series but no `rowsBySymbol`, so `/historical/rows` would return empty and downstream overlay
// backtests get an empty market tape. This fills that gap WITHOUT re-capturing data: one row per bar of
// the FINEST available timeframe (the backtester consumes rows 1:1 as bars — no re-aggregation — so a
// `SYMBOL:1h` dataset is served correct 1h candles), with minute-granular oi/funding forward-filled to
// the bar's open and liquidations summed over the bar window. Taker flow is absent in per-kind data.
//
// This is a derivation, not a re-capture: turnover is approximated as `volume * close`, and oi/funding
// are sampled (last value at-or-before the bar). Snapshots that DO carry `rowsBySymbol` bypass this
// entirely (see `readRows`).

import type { HistoricalBundle } from '../../contract/snapshot/bundle.js';
import type {
  CanonicalRowV2,
  FundingEntry,
  LiquidationEntry,
  OhlcvBar,
  OpenInterestEntry,
} from '../../contract/historical-read/dto.js';

const TIMEFRAME_MS: Readonly<Record<string, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** The non-empty timeframe with the smallest interval (rows must be the finest grain the symbol has). */
function finestTimeframe(byTf: Readonly<Record<string, readonly OhlcvBar[]>>): string | undefined {
  const present = Object.keys(byTf).filter((tf) => (byTf[tf]?.length ?? 0) > 0);
  if (present.length === 0) return undefined;
  return present.reduce((best, tf) =>
    (TIMEFRAME_MS[tf] ?? Number.POSITIVE_INFINITY) < (TIMEFRAME_MS[best] ?? Number.POSITIVE_INFINITY)
      ? tf
      : best,
  );
}

/** Last element with `tsMs <= cutoff` (forward-fill). `sorted` MUST be ascending by `tsMs`. */
function lastAtOrBefore<T extends { readonly tsMs: number }>(
  sorted: readonly T[],
  cutoff: number,
): T | undefined {
  let lo = 0;
  let hi = sorted.length - 1;
  let res: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]!.tsMs <= cutoff) {
      res = sorted[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

function byTsAsc<T extends { readonly tsMs: number }>(arr: readonly T[]): readonly T[] {
  return [...arr].sort((a, b) => a.tsMs - b.tsMs);
}

/**
 * Build `CanonicalRowV2[]` for `symbol` from the per-kind series in `hist`. Empty when the symbol has no
 * bars. One row per finest-timeframe bar; oi/funding forward-filled; liquidations summed over the bar
 * window `[bar, bar + tfMs)`; taker absent.
 */
export function synthesizeRowsFromPerKind(
  hist: HistoricalBundle,
  symbol: string,
): readonly CanonicalRowV2[] {
  // Defensive optional chaining: partial bundles (e.g. rows-only test fixtures) may omit per-kind maps
  // even though the type marks them required.
  const byTf = hist.barsBySymbolAndTimeframe?.[symbol];
  if (byTf === undefined) return [];
  const tf = finestTimeframe(byTf);
  if (tf === undefined) return [];
  const bars = byTsAsc(byTf[tf] ?? []);
  if (bars.length === 0) return [];

  const tfMs = TIMEFRAME_MS[tf] ?? (bars.length > 1 ? bars[1]!.tsMs - bars[0]!.tsMs : 3_600_000);

  const oi: readonly OpenInterestEntry[] = byTsAsc(hist.openInterestBySymbol?.[symbol] ?? []);
  const funding: readonly FundingEntry[] = byTsAsc(hist.fundingBySymbol?.[symbol] ?? []);
  const liq: readonly LiquidationEntry[] = hist.liquidationsBySymbol?.[symbol] ?? [];
  const hasOiSeries = oi.length > 0;
  const hasFundingSeries = funding.length > 0;
  const hasLiqSeries = liq.length > 0;

  return bars.map((bar): CanonicalRowV2 => {
    const oiAt = hasOiSeries ? lastAtOrBefore(oi, bar.tsMs) : undefined;
    const fundingAt = hasFundingSeries ? lastAtOrBefore(funding, bar.tsMs) : undefined;

    let liqLong = 0;
    let liqShort = 0;
    if (hasLiqSeries) {
      const windowEnd = bar.tsMs + tfMs;
      for (const e of liq) {
        if (e.tsMs >= bar.tsMs && e.tsMs < windowEnd) {
          if (e.side === 'long') liqLong += e.sizeUsd;
          else liqShort += e.sizeUsd;
        }
      }
    }

    return {
      schema_version: 2,
      minute_ts: bar.tsMs,
      symbol,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      turnover: bar.volume * bar.close,
      oi_total_usd: oiAt?.openInterestUsd ?? null,
      has_oi: oiAt !== undefined,
      funding_rate: fundingAt?.rate ?? null,
      has_funding: fundingAt !== undefined,
      liq_long_usd: hasLiqSeries ? liqLong : null,
      liq_short_usd: hasLiqSeries ? liqShort : null,
      has_liquidations: hasLiqSeries,
      taker_buy_volume_usd: null,
      taker_sell_volume_usd: null,
      has_taker_flow: false,
    };
  });
}
