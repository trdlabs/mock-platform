import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';

const snap = {
  dir: '.', manifest: { ref: 't', createdAtMs: 1, bundleRef: 'b', checksumsRef: 'c',
    versions: { snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.6',
      researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
      exporterVersion: 'e', sourcePlatformCommit: 'x', redactionPolicyVersion: 'r' } },
  bundle: {
    runs: [{ runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] }],
    tradesByRun: { r1: [] }, eventsByRun: {}, decisionsByRun: {},
    tradeEvidenceByTrade: { t1: { tradeId: 't1', runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long', openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09', realizedPnl: '-1', pnlPct: '-10', closeReason: 'stop_loss', closeReasonRaw: 'hard_stop', lifecycle: [] } },
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
  it('GET /ops/discover returns ops.6 200 (reachability for office)', async () => {
    const res = await makeApp().request('/ops/discover');
    expect(res.status).toBe(200);
    expect((await res.json() as { opsContractVersion: string }).opsContractVersion).toBe('ops.6');
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
  it('GET /ops/trade-evidence returns evidence items for known tradeIds', async () => {
    const res = await makeApp().request('/ops/trade-evidence?tradeIds=t1');
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; nextCursor: null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });
  it('GET /ops/trade-evidence 400 missing_trade_ids when tradeIds absent', async () => {
    const res = await makeApp().request('/ops/trade-evidence');
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('missing_trade_ids');
  });
  it('discover advertises ops.6 and the trade-evidence resource', async () => {
    const res = await makeApp().request('/ops/discover');
    const body = await res.json() as { opsContractVersion: string; resources: { name: string }[] };
    expect(body.opsContractVersion).toBe('ops.6');
    expect(body.resources.some((r) => r.name === 'trade-evidence')).toBe(true);
  });
});

const ROWS_N = 5;

function makeRow(minute_ts: number): Record<string, unknown> {
  return {
    schema_version: 2, minute_ts, symbol: 'BTCUSDT',
    open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, turnover: 15,
    oi_total_usd: 1000, funding_rate: 0.0001,
    liq_long_usd: 100, liq_short_usd: 200,
    has_oi: true, has_funding: true, has_liquidations: true,
    taker_buy_volume_usd: 6, taker_sell_volume_usd: 4, has_taker_flow: true,
  };
}

const histSnap = {
  ...snap,
  bundle: {
    ...(snap as unknown as { bundle: Record<string, unknown> }).bundle,
    historical: {
      rowsBySymbol: {
        BTCUSDT: Array.from({ length: ROWS_N }, (_, i) => makeRow(60_000 * (i + 1))),
      },
    },
  },
} as unknown as LoadedSnapshot;

function makeHistApp() {
  return createApp({ snapshot: histSnap, tokenAllowlist: [], replay: { mode: 'once', speed: 1 } }).app;
}

interface RowItem {
  turnover: number;
  liq_long_usd: number | null;
  liq_short_usd: number | null;
  has_liquidations: boolean;
  taker_buy_volume_usd: number | null;
  taker_sell_volume_usd: number | null;
  has_taker_flow: boolean;
  schema_version: number;
}

describe('historical /historical/rows http route', () => {
  it('GET /historical/rows returns full CanonicalRowV2 page (200)', async () => {
    const res = await makeHistApp().request('/historical/rows?symbols=BTCUSDT&fromMs=0&toMs=999999999999');
    expect(res.status).toBe(200);
    const body = await res.json() as { items: RowItem[] };
    expect(body.items.length).toBe(ROWS_N);
    const first = body.items[0]!;
    expect(typeof first.turnover).toBe('number');
    expect(first.liq_long_usd).toBe(100);
    expect(first.liq_short_usd).toBe(200);
    expect(first.has_liquidations).toBe(true);
    expect(typeof first.taker_buy_volume_usd).toBe('number');
    expect(typeof first.taker_sell_volume_usd).toBe('number');
    expect(first.has_taker_flow).toBe(true);
    expect(first.schema_version).toBe(2);
  });

  it('paginates via cursor with limit=3 (union == N, pages > 1)', async () => {
    const app = makeHistApp();
    const collected: RowItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/historical/rows?symbols=BTCUSDT&fromMs=0&toMs=999999999999&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await app.request(url);
      expect(res.status).toBe(200);
      const body = await res.json() as { items: RowItem[]; nextCursor: string | null };
      collected.push(...body.items);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(collected.length).toBe(ROWS_N);
    expect(pages).toBeGreaterThan(1);
  });

  it('unknown symbol returns an empty page (200, not error)', async () => {
    const res = await makeHistApp().request('/historical/rows?symbols=__NOPE__&fromMs=0&toMs=1');
    expect(res.status).toBe(200);
    const body = await res.json() as { items: RowItem[] };
    expect(body.items.length).toBe(0);
  });

  it('open-toMs (no toMs) yields all rows from fromMs (parity with explicit toMs)', async () => {
    const res = await makeHistApp().request('/historical/rows?symbols=BTCUSDT&fromMs=0');
    expect(res.status).toBe(200);
    const body = await res.json() as { items: RowItem[] };
    expect(body.items.length).toBe(ROWS_N);
  });
});
