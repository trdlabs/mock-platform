import { describe, it, expect } from 'vitest';
import { handleTrades } from '../../src/ops/handlers/trades.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { tradesByRun: { r1: [{ tradeId: 't1', runId: 'r1', symbol: 'B', side: 'long',
  openedAtMs: 1, closedAtMs: 2, realizedPnl: '1', pnlPct: '1', isWin: true, closeReason: 'tp' }] } } as unknown as SnapshotBundle;

describe('handleTrades', () => {
  it('returns trades for a run in a page envelope', () => {
    const p = handleTrades(bundle, 'r1', 100);
    expect(isOpsError(p)).toBe(false);
    if (isOpsError(p)) return;
    expect(p.items).toHaveLength(1);
    expect(p.nextCursor).toBeNull();
  });
  it('returns an empty page for an unknown run', () => {
    const p = handleTrades(bundle, 'rX', 100);
    expect(isOpsError(p)).toBe(false);
    if (isOpsError(p)) return;
    expect(p.items).toEqual([]);
  });
});
