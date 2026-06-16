import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';

const snap = {
  dir: '.', manifest: {} as never,
  bundle: {
    runs: [{ runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] }],
    tradesByRun: {}, eventsByRun: { r1: [{ category: 'startup', severity: 'info', runId: 'r1',
      tradeId: null, tsMs: 1, safeMessage: 'ok' }] }, decisionsByRun: {},
    runtimeHealth: { entries: [], asOf: 1 },
    marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
    executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
    coverage: { entries: [], availability: 'available', asOf: 1 },
    analysisByRun: {}, researchByRun: {},
    replay: { frames: [{ offsetMs: 0, resource: 'runs' }] },
  },
} as unknown as LoadedSnapshot;

let server: ServerType;
let port: number;

beforeAll(async () => {
  const built = createApp({ snapshot: snap, tokenAllowlist: [], replay: { mode: 'once', speed: 1000 } });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: built.app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      port = info.port; resolve();
    });
    built.injectWebSocket(server);
  });
});
afterAll(() => { server.close(); });

describe('/ops/events on one path', () => {
  it('plain GET returns an EventsPage (items array)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ops/events?runId=r1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; nextCursor: unknown };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
  });

  it('WebSocket upgrade on the same path streams a LiveUpdate', async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ops/events`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('no WS message within 2s')); }, 2000);
      ws.onmessage = (e) => { clearTimeout(timer); resolve(String(e.data)); ws.close(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    });
    const update = JSON.parse(raw) as { resource: string; asOf: number; payload: unknown };
    expect(update.resource).toBe('runs');           // first replay frame at offset 0
    expect(typeof update.asOf).toBe('number');
  });
});
