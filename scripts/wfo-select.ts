import { intersectToCommonGrid } from './make-wfo-fixture.js';
import { totalGap, maxConsecutiveGap } from './verify_fixtures.js';

const DAY_MS = 86_400_000;

/** primary first, then the top `count` other symbols by turnover desc, ties by symbol ASC. */
export function rankWfoSymbols(turnoverBySymbol: Record<string, number>, primary: string, count: number): string[] {
  const others = Object.keys(turnoverBySymbol)
    .filter((s) => s !== primary)
    .sort((a, b) => (turnoverBySymbol[b]! - turnoverBySymbol[a]!) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, count);
  return [primary, ...others];
}

/** Deterministic JSON for a turnover map — keys sorted ascending — so its sha256 is a stable,
 *  order-independent fingerprint of the ranking input. */
export function canonicalTurnover(turnoverBySymbol: Record<string, number>): string {
  const sorted = Object.keys(turnoverBySymbol).sort();
  return JSON.stringify(Object.fromEntries(sorted.map((k) => [k, turnoverBySymbol[k]])));
}

/** Slide a `spanDays` half-open window's anchor from the freshest day boundary backwards;
 *  return the first window whose intersected grid meets both budgets, or null. */
export function selectWfoWindow(
  rowsBySymbol: Record<string, ReadonlyArray<{ minute_ts: number }>>,
  symbols: string[],
  probeFrom: number,
  probeTo: number,
  spanDays: number,
  totalGapBudgetMinutes: number,
  maxConsecutiveGapMinutes: number,
): { fromMs: number; toMs: number } | null {
  const span = spanDays * DAY_MS;
  for (let toMs = probeTo; toMs - span >= probeFrom; toMs -= DAY_MS) {
    const fromMs = toMs - span;
    const { grid } = intersectToCommonGrid(rowsBySymbol, symbols, fromMs, toMs);
    if (totalGap(grid, fromMs, toMs) <= totalGapBudgetMinutes && maxConsecutiveGap(grid, fromMs, toMs) <= maxConsecutiveGapMinutes) {
      return { fromMs, toMs };
    }
  }
  return null;
}
