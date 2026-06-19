/**
 * fetch-snapshot.ts — собирает срез данных с VPS и записывает/обновляет снапшот
 * для trading-mock-platform.
 *
 * Что делает:
 *   1. Открывает SSH-туннель к Postgres на VPS (child_process ssh -L).
 *   2. Извлекает bot_run, trade, operational_event, decision_log за период.
 *   3. Скачивает Parquet-файлы с VPS через rsync.
 *   4. Читает Parquet (hyparquet), агрегирует минутные бары в 1h/1d.
 *   5. Строит SnapshotBundle + manifest.json + checksums.json.
 *   6. Записывает в data/snapshots/<ref>/ — создаёт или перезаписывает.
 *
 * Зависимости (devDependencies):
 *   pnpm add -D pg @types/pg hyparquet
 *
 * Использование:
 *   pnpm fetch:snapshot \
 *     --vps user@host \
 *     --db-url "postgres://user:pass@localhost:5432/db" \
 *     --parquet-root /data/historical \
 *     --from 2026-06-01 --to 2026-06-16 \
 *     --symbols BTCUSDT,ETHUSDT \
 *     --ref 2026-06-16-vps
 *
 *   # Если postgres доступен напрямую (VPN/прямой):
 *   pnpm fetch:snapshot --no-tunnel --db-url "postgres://..." ...
 *
 *   # Только ops-данные без historical:
 *   pnpm fetch:snapshot --no-parquet ...
 *
 *   # Добавить к существующему снапшоту (не перезатирать):
 *   pnpm fetch:snapshot --mode add ...
 *
 *   # Сухой прогон (не записывать):
 *   pnpm fetch:snapshot --dry-run ...
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

// ──────────────────────────────────────────────────
// Типы (повторяем нужные минимальные формы контрактов)
// ──────────────────────────────────────────────────

interface StrategyRef { name: string; version: string; }
interface BotRun {
  runId: string;
  mode: string;
  status: string;
  strategy: StrategyRef;
  startedAtMs: number;
  finishedAtMs: number | null;
  lastSeenMs: number;
  symbols: string[];
}

interface ClosedTrade {
  tradeId: string;
  runId: string;
  symbol: string;
  side: string;
  openedAtMs: number;
  closedAtMs: number;
  realizedPnl: string;
  pnlPct: string | null;
  isWin: boolean | null;
  closeReason: string | null;
}

interface OpsEvent {
  category: string;
  severity: string | null;
  runId?: string;
  tradeId?: string | null;
  tsMs: number;
  safeMessage: string;
}

interface DecisionEntry {
  category: string;
  runId: string;
  botId: string;
  symbol: string;
  side: string;
  reason: string;
  tsMs: number;
  safeMessage: string;
}

interface OpsData {
  runs: BotRun[];
  tradesByRun: Record<string, ClosedTrade[]>;
  eventsByRun: Record<string, OpsEvent[]>;
  decisionsByRun: Record<string, DecisionEntry[]>;
}

interface Bar {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface FundingEntry { tsMs: number; symbol: string; rate: number; }
interface OIEntry { tsMs: number; symbol: string; oiUsd: number; }
interface LiqEntry { tsMs: number; symbol: string; longUsd: number; shortUsd: number; }

interface HistoricalBundle {
  barsBySymbolAndTimeframe: Record<string, Record<string, Bar[]>>;
  fundingBySymbol: Record<string, FundingEntry[]>;
  openInterestBySymbol: Record<string, OIEntry[]>;
  liquidationsBySymbol: Record<string, LiqEntry[]>;
}

// ──────────────────────────────────────────────────
// CLI args
// ──────────────────────────────────────────────────

interface Cfg {
  vps: string | null;
  dbUrl: string;
  parquetRoot: string | null;
  dateFrom: string;
  dateTo: string;
  symbols: string[];
  ref: string;
  mode: 'replace' | 'add';
  sshKey: string;
  sshPort: number;
  tunnelPort: number;
  parquetLocal: string;
  noTunnel: boolean;
  noParquet: boolean;
  dryRun: boolean;
}

function parseArgs(): Cfg {
  const args = process.argv.slice(2);

  function flag(name: string): boolean {
    return args.includes(`--${name}`);
  }
  function opt(name: string, fallback?: string): string {
    const i = args.indexOf(`--${name}`);
    if (i !== -1 && args[i + 1]) return args[i + 1]!;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required --${name}`);
  }
  function optMaybe(name: string): string | null {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1]! : null;
  }

  if (flag('help') || flag('h')) {
    console.log((fetchSnapshotDoc).trim());
    process.exit(0);
  }

  return {
    vps: optMaybe('vps'),
    dbUrl: opt('db-url'),
    parquetRoot: optMaybe('parquet-root'),
    dateFrom: opt('from'),
    dateTo: opt('to'),
    symbols: optMaybe('symbols')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) ?? [],
    ref: opt('ref'),
    mode: (optMaybe('mode') ?? 'replace') as 'replace' | 'add',
    sshKey: opt('ssh-key', `${process.env['HOME'] ?? '~'}/.ssh/id_rsa`),
    sshPort: parseInt(opt('ssh-port', '22'), 10),
    tunnelPort: parseInt(opt('tunnel-port', '15432'), 10),
    parquetLocal: opt('parquet-local', '/tmp/mock-parquet'),
    noTunnel: flag('no-tunnel'),
    noParquet: flag('no-parquet'),
    dryRun: flag('dry-run'),
  };
}

const fetchSnapshotDoc = `
fetch-snapshot.ts — fetch VPS slice → trading-mock-platform snapshot

Usage:
  pnpm fetch:snapshot --vps user@host \\
    --db-url "postgres://user:pass@localhost:5432/db" \\
    --parquet-root /data/historical \\
    --from 2026-06-01 --to 2026-06-16 \\
    --symbols BTCUSDT,ETHUSDT --ref 2026-06-16-vps

Options:
  --vps USER@HOST         SSH target (not needed with --no-tunnel)
  --db-url URL            Postgres connection URL
  --parquet-root PATH     Parquet root on VPS (schema_version=1/ layout)
  --from YYYY-MM-DD       Period start (inclusive, UTC)
  --to   YYYY-MM-DD       Period end (inclusive, UTC)
  --symbols SYM,SYM       Symbols for historical slice (default: from trades)
  --ref  NAME             Snapshot ref name (dir under data/snapshots/)
  --mode replace|add      replace=overwrite (default); add=merge with existing
  --ssh-key PATH          SSH key (default: ~/.ssh/id_rsa)
  --ssh-port N            SSH port (default: 22)
  --tunnel-port N         Local port for SSH tunnel to Postgres (default: 15432)
  --parquet-local DIR     Local dir for rsync'd parquet files (default: /tmp/mock-parquet)
  --no-tunnel             Skip SSH tunnel (Postgres reachable directly)
  --no-parquet            Skip historical data (ops-read only)
  --dry-run               Print stats without writing files
`;

// ──────────────────────────────────────────────────
// Utils
// ──────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT_DIR = join(REPO_ROOT, 'data', 'snapshots');
const NOW_MS = Date.now();

function dateToMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getTime();
}

function periodToMs(from: string, to: string): [number, number] {
  return [dateToMs(from), dateToMs(to) + 86_400_000];
}

function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────
// SSH туннель
// ──────────────────────────────────────────────────

function extractRemoteHostPort(url: string): [string, number] {
  const u = new URL(url);
  return [u.hostname || 'localhost', u.port ? parseInt(u.port, 10) : 5432];
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const { createConnection } = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        resolve();
      });
    });
    const alive = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (alive) return;
    await sleep(500);
  }
  throw new Error(`SSH tunnel did not open port ${port} within ${timeoutMs}ms`);
}

async function openTunnel(cfg: Cfg, dbUrl: string): Promise<ChildProcess> {
  const [remoteHost, remotePort] = extractRemoteHostPort(dbUrl);
  const args = [
    '-N',
    '-L', `${cfg.tunnelPort}:${remoteHost}:${remotePort}`,
    '-i', cfg.sshKey,
    '-p', String(cfg.sshPort),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ExitOnForwardFailure=yes',
    cfg.vps!,
  ];
  console.log(`[tunnel] Opening SSH tunnel → localhost:${cfg.tunnelPort}…`);
  const proc = spawn('ssh', args, { stdio: 'ignore' });
  proc.on('error', (e) => { throw new Error(`ssh spawn failed: ${e.message}`); });

  await sleep(500); // дать процессу запуститься
  if (proc.exitCode !== null) {
    throw new Error(`SSH tunnel exited early (code ${proc.exitCode}). Проверь ssh-ключ и хост.`);
  }
  await waitForPort(cfg.tunnelPort);
  console.log(`[tunnel] OK — localhost:${cfg.tunnelPort}`);
  return proc;
}

function closeTunnel(proc: ChildProcess): void {
  proc.kill('SIGTERM');
  console.log('[tunnel] Closed.');
}

// ──────────────────────────────────────────────────
// Postgres
// ──────────────────────────────────────────────────

async function fetchOps(dbUrl: string, tsFrom: number, tsTo: number): Promise<OpsData> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = (await import('pg')).default ?? await import('pg');
  const pool = new Pool({ connectionString: dbUrl });

  console.log(`[pg] Connecting to ${maskUrl(dbUrl)}`);
  const client = await pool.connect();

  try {
    // ── bot_run ────────────────────────────────────
    console.log(`[pg] Querying bot_run [${tsFrom}..${tsTo}]…`);
    const runsRes = await client.query<{
      runId: string; mode: string; status: string; strategy: string;
      startedAtMs: string; finishedAtMs: string | null; lastSeenMs: string; symbols: string[];
    }>(`
      SELECT
        r.run_id                          AS "runId",
        r.mode,
        r.status,
        r.strategy_name                   AS strategy,
        r.started_at_ms                   AS "startedAtMs",
        r.finished_at_ms                  AS "finishedAtMs",
        (extract(epoch FROM now()) * 1000)::bigint AS "lastSeenMs",
        ARRAY(
          SELECT DISTINCT t.symbol
          FROM canonical.trade t
          WHERE t.run_id = r.run_id
        ) AS symbols
      FROM canonical.bot_run r
      WHERE r.started_at_ms <= $2
        AND (r.finished_at_ms IS NULL OR r.finished_at_ms >= $1)
        AND r.mode IN ('paper','live','backtest')
      ORDER BY r.started_at_ms
    `, [tsFrom, tsTo]);

    const runs: BotRun[] = runsRes.rows.map((r) => ({
      runId: r.runId,
      mode: r.mode,
      status: r.status === 'crashed' || r.status === 'aborted' ? 'finished' : r.status,
      strategy: { name: r.strategy ?? 'unknown', version: 'unknown' },
      startedAtMs: Number(r.startedAtMs),
      finishedAtMs: r.finishedAtMs !== null ? Number(r.finishedAtMs) : null,
      lastSeenMs: Number(r.lastSeenMs),
      symbols: Array.isArray(r.symbols) ? r.symbols.filter(Boolean) : [],
    }));
    console.log(`[pg] Found ${runs.length} run(s)`);

    if (runs.length === 0) {
      return { runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {} };
    }

    const runIds = runs.map((r) => r.runId);
    const tradesByRun: Record<string, ClosedTrade[]> = Object.fromEntries(runIds.map((id) => [id, []]));
    const eventsByRun: Record<string, OpsEvent[]> = Object.fromEntries(runIds.map((id) => [id, []]));
    const decisionsByRun: Record<string, DecisionEntry[]> = Object.fromEntries(runIds.map((id) => [id, []]));

    // ── trades ────────────────────────────────────
    console.log(`[pg] Querying trades for ${runIds.length} run(s)…`);
    const tradesRes = await client.query<{
      tradeId: string; runId: string; symbol: string; side: string;
      openedAtMs: string; closedAtMs: string; realizedPnl: string;
      pnlPct: string | null; isWin: boolean | null; closeReason: string | null;
    }>(`
      SELECT
        trade_id      AS "tradeId",
        run_id        AS "runId",
        symbol,
        side,
        opened_at_ms  AS "openedAtMs",
        closed_at_ms  AS "closedAtMs",
        pnl::text     AS "realizedPnl",
        pnl_pct::text AS "pnlPct",
        is_win        AS "isWin",
        close_reason  AS "closeReason"
      FROM canonical.trade
      WHERE run_id = ANY($1)
        AND closed_at_ms IS NOT NULL
        AND closed_at_ms BETWEEN $2 AND $3
      ORDER BY closed_at_ms
    `, [runIds, tsFrom, tsTo]);

    console.log(`[pg] Found ${tradesRes.rows.length} closed trade(s)`);
    for (const t of tradesRes.rows) {
      const rid = t.runId;
      if (rid in tradesByRun) {
        tradesByRun[rid]!.push({
          tradeId: t.tradeId,
          runId: rid,
          symbol: t.symbol,
          side: t.side,
          openedAtMs: Number(t.openedAtMs),
          closedAtMs: Number(t.closedAtMs),
          realizedPnl: t.realizedPnl ?? '0',
          pnlPct: t.pnlPct ?? '0',
          isWin: t.isWin ?? null,
          closeReason: t.closeReason ?? null,
        });
      }
    }

    // ── operational_events ────────────────────────
    console.log('[pg] Querying operational_events…');
    const eventsRes = await client.query<{
      runId: string; tradeId: string | null; category: string;
      severity: string | null; tsMs: string; safeMessage: string;
    }>(`
      SELECT
        run_id         AS "runId",
        trade_id       AS "tradeId",
        event_type     AS category,
        severity,
        business_ts_ms AS "tsMs",
        event_type     AS "safeMessage"
      FROM canonical.operational_event
      WHERE run_id = ANY($1)
        AND business_ts_ms BETWEEN $2 AND $3
      ORDER BY business_ts_ms
      LIMIT 10000
    `, [runIds, tsFrom, tsTo]);

    console.log(`[pg] Found ${eventsRes.rows.length} event(s)`);
    for (const e of eventsRes.rows) {
      const rid = e.runId;
      if (rid in eventsByRun) {
        eventsByRun[rid]!.push({
          category: e.category,
          severity: e.severity,
          tradeId: e.tradeId ?? null,
          tsMs: Number(e.tsMs),
          safeMessage: e.safeMessage,
        });
      }
    }

    // ── decision_log ──────────────────────────────
    console.log('[pg] Querying decision_log…');
    const decisionsRes = await client.query<{
      runId: string; botId: string; symbol: string; side: string;
      category: string; reason: string; tsMs: string; safeMessage: string;
    }>(`
      SELECT
        run_id         AS "runId",
        bot_id         AS "botId",
        symbol,
        side,
        decision_type  AS category,
        reason,
        business_ts_ms AS "tsMs",
        decision_type  AS "safeMessage"
      FROM canonical.decision_log
      WHERE run_id = ANY($1)
        AND business_ts_ms BETWEEN $2 AND $3
      ORDER BY business_ts_ms
      LIMIT 10000
    `, [runIds, tsFrom, tsTo]);

    console.log(`[pg] Found ${decisionsRes.rows.length} decision(s)`);
    for (const d of decisionsRes.rows) {
      const rid = d.runId;
      if (rid in decisionsByRun) {
        decisionsByRun[rid]!.push({
          runId: rid,
          category: d.category,
          botId: d.botId,
          symbol: d.symbol,
          side: d.side,
          reason: d.reason,
          tsMs: Number(d.tsMs),
          safeMessage: d.safeMessage,
        });
      }
    }

    return { runs, tradesByRun, eventsByRun, decisionsByRun };
  } finally {
    client.release();
    await pool.end();
  }
}

// ──────────────────────────────────────────────────
// rsync Parquet
// ──────────────────────────────────────────────────

function datesInPeriod(tsFrom: number, tsTo: number): string[] {
  const dates: string[] = [];
  const dayMs = 86_400_000;
  for (let t = Math.floor(tsFrom / dayMs) * dayMs; t < tsTo; t += dayMs) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

function rsyncParquet(cfg: Cfg, tsFrom: number, tsTo: number): void {
  mkdirSync(cfg.parquetLocal, { recursive: true });
  const keyPath = cfg.sshKey.startsWith('~')
    ? join(process.env['HOME'] ?? '', cfg.sshKey.slice(1))
    : cfg.sshKey;
  const sshBase = existsSync(keyPath)
    ? `ssh -i ${keyPath} -p ${cfg.sshPort} -o StrictHostKeyChecking=no`
    : `ssh -p ${cfg.sshPort} -o StrictHostKeyChecking=no`;
  const dates = datesInPeriod(tsFrom, tsTo);
  const args = ['-avz', '--progress'];
  for (const sv of ['schema_version=1', 'schema_version=2']) {
    args.push(`--include=${sv}/`);
    for (const d of dates) {
      args.push(`--include=${sv}/date=${d}/`);
      args.push(`--include=${sv}/date=${d}/**`);
    }
  }
  args.push('--exclude=*', `--rsh=${sshBase}`, `${cfg.vps!}:${cfg.parquetRoot}/`, `${cfg.parquetLocal}/`);
  console.log(`[rsync] Syncing parquet [${dates[0]}..${dates.at(-1)}] (${dates.length} day(s))…`);
  const result = spawnSync('rsync', args, { stdio: 'inherit' });
  if (result.status !== 0 && result.status !== 24) {
    throw new Error(`rsync failed (exit ${result.status ?? 'null'})`);
  }
  console.log('[rsync] Done.');
}

// ──────────────────────────────────────────────────
// Parquet читалка (hyparquet)
// ──────────────────────────────────────────────────

interface MinuteRow {
  ts: number;
  sym: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
  funding: number | null;
  liqLong: number | null;
  liqShort: number | null;
}

async function readParquetDir(localRoot: string, symbols: string[], tsFrom: number, tsTo: number): Promise<HistoricalBundle> {
  type AsyncBuffer = { byteLength: number; slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer> };
  const { parquetReadObjects } = await import('hyparquet');
  const { asyncBufferFromFile } = (await import('hyparquet/src/node.js')) as { asyncBufferFromFile: (path: string) => Promise<AsyncBuffer> };

  const symSet = new Set(symbols.map((s) => s.toUpperCase()));
  const partFiles: Array<{ path: string; sv: 1 | 2 }> = [];

  // Обходим schema_version=1 и schema_version=2
  for (const sv of [1, 2] as const) {
    const svDir = join(localRoot, `schema_version=${sv}`);
    if (!existsSync(svDir)) continue;
    const dateDirs = await fsp.readdir(svDir, { withFileTypes: true });
    for (const entry of dateDirs) {
      if (!entry.isDirectory() || !entry.name.startsWith('date=')) continue;
      const dateStr = entry.name.slice(5); // YYYY-MM-DD
      const dMs = dateToMs(dateStr);
      if (dMs + 86_400_000 < tsFrom || dMs > tsTo) continue;
      const partDir = join(svDir, entry.name);
      const files = await fsp.readdir(partDir);
      for (const f of files.sort()) {
        if (f.startsWith('part-') && f.endsWith('.parquet')) {
          partFiles.push({ path: join(partDir, f), sv });
        }
      }
    }
  }

  console.log(`[parquet] Reading ${partFiles.length} part-file(s)…`);
  if (partFiles.length === 0) return emptyHistorical();

  const bySymbol: Record<string, MinuteRow[]> = {};

  for (const { path, sv } of partFiles) {
    const columns = sv === 2
      ? ['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd']
      : ['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd'];

    const file = await asyncBufferFromFile(path);
    const rows = await parquetReadObjects({ file, columns }) as Record<string, unknown>[];

    for (const r of rows) {
      const ts = typeof r['minute_ts'] === 'bigint' ? Number(r['minute_ts']) : Number(r['minute_ts']);
      if (ts < tsFrom || ts >= tsTo) continue;
      const sym = String(r['symbol']).trim().toUpperCase();
      if (!symSet.has(sym)) continue;
      if (!bySymbol[sym]) bySymbol[sym] = [];
      const toNum = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v));
      const toNumOrNull = (v: unknown): number | null => {
        if (v === null || v === undefined) return null;
        const n = toNum(v);
        return Number.isFinite(n) ? n : null;
      };
      bySymbol[sym]!.push({
        ts,
        sym,
        open: toNum(r['open']),
        high: toNum(r['high']),
        low: toNum(r['low']),
        close: toNum(r['close']),
        volume: toNum(r['volume']),
        oi: toNumOrNull(r['oi_total_usd']),
        funding: toNumOrNull(r['funding_rate']),
        liqLong: toNumOrNull(r['liq_long_usd']),
        liqShort: toNumOrNull(r['liq_short_usd']),
      });
    }
  }

  const totalRows = Object.values(bySymbol).reduce((s, v) => s + v.length, 0);
  console.log(`[parquet] ${totalRows} rows across ${Object.keys(bySymbol).length} symbol(s)`);

  return aggregateHistorical(bySymbol);
}

const TF_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

function aggregateHistorical(bySymbol: Record<string, MinuteRow[]>): HistoricalBundle {
  const TIMEFRAMES = ['1h', '1d'];
  const barsBySymbolAndTimeframe: Record<string, Record<string, Bar[]>> = {};
  const fundingBySymbol: Record<string, FundingEntry[]> = {};
  const openInterestBySymbol: Record<string, OIEntry[]> = {};
  const liquidationsBySymbol: Record<string, LiqEntry[]> = {};

  for (const [sym, rows] of Object.entries(bySymbol)) {
    rows.sort((a, b) => a.ts - b.ts);
    barsBySymbolAndTimeframe[sym] = {};

    for (const tf of TIMEFRAMES) {
      const tfMs = TF_MS[tf] ?? 3_600_000;
      const buckets = new Map<number, Bar>();
      for (const r of rows) {
        const bts = Math.floor(r.ts / tfMs) * tfMs;
        const b = buckets.get(bts);
        if (!b) {
          buckets.set(bts, { tsMs: bts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
        } else {
          b.high = Math.max(b.high, r.high);
          b.low = Math.min(b.low, r.low);
          b.close = r.close;
          b.volume += r.volume;
        }
      }
      barsBySymbolAndTimeframe[sym]![tf] = [...buckets.values()].sort((a, b) => a.tsMs - b.tsMs);
    }

    // funding — дедуп по tsMs
    const fundMap = new Map<number, FundingEntry>();
    for (const r of rows) {
      if (r.funding !== null) fundMap.set(r.ts, { tsMs: r.ts, symbol: sym, rate: r.funding });
    }
    fundingBySymbol[sym] = [...fundMap.values()].sort((a, b) => a.tsMs - b.tsMs);

    // OI — дедуп по tsMs
    const oiMap = new Map<number, OIEntry>();
    for (const r of rows) {
      if (r.oi !== null) oiMap.set(r.ts, { tsMs: r.ts, symbol: sym, oiUsd: r.oi });
    }
    openInterestBySymbol[sym] = [...oiMap.values()].sort((a, b) => a.tsMs - b.tsMs);

    // Liquidations — дедуп по tsMs
    const liqMap = new Map<number, LiqEntry>();
    for (const r of rows) {
      if (r.liqLong !== null || r.liqShort !== null) {
        liqMap.set(r.ts, { tsMs: r.ts, symbol: sym, longUsd: r.liqLong ?? 0, shortUsd: r.liqShort ?? 0 });
      }
    }
    liquidationsBySymbol[sym] = [...liqMap.values()].sort((a, b) => a.tsMs - b.tsMs);
  }

  return { barsBySymbolAndTimeframe, fundingBySymbol, openInterestBySymbol, liquidationsBySymbol };
}

function emptyHistorical(): HistoricalBundle {
  return { barsBySymbolAndTimeframe: {}, fundingBySymbol: {}, openInterestBySymbol: {}, liquidationsBySymbol: {} };
}

// ──────────────────────────────────────────────────
// Сборка Bundle
// ──────────────────────────────────────────────────

function stubHealthFields(): Record<string, unknown> {
  return {
    runtimeHealth: { entries: [], asOf: NOW_MS },
    marketHealth: {
      status: 'ok', diagnostics: {}, streamAgeMs: 0,
      availability: 'available', asOf: NOW_MS,
    },
    executionHealth: {
      status: 'ok', recentCounts: { total: 0, errors: 0 },
      lastEventMs: NOW_MS, availability: 'available', asOf: NOW_MS,
    },
    coverage: { entries: [], availability: 'available', asOf: NOW_MS },
  };
}

function buildAnalysisByRun(
  runs: BotRun[],
  tradesByRun: Record<string, ClosedTrade[]>,
  tsFrom: number,
  tsTo: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const run of runs) {
    const trades = tradesByRun[run.runId] ?? [];
    const wins = trades.filter((t) => t.isWin).length;
    const losses = trades.length - wins;
    const pnl = trades.reduce((s, t) => s + parseFloat(t.realizedPnl || '0'), 0);
    result[run.runId] = {
      runRef: run.runId,
      opsContractVersion: 'ops.4',
      asOf: NOW_MS,
      freshness: 'fresh',
      identity: {
        mode: run.mode,
        strategy: { name: run.strategy.name, version: run.strategy.version },
        symbols: run.symbols,
      },
      period: { fromMs: tsFrom, toMs: tsTo },
      healthContext: 'fetched from VPS',
      metrics: {
        pnl: pnl.toFixed(8),
        winRate: trades.length > 0 ? Math.floor((wins * 100) / trades.length) : 0,
        maxDrawdown: '0.00000000',
        totalTrades: trades.length,
        profitFactor: '0.00',
        topTradeContributionPct: 0,
      },
      trades: trades.map((t) => ({
        tradeId: t.tradeId, symbol: t.symbol, side: t.side,
        openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs,
        realizedPnl: t.realizedPnl,
        entryReason: 'unknown', exitReason: t.closeReason ?? 'unknown',
      })),
      strategyConfig: { available: false, reason: 'not_in_sanitized_export' },
      dcaCount: { available: false, reason: 'not_safely_sourced' },
      slTpBeEvents: { available: false, reason: 'not_safely_sourced' },
      features: { available: false, reason: 'market_features_out_of_scope_in_001' },
      summaryPatterns: [`${wins} win(s), ${losses} loss(es)${trades.length > 0 ? `, pnl ${pnl.toFixed(2)}` : ''}`],
    };
  }
  return result;
}

function buildResearchByRun(
  runs: BotRun[],
  tradesByRun: Record<string, ClosedTrade[]>,
  decisionsByRun: Record<string, DecisionEntry[]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const run of runs) {
    const trades = tradesByRun[run.runId] ?? [];
    const decisions = decisionsByRun[run.runId] ?? [];
    const wins = trades.filter((t) => t.isWin).length;
    const pnl = trades.reduce((s, t) => s + parseFloat(t.realizedPnl || '0'), 0);
    result[run.runId] = {
      summary: {
        runRef: run.runId,
        mode: run.mode,
        asOf: NOW_MS,
        metrics: {
          netPnlUsd: pnl.toFixed(8),
          winRate: trades.length > 0 ? wins / trades.length : 0,
          maxDrawdownPct: '0.00000000',
          sharpe: { available: false, reason: 'not_computed' },
          totalTrades: trades.length,
        },
      },
      trades: trades.map((t) => ({
        tradeId: t.tradeId, symbol: t.symbol, side: t.side,
        openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs,
        realizedPnl: t.realizedPnl,
      })),
      decisions: decisions.map((d) => ({
        category: d.category, symbol: d.symbol, reason: d.reason, tsMs: d.tsMs,
      })),
      analysisContext: 'fetched from VPS',
    };
  }
  return result;
}

function buildBundle(
  ops: OpsData,
  historical: HistoricalBundle | null,
  tsFrom: number,
  tsTo: number,
): Record<string, unknown> {
  const bundle: Record<string, unknown> = {
    runs: ops.runs,
    tradesByRun: ops.tradesByRun,
    eventsByRun: ops.eventsByRun,
    decisionsByRun: ops.decisionsByRun,
    ...stubHealthFields(),
    analysisByRun: buildAnalysisByRun(ops.runs, ops.tradesByRun, tsFrom, tsTo),
    researchByRun: buildResearchByRun(ops.runs, ops.tradesByRun, ops.decisionsByRun),
    replay: {
      frames: [
        { offsetMs: 0, resource: 'runs' },
        { offsetMs: 1000, resource: 'runtime-health' },
      ],
    },
  };
  if (historical !== null) bundle['historical'] = historical;
  return bundle;
}

// ──────────────────────────────────────────────────
// Режим add — мёрж с существующим снапшотом
// ──────────────────────────────────────────────────

function mergeWithExisting(newBundle: Record<string, unknown>, outDir: string): Record<string, unknown> {
  const bundlePath = join(outDir, 'ops', 'bundle.json');
  if (!existsSync(bundlePath)) {
    console.log('[merge] No existing snapshot found → creating new.');
    return newBundle;
  }
  console.log('[merge] Loading existing bundle for merge…');
  const existing = JSON.parse(readFileSync(bundlePath, 'utf8')) as Record<string, unknown>;

  function mergeByRunId(old: BotRun[], next: BotRun[]): BotRun[] {
    const map = new Map<string, BotRun>(old.map((r) => [r.runId, r]));
    for (const r of next) map.set(r.runId, r);
    return [...map.values()];
  }
  function mergeDict(old: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
    return { ...old, ...next };
  }

  const merged: Record<string, unknown> = { ...existing };
  merged['runs'] = mergeByRunId((existing['runs'] as BotRun[]) ?? [], (newBundle['runs'] as BotRun[]) ?? []);
  merged['tradesByRun'] = mergeDict((existing['tradesByRun'] as Record<string, unknown>) ?? {}, (newBundle['tradesByRun'] as Record<string, unknown>) ?? {});
  merged['eventsByRun'] = mergeDict((existing['eventsByRun'] as Record<string, unknown>) ?? {}, (newBundle['eventsByRun'] as Record<string, unknown>) ?? {});
  merged['decisionsByRun'] = mergeDict((existing['decisionsByRun'] as Record<string, unknown>) ?? {}, (newBundle['decisionsByRun'] as Record<string, unknown>) ?? {});
  merged['analysisByRun'] = mergeDict((existing['analysisByRun'] as Record<string, unknown>) ?? {}, (newBundle['analysisByRun'] as Record<string, unknown>) ?? {});
  merged['researchByRun'] = mergeDict((existing['researchByRun'] as Record<string, unknown>) ?? {}, (newBundle['researchByRun'] as Record<string, unknown>) ?? {});
  for (const k of ['runtimeHealth', 'marketHealth', 'executionHealth', 'coverage', 'replay'] as const) {
    if (k in newBundle) merged[k] = newBundle[k];
  }

  // Historical: мёрж по символам, дедуп по tsMs
  const newHist = newBundle['historical'] as HistoricalBundle | undefined;
  if (newHist) {
    const oldHist = (existing['historical'] as HistoricalBundle | undefined) ?? emptyHistorical();
    const mh: HistoricalBundle = {
      barsBySymbolAndTimeframe: { ...oldHist.barsBySymbolAndTimeframe },
      fundingBySymbol: { ...oldHist.fundingBySymbol },
      openInterestBySymbol: { ...oldHist.openInterestBySymbol },
      liquidationsBySymbol: { ...oldHist.liquidationsBySymbol },
    };
    for (const [sym, tfMap] of Object.entries(newHist.barsBySymbolAndTimeframe)) {
      if (!mh.barsBySymbolAndTimeframe[sym]) mh.barsBySymbolAndTimeframe[sym] = {};
      for (const [tf, bars] of Object.entries(tfMap)) {
        const old = mh.barsBySymbolAndTimeframe[sym]![tf] ?? [];
        const byTs = new Map<number, Bar>(old.map((b) => [b.tsMs, b]));
        for (const b of bars) byTs.set(b.tsMs, b);
        mh.barsBySymbolAndTimeframe[sym]![tf] = [...byTs.values()].sort((a, b) => a.tsMs - b.tsMs);
      }
    }
    for (const field of ['fundingBySymbol', 'openInterestBySymbol', 'liquidationsBySymbol'] as const) {
      for (const [sym, entries] of Object.entries(newHist[field])) {
        const old = (mh[field][sym] as { tsMs: number }[]) ?? [];
        const byTs = new Map(old.map((e) => [e.tsMs, e]));
        for (const e of entries as { tsMs: number }[]) byTs.set(e.tsMs, e);
        (mh[field] as Record<string, unknown[]>)[sym] = [...byTs.values()].sort((a, b) => (a as { tsMs: number }).tsMs - (b as { tsMs: number }).tsMs);
      }
    }
    merged['historical'] = mh;
  }

  const runCount = (merged['runs'] as BotRun[]).length;
  const tradeCount = Object.values((merged['tradesByRun'] as Record<string, ClosedTrade[]>)).reduce((s, v) => s + v.length, 0);
  console.log(`[merge] After merge: runs=${runCount}, trades=${tradeCount}`);
  return merged;
}

// ──────────────────────────────────────────────────
// Запись снапшота
// ──────────────────────────────────────────────────

function writeSnapshot(ref: string, bundle: Record<string, unknown>, dryRun: boolean): void {
  const outDir = join(SNAPSHOT_DIR, ref);
  const opsDir = join(outDir, 'ops');
  const bundleRef = 'ops/bundle.json';
  const checksumRef = 'checksums.json';

  const bundleBytes = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
  const checksum = sha256Hex(bundleBytes);

  const hist = bundle['historical'] as HistoricalBundle | undefined;
  const runCount = (bundle['runs'] as BotRun[]).length;
  const tradeCount = Object.values((bundle['tradesByRun'] as Record<string, ClosedTrade[]>)).reduce((s, v) => s + v.length, 0);
  const symCount = hist ? Object.keys(hist.barsBySymbolAndTimeframe).length : 0;
  const barCount = hist ? Object.values(hist.barsBySymbolAndTimeframe).reduce((s, tfMap) => s + Object.values(tfMap).reduce((ss, bars) => ss + bars.length, 0), 0) : 0;

  console.log(`\n[snapshot] ref=${ref}`);
  console.log(`  runs:         ${runCount}`);
  console.log(`  trades:       ${tradeCount}`);
  console.log(`  hist symbols: ${symCount}, bars: ${barCount}`);
  console.log(`  bundle size:  ${bundleBytes.length.toLocaleString()} bytes`);
  console.log(`  checksum:     ${checksum.slice(0, 16)}…`);

  if (dryRun) {
    console.log('\n[dry-run] Files not written (--dry-run).');
    return;
  }

  mkdirSync(opsDir, { recursive: true });

  const exporterTs = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
  const manifest = {
    ref,
    createdAtMs: NOW_MS,
    bundleRef,
    checksumsRef: checksumRef,
    versions: {
      snapshotSchemaVersion: 'snapshot.1',
      opsReadContractVersion: 'ops.3',
      researchReadContractVersion: 'research.1',
      analysisContractVersion: 'ops.4',
      exporterVersion: 'fetch-snapshot.1',
      sourcePlatformCommit: `vps-fetch-${exporterTs}`,
      redactionPolicyVersion: 'redact.1',
    },
  };

  writeFileSync(join(opsDir, 'bundle.json'), bundleBytes);
  writeFileSync(join(outDir, checksumRef), JSON.stringify({ [bundleRef]: checksum }, null, 2));
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n[snapshot] Written → ${outDir}`);
  console.log(`  To serve: MOCK_SNAPSHOT_REF=${ref} pnpm start`);
}

// ──────────────────────────────────────────────────
// Patch db-url для туннеля
// ──────────────────────────────────────────────────

function patchUrlForTunnel(dbUrl: string, tunnelPort: number): string {
  const u = new URL(dbUrl);
  u.host = `127.0.0.1:${tunnelPort}`;
  return u.toString();
}

// ──────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = parseArgs();
  const [tsFrom, tsTo] = periodToMs(cfg.dateFrom, cfg.dateTo);

  console.log(`[config] Period: ${cfg.dateFrom} → ${cfg.dateTo} (${tsFrom}…${tsTo})`);
  console.log(`[config] ref=${cfg.ref}, mode=${cfg.mode}`);

  // ── Шаг 1: Postgres (с туннелем или напрямую) ──
  let tunnel: ChildProcess | null = null;
  let dbUrl = cfg.dbUrl;

  if (!cfg.noTunnel) {
    if (!cfg.vps) {
      console.error('[error] --vps required unless --no-tunnel is set.');
      process.exit(1);
    }
    dbUrl = patchUrlForTunnel(cfg.dbUrl, cfg.tunnelPort);
    tunnel = await openTunnel(cfg, cfg.dbUrl);
  }

  let ops: OpsData;
  try {
    ops = await fetchOps(dbUrl, tsFrom, tsTo);
  } finally {
    if (tunnel) closeTunnel(tunnel);
  }

  if (ops.runs.length === 0) {
    console.warn('[warn] No runs found for the period. Snapshot will have empty ops data.');
  }

  // Символы для historical
  let symbols = cfg.symbols;
  if (symbols.length === 0) {
    const symSet = new Set<string>();
    for (const trades of Object.values(ops.tradesByRun)) {
      for (const t of trades) if (t.symbol) symSet.add(t.symbol);
    }
    symbols = [...symSet].sort();
    if (symbols.length > 0) console.log(`[config] Symbols from trades: ${symbols.join(', ')}`);
    else console.warn('[warn] No symbols found in trades — historical will be empty.');
  }

  // ── Шаг 2: Parquet ────────────────────────────
  let historical: HistoricalBundle | null = null;

  if (!cfg.noParquet && cfg.parquetRoot && symbols.length > 0) {
    let parquetLocal = cfg.parquetRoot;
    if (!cfg.noTunnel && cfg.vps) {
      rsyncParquet(cfg, tsFrom, tsTo);
      parquetLocal = cfg.parquetLocal;
    }
    historical = await readParquetDir(parquetLocal, symbols, tsFrom, tsTo);
  } else if (cfg.noParquet) {
    console.log('[config] --no-parquet: skipping historical data.');
  }

  // ── Шаг 3: Сборка ────────────────────────────
  let bundle = buildBundle(ops, historical, tsFrom, tsTo);

  // ── Шаг 4: Мёрж ──────────────────────────────
  if (cfg.mode === 'add') {
    bundle = mergeWithExisting(bundle, join(SNAPSHOT_DIR, cfg.ref));
  }

  // ── Шаг 5: Запись ─────────────────────────────
  writeSnapshot(cfg.ref, bundle, cfg.dryRun);
}

main().catch((e) => {
  console.error('[fatal]', e instanceof Error ? e.message : e);
  process.exit(1);
});
