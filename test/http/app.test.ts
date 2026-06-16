import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';

const snap = {
  dir: '.', manifest: { ref: 't', createdAtMs: 1, bundleRef: 'b', checksumsRef: 'c',
    versions: { snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.3',
      researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
      exporterVersion: 'e', sourcePlatformCommit: 'x', redactionPolicyVersion: 'r' } },
  bundle: {
    runs: [{ runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] }],
    tradesByRun: { r1: [] }, eventsByRun: {}, decisionsByRun: {},
    runtimeHealth: { entries: [], asOf: 1 },
    marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
    executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
    coverage: { entries: [], availability: 'available', asOf: 1 },
    analysisByRun: {}, researchByRun: {}, replay: { frames: [] },
  },
} as unknown as LoadedSnapshot;

function makeApp(tokens: string[] = []) {
  return createApp({ snapshot: snap, tokenAllowlist: tokens, replay: { mode: 'once', speed: 1 } }).app;
}

describe('ops read http app', () => {
  it('GET /ops/discover returns ops.3 200 (reachability for office)', async () => {
    const res = await makeApp().request('/ops/discover');
    expect(res.status).toBe(200);
    expect((await res.json() as { opsContractVersion: string }).opsContractVersion).toBe('ops.3');
  });
  it('GET /ops/runs?mode=live returns a page with strategy.name present', async () => {
    const res = await makeApp().request('/ops/runs?mode=live');
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ strategy: { name: string } }> };
    expect(body.items[0]!.strategy.name).toBe('s');
  });
  it('GET /ops/runs/:id/summary on unknown run returns 404', async () => {
    const res = await makeApp().request('/ops/runs/rX/summary');
    expect(res.status).toBe(404);
  });
  it('rejects requests without a token when an allowlist is configured (401)', async () => {
    const res = await makeApp(['deadbeef']).request('/ops/runs');
    expect(res.status).toBe(401);
  });
  it('rejects POST (read-only surface)', async () => {
    const res = await makeApp().request('/ops/runs', { method: 'POST' });
    expect(res.status).toBe(404); // no POST route registered
  });
  it.each(['/ops/runs', '/ops/trades?runId=r1', '/ops/events?runId=r1', '/ops/decisions?runId=r1'])(
    'returns 400 invalid_cursor (not 500) for a malformed cursor on %s', async (base) => {
      const sep = base.includes('?') ? '&' : '?';
      const res = await makeApp().request(`${base}${sep}cursor=not-a-cursor`);
      expect(res.status).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('invalid_cursor');
    });
});
