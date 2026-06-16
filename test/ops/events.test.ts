import { describe, it, expect } from 'vitest';
import { handleEvents } from '../../src/ops/handlers/events.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = { eventsByRun: { r1: [{ category: 'startup', severity: 'info', runId: 'r1',
  tradeId: null, tsMs: 1, safeMessage: 'ok' }] } } as unknown as SnapshotBundle;

describe('handleEvents', () => {
  it('returns events for a run', () => {
    const p = handleEvents(bundle, 'r1', 100);
    expect(isOpsError(p)).toBe(false);
    if (isOpsError(p)) return;
    expect(p.items).toHaveLength(1);
  });
});
