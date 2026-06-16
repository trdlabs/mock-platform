import { describe, it, expect } from 'vitest';
import { handleSummary } from '../../src/ops/handlers/summary.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [
    { runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: 9, lastSeenMs: 9, symbols: ['BTCUSDT'] },
    { runId: 'r2', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['ETHUSDT'] },
  ],
  tradesByRun: {
    r1: [
      { tradeId: 't1', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 2,
        realizedPnl: '10', pnlPct: '1', isWin: true, closeReason: 'tp' },
      { tradeId: 't2', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 1, closedAtMs: 2,
        realizedPnl: '-4', pnlPct: '-1', isWin: false, closeReason: 'sl' },
    ],
  },
} as unknown as SnapshotBundle;

describe('handleSummary', () => {
  it('aggregates wins/losses/pnl', () => {
    const s = handleSummary(bundle, 'r1', 100);
    expect(isOpsError(s)).toBe(false);
    if (isOpsError(s)) return;
    expect(s.closedTrades).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.pnlUsd).toBe('6.00000000');
  });
  it('returns a ZERO aggregate for a real run with no trades (NOT 404)', () => {
    const s = handleSummary(bundle, 'r2', 100);
    expect(isOpsError(s)).toBe(false);
    if (isOpsError(s)) return;
    expect(s.closedTrades).toBe(0);
    expect(s.wins).toBe(0);
    expect(s.pnlUsd).toBe('0.00000000');
  });
  it('returns not_found ONLY when the run id is absent from bundle.runs', () => {
    const s = handleSummary(bundle, 'rX', 100);
    expect(isOpsError(s) && s.category).toBe('not_found');
  });
  it('returns validation_error for an empty id', () => {
    const s = handleSummary(bundle, '', 100);
    expect(isOpsError(s) && s.category).toBe('validation_error');
  });
});
