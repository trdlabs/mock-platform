import { describe, it, expect } from 'vitest';
import { readTradeEvidence } from '../../../src/snapshot/readers/trade-evidence.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';

const ev = (tradeId: string) => ({ tradeId, runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
  openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09', realizedPnl: '-1', pnlPct: '-10',
  closeReason: 'stop_loss', lifecycle: [] });
const bundle = { tradeEvidenceByTrade: { t1: ev('t1'), t2: ev('t2') } } as unknown as SnapshotBundle;

describe('readTradeEvidence', () => {
  it('returns evidence in request order, skipping unknown ids', () => {
    const out = readTradeEvidence(bundle, ['t2', 'tX', 't1']);
    expect(out.map((e) => e.tradeId)).toEqual(['t2', 't1']);
  });
  it('returns empty for no matches', () => {
    expect(readTradeEvidence(bundle, ['nope'])).toEqual([]);
  });
});
