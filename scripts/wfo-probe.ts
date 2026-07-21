// scripts/wfo-probe.ts — reads the LOCAL 5-symbol raw snapshot (no VPS), prints the chosen
// 42-day window, or exits non-zero (blocker) when no window fits the frozen budgets.
import { pathToFileURL } from 'node:url';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { selectWfoWindow } from './wfo-select.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

function main(): void {
  const source = arg('source');
  const symbols = arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const probeFrom = Number(arg('probe-from'));
  const probeTo = Number(arg('probe-to'));
  const spanDays = Number(arg('span-days'));
  const totalGapBudget = Number(arg('total-gap-budget'));
  const maxConsecutiveGapM = Number(arg('max-consecutive-gap'));

  const rows = (loadSnapshot(source).bundle as unknown as {
    historical?: { rowsBySymbol?: Record<string, Array<{ minute_ts: number }>> };
  }).historical?.rowsBySymbol;
  if (!rows) { console.error('BLOCKER: source has no historical.rowsBySymbol'); process.exit(2); }

  const win = selectWfoWindow(rows, symbols, probeFrom, probeTo, spanDays, totalGapBudget, maxConsecutiveGapM);
  if (!win) { console.error('BLOCKER: no contiguous 42-day window fits the frozen budgets — do not tune budgets, do not substitute synthetic data'); process.exit(2); }

  console.log(`from=${win.fromMs}`);
  console.log(`to=${win.toMs}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
