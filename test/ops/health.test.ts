import { describe, it, expect } from 'vitest';
import { handleRuntimeHealth, handleMarketHealth, handleExecutionHealth } from '../../src/ops/handlers/health.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const bundle = {
  runtimeHealth: { entries: [{ source: 'long_oi', status: 'ok',
    indicators: { ready: true, freshnessOk: true, pipelineOk: true, serviceOk: true, botOk: true },
    availability: 'available', capturedAtMs: 1 }], asOf: 1 },
  marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: 10, availability: 'available', asOf: 1 },
  executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
} as unknown as SnapshotBundle;

describe('health handlers', () => {
  it('runtime returns a collection', () => {
    expect(handleRuntimeHealth(bundle).entries).toHaveLength(1);
  });
  it('execution idle is availability=unavailable (not an error)', () => {
    expect(handleExecutionHealth(bundle).availability).toBe('unavailable');
  });
  it('market returns availability', () => {
    expect(handleMarketHealth(bundle).availability).toBe('available');
  });
});
