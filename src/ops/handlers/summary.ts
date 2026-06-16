import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RunSummary, ClosedTrade } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readTrades } from '../../snapshot/readers/trades.js';
import { decodeId } from '../ids.js';

export function handleSummary(bundle: SnapshotBundle, runIdRaw: string, asOf: number): RunSummary | OpsError {
  let runId: string;
  try { runId = decodeId('run', runIdRaw); }
  catch { return { category: 'validation_error', code: 'invalid_run_id', message: 'invalid run id' }; }
  // Existence is decided by the runs list, NOT by whether trades exist: a real run with zero
  // trades returns a ZERO aggregate; 404 only when the run id is not in bundle.runs.
  if (!bundle.runs.some((r) => r.runId === runId)) {
    return { category: 'not_found', code: 'run_not_found', message: 'run not found' };
  }
  return aggregate(runId, readTrades(bundle, runId), asOf);
}

function aggregate(runId: string, trades: readonly ClosedTrade[], asOf: number): RunSummary {
  let wins = 0, losses = 0, breakeven = 0, pnl = 0;
  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    const p = Number(t.realizedPnl);
    pnl += p;
    if (t.isWin === true) wins++; else if (t.isWin === false) losses++; else breakeven++;
    const reason = t.closeReason ?? 'unknown';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }
  const closedTrades = trades.length;
  return {
    runId, excludesReconcile: true, asOf,
    closedTrades, wins, losses, breakeven,
    winratePct: closedTrades ? (wins / closedTrades) * 100 : 0,
    pnlUsd: pnl.toFixed(8),
    avgPnl: closedTrades ? (pnl / closedTrades).toFixed(8) : '0.00000000',
    exitReasons,
  };
}
