import { describe, it, expect } from 'vitest';
import { handleTradeEvidence } from '../../src/ops/handlers/trade-evidence.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const ev = (tradeId: string) => ({ tradeId, runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
  openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09', realizedPnl: '-1', pnlPct: '-10',
  closeReason: 'stop_loss', closeReasonRaw: 'hard_stop', lifecycle: [{ tsMs: 1, type: 'entry', price: '0.1', qty: '5', note: null }] });
const bundle = { tradeEvidenceByTrade: { t1: ev('t1') } } as unknown as SnapshotBundle;

describe('handleTradeEvidence', () => {
  it('returns a single-page envelope with nextCursor null', () => {
    const p = handleTradeEvidence(bundle, 't1', 100);
    expect(isOpsError(p)).toBe(false);
    if (isOpsError(p)) return;
    expect(p.items).toHaveLength(1);
    expect(p.items[0]!.lifecycle).toHaveLength(1);
    expect(p.nextCursor).toBeNull();
    expect(p.asOf).toBe(100);
  });
  it('rejects empty tradeIds', () => {
    const p = handleTradeEvidence(bundle, '   ', 100);
    expect(isOpsError(p)).toBe(true);
    if (!isOpsError(p)) return;
    expect(p.code).toBe('missing_trade_ids');
  });
  it('rejects more than 25 tradeIds', () => {
    const csv = Array.from({ length: 26 }, (_, i) => `t${i}`).join(',');
    const p = handleTradeEvidence(bundle, csv, 100);
    expect(isOpsError(p)).toBe(true);
    if (!isOpsError(p)) return;
    expect(p.code).toBe('too_many_trade_ids');
  });
});
