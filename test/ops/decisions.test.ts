import { describe, it, expect } from 'vitest';
import { handleDecisions } from '../../src/ops/handlers/decisions.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { decisionsByRun: { r1: [{ category: 'no_entry', runId: 'r1', botId: 'long_oi',
  symbol: 'BTCUSDT', side: 'long', reason: 'oi flat', tsMs: 1, safeMessage: 'skip' }] } } as unknown as SnapshotBundle;

describe('handleDecisions', () => {
  it('returns decisions for a run', () => {
    const p = handleDecisions(bundle, 'r1', 100);
    expect(isOpsError(p)).toBe(false);
    if (isOpsError(p)) return;
    expect(p.items).toHaveLength(1);
  });
});
