import { describe, it, expect } from 'vitest';
import { buildReplaySequence } from '../../src/events/replay.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [{ runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
    startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] }],
  runtimeHealth: { entries: [], asOf: 1 },
  replay: { frames: [
    { offsetMs: 0, resource: 'runs' },
    { offsetMs: 1000, resource: 'runtime-health' },
    { offsetMs: 2000, resource: 'runs' },
  ] },
} as unknown as SnapshotBundle;

describe('buildReplaySequence', () => {
  it('is deterministic: same bundle+speed → identical ordered LiveUpdate sequence', () => {
    const a = buildReplaySequence(bundle, 1);
    const b = buildReplaySequence(bundle, 1);
    expect(a).toEqual(b);
    expect(a.map((f) => f.resource)).toEqual(['runs', 'runtime-health', 'runs']);
    expect(a[0]!.update.resource).toBe('runs');
    expect(typeof a[0]!.update.asOf).toBe('number');
  });
  it('scales delay by speed', () => {
    const fast = buildReplaySequence(bundle, 2);
    expect(fast[1]!.delayMs).toBe(500); // 1000ms / speed 2
    expect(fast[2]!.delayMs).toBe(500); // 2000-1000 = 1000ms / 2
  });
});
