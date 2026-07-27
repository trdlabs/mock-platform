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
    // Structural, and deliberately ahead of the budgets. The two budgets answer
    // "how much of this window is missing"; neither answers "is anything here".
    // With an empty grid they both report the full span, so ordinary budgets do
    // reject it — but a budget widened to "just get a window" turns that
    // accident of arithmetic off, and the selector hands back a window over
    // which no symbol shares a single minute. Downstream that becomes a fixture
    // with zero rows whose provenance records commonGridSize: 0 as a result.
    // An empty intersection is not a narrow window; it is no window at all, and
    // no budget may authorise it.
    if (grid.length === 0) continue;
    if (totalGap(grid, fromMs, toMs) <= totalGapBudgetMinutes && maxConsecutiveGap(grid, fromMs, toMs) <= maxConsecutiveGapMinutes) {
      return { fromMs, toMs };
    }
  }
  return null;
}
