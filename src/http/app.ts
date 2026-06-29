import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createNodeWebSocket } from '@hono/node-ws';
import type { LoadedSnapshot } from '../snapshot/loader.js';
import { authorize, bearerFromHeader } from '../access/auth.js';
import { auditLog } from '../access/audit.js';
import { isOpsError, type OpsError } from '../contract/common/errors.js';
import { buildDiscover } from '../ops/handlers/discover.js';
import { handleRuns } from '../ops/handlers/runs.js';
import type { RunsFilter } from '../snapshot/readers/runs.js';
import { handleSummary } from '../ops/handlers/summary.js';
import { handleTrades } from '../ops/handlers/trades.js';
import { handleTradeEvidence } from '../ops/handlers/trade-evidence.js';
import { handleEvents } from '../ops/handlers/events.js';
import { handleDecisions } from '../ops/handlers/decisions.js';
import { handleRuntimeHealth, handleMarketHealth, handleExecutionHealth } from '../ops/handlers/health.js';
import { handleCoverage } from '../ops/handlers/coverage.js';
import { handleAnalysis } from '../ops/handlers/analysis.js';
import { startReplay } from '../events/ws-adapter.js';
import { buildHistoricalDiscover } from '../historical/handlers/discover.js';
import { handleRows } from '../historical/handlers/rows.js';
import { handleHistoricalCoverage } from '../historical/handlers/coverage.js';

export interface AppDeps {
  readonly snapshot: LoadedSnapshot;
  readonly tokenAllowlist: readonly string[];
  readonly replay: { mode: 'once' | 'loop'; speed: number };
}

function httpStatus(e: OpsError): ContentfulStatusCode {
  if (e.category === 'not_found') return 404;
  if (e.category === 'internal_read_error') return 500;
  return 400;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const bundle = deps.snapshot.bundle;
  const now = () => Date.now();

  // Auth middleware on /ops/* (HTTP). Empty allowlist = loopback-trusted.
  app.use('/ops/*', async (c, next) => {
    const auth = authorize(deps.tokenAllowlist, bearerFromHeader(c.req.header('authorization')));
    auditLog({ tsMs: now(), subject: auth.subject ?? 'anonymous', resource: c.req.path, outcome: auth.ok ? 'accepted' : 'rejected' });
    if (!auth.ok) {
      return c.json({ category: 'validation_error', code: 'unauthorized', message: 'authentication required' }, 401);
    }
    await next();
  });

  const respond = (c: Context, result: unknown) =>
    isOpsError(result) ? c.json(result, httpStatus(result)) : c.json(result as object, 200);

  const runsFilter = (c: Context): RunsFilter => {
    const f: { mode?: string; status?: string; symbol?: string } = {};
    const mode = c.req.query('mode');
    const status = c.req.query('status');
    const symbol = c.req.query('symbol');
    if (mode !== undefined) f.mode = mode;
    if (status !== undefined) f.status = status;
    if (symbol !== undefined) f.symbol = symbol;
    return f;
  };

  app.get('/ops/discover', (c) => c.json(buildDiscover(), 200));
  app.get('/ops/runs', (c) => respond(c, handleRuns(bundle, runsFilter(c), now(), c.req.query('cursor'))));
  app.get('/ops/runs/:runId/summary', (c) => respond(c, handleSummary(bundle, c.req.param('runId'), now())));
  app.get('/ops/runs/:runId/analysis', (c) => respond(c, handleAnalysis(bundle, c.req.param('runId'))));
  app.get('/ops/trades', (c) => respond(c, handleTrades(bundle, c.req.query('runId') ?? '', now(), c.req.query('cursor'))));
  app.get('/ops/trade-evidence', (c) => respond(c, handleTradeEvidence(bundle, c.req.query('tradeIds') ?? '', now())));
  // GET → EventsPage list. A WebSocket upgrade falls through to the WS route registered below
  // (Hono runs same-path handlers in order; this one yields via next() only for upgrades).
  app.get('/ops/events', (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return next();
    return respond(c, handleEvents(bundle, c.req.query('runId') ?? '', now(), c.req.query('cursor')));
  });
  app.get('/ops/decisions', (c) => respond(c, handleDecisions(bundle, c.req.query('runId') ?? '', now(), c.req.query('cursor'))));
  app.get('/ops/health/runtime', (c) => c.json(handleRuntimeHealth(bundle), 200));
  app.get('/ops/health/market', (c) => c.json(handleMarketHealth(bundle), 200));
  app.get('/ops/health/execution', (c) => c.json(handleExecutionHealth(bundle), 200));
  app.get('/ops/coverage', (c) => c.json(handleCoverage(bundle, c.req.query('source'), c.req.query('kind')), 200));

  // --- Historical Read surface (/historical/*) — no auth required (read-only, sanitized snapshots) ---

  const toNum = (v: string | undefined): number | undefined => (v !== undefined ? Number(v) : undefined);

  app.get('/historical/discover', (c) => c.json(buildHistoricalDiscover(bundle), 200));
  // symbols is CSV (plural).
  app.get('/historical/rows', (c) => {
    const symbols = (c.req.query('symbols') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const fromMs = toNum(c.req.query('fromMs'));
    const toMs = toNum(c.req.query('toMs'));
    const limit = toNum(c.req.query('limit'));
    return respond(c, handleRows(bundle, {
      symbols,
      ...(fromMs !== undefined ? { fromMs } : {}),
      ...(toMs !== undefined ? { toMs } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }, now(), c.req.query('cursor')));
  });
  app.get('/historical/coverage', (c) => c.json(handleHistoricalCoverage(bundle, now()), 200));

  // WS replay shares the /ops/events path (GET → list; upgrade → stream). Read-only: inbound ignored.
  app.get('/ops/events', upgradeWebSocket(() => {
    let stop: (() => void) | null = null;
    return {
      onOpen: (_evt, ws) => { stop = startReplay(ws, bundle, deps.replay); },
      onClose: () => { stop?.(); },
    };
  }));

  return { app, injectWebSocket };
}
