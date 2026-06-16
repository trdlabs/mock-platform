import { describe, it, expect } from 'vitest';
import { handleAnalysis } from '../../src/ops/handlers/analysis.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const analysis = {
  runRef: 'r1', opsContractVersion: 'ops.4', asOf: 1, freshness: 'fresh',
  identity: { mode: 'live', strategy: { name: 's', version: '1' }, symbols: ['BTCUSDT'] },
  period: { fromMs: 1, toMs: 9 }, healthContext: 'ok',
  metrics: { pnl: '6', winRate: 50, maxDrawdown: '4', totalTrades: 2, topTradeContributionPct: 80 },
  trades: [], strategyConfig: { available: false, reason: 'not_safely_sourced' },
  dcaCount: { available: false }, slTpBeEvents: { available: false },
  features: { available: false }, summaryPatterns: [],
};
const bundle = { analysisByRun: { r1: analysis } } as unknown as SnapshotBundle;

describe('handleAnalysis', () => {
  it('returns the analysis snapshot for a known run', () => {
    const r = handleAnalysis(bundle, 'r1');
    expect(isOpsError(r)).toBe(false);
    if (isOpsError(r)) return;
    expect(r.opsContractVersion).toBe('ops.4');
    expect(r.features).toEqual({ available: false }); // capability-aware omission preserved
  });
  it('returns not_found for an unknown run', () => {
    const r = handleAnalysis(bundle, 'rX');
    expect(isOpsError(r) && r.category).toBe('not_found');
  });
});
