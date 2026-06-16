import { describe, it, expect } from 'vitest';
import { handleRuns } from '../../src/ops/handlers/runs.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [
    { runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] },
    { runId: 'r2', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: 9, lastSeenMs: 9, symbols: ['ETHUSDT'] },
  ],
} as unknown as SnapshotBundle;

describe('handleRuns', () => {
  it('returns a page of runs filtered by mode', () => {
    const page = handleRuns(bundle, { mode: 'live' }, 100);
    expect(isOpsError(page)).toBe(false);
    if (isOpsError(page)) return;
    expect(page.items.map((r) => r.runId)).toEqual(['r1']);
    expect(page.items[0]!.strategy.name).toBe('s'); // office hard-requires strategy.name
  });
  it('returns all runs when no filter', () => {
    const page = handleRuns(bundle, {}, 100);
    expect(isOpsError(page)).toBe(false);
    if (isOpsError(page)) return;
    expect(page.items).toHaveLength(2);
  });
});
