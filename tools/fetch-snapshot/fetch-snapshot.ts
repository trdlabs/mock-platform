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
 * Секрет (URL Postgres) НИКОГДА не передаётся аргументом: pnpm печатает командную строку
 * скрипта перед запуском, а argv виден через /proc. Только env или файл 0600 — см. resolveDbUrl.
 *
 * Использование:
 *   export MOCK_SNAPSHOT_DB_URL="postgres://user:pass@localhost:5432/db"
 *   pnpm fetch:snapshot \
 *     --vps user@host \
 *     --parquet-root /data/historical \
 *     --from 2026-06-01 --to 2026-06-16 \
 *     --symbols BTCUSDT,ETHUSDT \
 *     --ref 2026-06-16-vps
 *
 *   # Если postgres доступен напрямую (VPN/прямой):
 *   pnpm fetch:snapshot --no-tunnel ...
 *
 *   # Секрет из файла вместо переменной окружения:
 *   pnpm fetch:snapshot --db-url-file ~/.config/trdlabs/vps-db-url ...
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
import { bundleRefForByteLength, encodeBundleFileBytes } from '../../src/snapshot/bundle-io.js';
import * as fsp from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { buildTradeEvidenceByTrade, type EvidenceTradeRow, type EvidenceLifecycleRow, type TradeEvidenceOut } from './trade-evidence-map.js';
// Единственная точка чтения переменных окружения — src/env.ts (контракт env-schema.1, env-catalog item 5).
import { loadEnv, type Env } from '../../src/env.js';
import { classifyCloseReason } from '../../src/contract/ops-read/close-reason.js';

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
  entryPrice: string | null;
  exitPrice: string | null;
  realizedPnl: string;
  pnlPct: string | null;
  isWin: boolean | null;
  closeReason: string | null;
  closeReasonRaw: string | null;
}

interface OpsEvent {
  category: string;
  severity: string | null;
  /** Required by the snapshot bundle schema. Kept non-optional so omitting it fails the typecheck
   *  rather than only failing to load — it went unnoticed while every exported run had zero events. */
  runId: string;
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
  tradeEvidenceByTrade: Record<string, TradeEvidenceOut>;
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
interface OIEntry { tsMs: number; symbol: string; openInterestUsd: number; }
interface LiqEntry { tsMs: number; symbol: string; side: 'long' | 'short'; sizeUsd: number; }

/** Mirrors @trdlabs/sdk CanonicalRowV2 — inlined so tools/ stays import-clean. */
interface CanonicalRowV2 {
  schema_version: 2;
  minute_ts: number;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  oi_total_usd: number | null;
  funding_rate: number | null;
  liq_long_usd: number | null;
  liq_short_usd: number | null;
  has_oi: boolean;
  has_funding: boolean;
  has_liquidations: boolean;
  taker_buy_volume_usd: number | null;
  taker_sell_volume_usd: number | null;
  has_taker_flow: boolean;
}

interface HistoricalBundle {
  barsBySymbolAndTimeframe: Record<string, Record<string, Bar[]>>;
  fundingBySymbol: Record<string, FundingEntry[]>;
  openInterestBySymbol: Record<string, OIEntry[]>;
  liquidationsBySymbol: Record<string, LiqEntry[]>;
  rowsBySymbol?: Record<string, CanonicalRowV2[]>;
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
  /** $HOME из типизированного env — для tilde-экспансии --ssh-key (null, если не задан ОС). */
  homeDir: string | null;
}

/** Env var carrying the Postgres URL. Named, exported, and asserted on by the tests so the one
 *  supported channel cannot be renamed by accident. */
export const DB_URL_ENV = 'MOCK_SNAPSHOT_DB_URL';

/** Read `--name VALUE` or `--name=VALUE`. The rest of this CLI only understands the spaced form;
 *  this helper exists so the two flags that participate in the secret path accept both, rather than
 *  silently ignoring a spelling the user reasonably expects to work. */
function optionValue(args: readonly string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

export interface SecretFileReader {
  read(path: string): string;
  mode(path: string): number;
}

const REAL_FILES: SecretFileReader = {
  read: (p) => readFileSync(p, 'utf8'),
  mode: (p) => statSync(p).mode,
};

/**
 * Resolve the Postgres URL from a channel that is not `process.argv`.
 *
 * `--db-url` used to carry it, and that leaked the password on every run: pnpm prints the resolved
 * command line (`> tsx tools/fetch-snapshot/fetch-snapshot.ts --db-url postgres://user:pw@…`) before
 * executing a script, so the secret landed in the terminal, in any captured transcript, and in CI
 * logs — and `process.argv` is world-readable through `/proc/<pid>/cmdline` for the process's whole
 * lifetime. Neither is fixed by masking our own output, because neither is our output.
 *
 * So the flag is **fatal**, not deprecated: a tolerated `--db-url` still leaks before we ever get to
 * warn about it. Two channels remain — the environment, and a private file named BY PATH (the path
 * is not a secret; the contents are, and they never enter argv).
 */
export function resolveDbUrl(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  files: SecretFileReader = REAL_FILES,
): string {
  // BOTH spellings. `--db-url=postgres://…` is a single argv entry, so it reaches pnpm's banner and
  // /proc exactly like the space-separated form — blocking only one spelling blocks nothing.
  // The `=` check must not swallow `--db-url-file=…`, which shares the prefix and is legitimate.
  if (args.some((a) => a === '--db-url' || a.startsWith('--db-url='))) {
    throw new Error(
      `--db-url is not supported: pnpm echoes the command line, so the password would be printed on every run. ` +
      `Pass it as ${DB_URL_ENV}=… in the environment, or as --db-url-file <path> to a 0600 file.`,
    );
  }

  const filePath = optionValue(args, '--db-url-file');
  if (filePath) {
    // A file anyone can read is not a secret store. Refuse rather than silently accept it — the
    // whole point of moving off argv is that the URL stops being readable by other local users.
    const mode = files.mode(filePath);
    if ((mode & 0o077) !== 0) {
      throw new Error(`${filePath} is group/other-readable (mode ${(mode & 0o777).toString(8)}); chmod 0600 it first`);
    }
    const fromFile = files.read(filePath).trim();
    if (!fromFile) throw new Error(`${filePath} is empty`);
    return fromFile;
  }

  const fromEnv = (env[DB_URL_ENV] ?? '').trim();
  if (fromEnv) return fromEnv;

  throw new Error(
    `No Postgres URL. Set ${DB_URL_ENV} in the environment, or pass --db-url-file <path> to a 0600 file.`,
  );
}

function parseArgs(env: Env): Cfg {
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
    dbUrl: resolveDbUrl(args, { [DB_URL_ENV]: env.MOCK_SNAPSHOT_DB_URL }),
    parquetRoot: optMaybe('parquet-root'),
    dateFrom: opt('from'),
    dateTo: opt('to'),
    symbols: optMaybe('symbols')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) ?? [],
    ref: opt('ref'),
    mode: (optMaybe('mode') ?? 'replace') as 'replace' | 'add',
    sshKey: opt('ssh-key', `${env.HOME ?? '~'}/.ssh/id_rsa`),
    sshPort: parseInt(opt('ssh-port', '22'), 10),
    tunnelPort: parseInt(opt('tunnel-port', '15432'), 10),
    parquetLocal: opt('parquet-local', '/tmp/mock-parquet'),
    noTunnel: flag('no-tunnel'),
    noParquet: flag('no-parquet'),
    dryRun: flag('dry-run'),
    homeDir: env.HOME ?? null,
  };
}

export const fetchSnapshotDoc = `
fetch-snapshot.ts — fetch VPS slice → trading-mock-platform snapshot

The Postgres URL is a secret and is NEVER a command-line argument: pnpm prints the
command line before running the script, and argv is readable via /proc. Supply it as
${DB_URL_ENV} in the environment, or point --db-url-file at a 0600 file.

Usage:
  export ${DB_URL_ENV}="postgres://user@localhost:5432/db"   # password included
  pnpm fetch:snapshot --vps user@host \\
    --parquet-root /data/historical \\
    --from 2026-06-01 --to 2026-06-16 \\
    --symbols BTCUSDT,ETHUSDT --ref 2026-06-16-vps

  # or, keeping it out of the shell environment entirely:
  pnpm fetch:snapshot --db-url-file ~/.config/trdlabs/vps-db-url --vps user@host ...

Options:
  --vps USER@HOST         SSH target (not needed with --no-tunnel)
  --db-url-file PATH      File holding the Postgres URL (mode 0600; alternative to ${DB_URL_ENV})
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

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
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
      return { runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {}, tradeEvidenceByTrade: {} };
    }

    const runIds = runs.map((r) => r.runId);
    const tradesByRun: Record<string, ClosedTrade[]> = Object.fromEntries(runIds.map((id) => [id, []]));
    const eventsByRun: Record<string, OpsEvent[]> = Object.fromEntries(runIds.map((id) => [id, []]));
    const decisionsByRun: Record<string, DecisionEntry[]> = Object.fromEntries(runIds.map((id) => [id, []]));

    // ── trades ────────────────────────────────────
    console.log(`[pg] Querying trades for ${runIds.length} run(s)…`);
    const tradesRes = await client.query<{
      tradeId: string; runId: string; symbol: string; side: string;
      openedAtMs: string; closedAtMs: string; entryPrice: string | null; exitPrice: string | null;
      realizedPnl: string; pnlPct: string | null; isWin: boolean | null; closeReasonRaw: string | null;
    }>(`
      SELECT
        trade_id      AS "tradeId",
        run_id        AS "runId",
        symbol,
        side,
        opened_at_ms  AS "openedAtMs",
        closed_at_ms  AS "closedAtMs",
        avg_entry::text  AS "entryPrice",
        exit_price::text AS "exitPrice",
        pnl::text     AS "realizedPnl",
        pnl_pct::text AS "pnlPct",
        is_win        AS "isWin",
        close_reason  AS "closeReasonRaw"
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
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          realizedPnl: t.realizedPnl ?? '0',
          pnlPct: t.pnlPct ?? '0',
          isWin: t.isWin ?? null,
          closeReasonRaw: t.closeReasonRaw ?? null,
          closeReason: classifyCloseReason(t.closeReasonRaw ?? null),
        });
      }
    }

    const evidenceTradeRows: EvidenceTradeRow[] = tradesRes.rows.map((t) => ({
      tradeId: t.tradeId, runId: t.runId, symbol: t.symbol, side: t.side as 'long' | 'short',
      openedAtMs: Number(t.openedAtMs), closedAtMs: Number(t.closedAtMs),
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      realizedPnl: t.realizedPnl ?? '0', pnlPct: t.pnlPct ?? '0', closeReason: classifyCloseReason(t.closeReasonRaw ?? null), closeReasonRaw: t.closeReasonRaw ?? null,
    }));

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
          runId: rid,
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

    // ── trade_lifecycle_event (ops.4 Surface A) ──
    const tradeIds = evidenceTradeRows.map((t) => t.tradeId);
    let tradeEvidenceByTrade: Record<string, TradeEvidenceOut> = {};
    if (tradeIds.length > 0) {
      console.log(`[pg] Querying trade_lifecycle_event for ${tradeIds.length} trade(s)…`);
      const lifeRes = await client.query<{
        tradeId: string; eventType: string; tsMs: string;
        fillPrice: string | null; triggerPrice: string | null; qty: string | null; reason: string | null;
      }>(`
        SELECT
          trade_id            AS "tradeId",
          event_type          AS "eventType",
          business_ts_ms::text AS "tsMs",
          fill_price::text     AS "fillPrice",
          trigger_price::text  AS "triggerPrice",
          qty::text            AS "qty",
          reason
        FROM canonical.trade_lifecycle_event
        WHERE trade_id = ANY($1)
        ORDER BY trade_id, sequence_in_trade ASC
      `, [tradeIds]);
      const lifecycleRows: EvidenceLifecycleRow[] = lifeRes.rows.map((r) => ({
        tradeId: r.tradeId, eventType: r.eventType, tsMs: Number(r.tsMs),
        fillPrice: r.fillPrice, triggerPrice: r.triggerPrice, qty: r.qty, reason: r.reason,
      }));
      tradeEvidenceByTrade = buildTradeEvidenceByTrade(evidenceTradeRows, lifecycleRows);
    }

    return { runs, tradesByRun, eventsByRun, decisionsByRun, tradeEvidenceByTrade };
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
    ? join(cfg.homeDir ?? '', cfg.sshKey.slice(1))
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

export interface MinuteRow {
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
  takerBuy: number | null;
  takerSell: number | null;
}

export function minuteRowToCanonicalRow(row: MinuteRow): CanonicalRowV2 {
  const hasOi = row.oi !== null;
  const hasFunding = row.funding !== null;
  const hasLiq = (row.liqLong ?? 0) > 0 || (row.liqShort ?? 0) > 0;
  const hasTaker = row.takerBuy !== null || row.takerSell !== null;
  return {
    schema_version: 2,
    minute_ts: row.ts,
    symbol: row.sym,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    turnover: row.close * row.volume,
    oi_total_usd: row.oi,
    funding_rate: row.funding,
    liq_long_usd: row.liqLong,
    liq_short_usd: row.liqShort,
    has_oi: hasOi,
    has_funding: hasFunding,
    has_liquidations: hasLiq,
    taker_buy_volume_usd: row.takerBuy,
    taker_sell_volume_usd: row.takerSell,
    has_taker_flow: hasTaker,
  };
}

/** Read the cached parquet tree into per-symbol minute rows.
 *
 *  **Ordering is part of the contract, not an accident of the filesystem.** The same minute can be
 *  present more than once — the schema_version=1→2 migration and a platform update that paused and
 *  back-filled writes both produce re-writes — and downstream `dedupeRowsBySymbol` resolves those
 *  last-writer-wins. That rule is only reproducible if "last" is defined, so part-files are visited
 *  in a fully sorted order and the precedence is:
 *
 *    schema_version ascending, then date= ascending, then part-file name ascending.
 *
 *  So a schema_version=2 row beats a schema_version=1 row for the same minute, and within one
 *  partition the lexicographically last part-file wins. `readdir` returns entries in filesystem
 *  order, which differs between machines — hence the explicit sorts.
 *
 *  Each row is also checked to fall inside the `date=` partition that holds it. That is what lets
 *  consumers scope a duplicate search to a single day; a row that escaped its partition would make
 *  a per-day dedup silently incomplete, so it is rejected rather than tolerated. */
export async function readParquetDir(localRoot: string, symbols: string[], tsFrom: number, tsTo: number): Promise<HistoricalBundle> {
  type AsyncBuffer = { byteLength: number; slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer> };
  const { parquetReadObjects } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const { asyncBufferFromFile } = (await import('hyparquet/src/node.js')) as { asyncBufferFromFile: (path: string) => Promise<AsyncBuffer> };

  const symSet = new Set(symbols.map((s) => s.toUpperCase()));
  const partFiles: Array<{ path: string; sv: 1 | 2; dayStart: number }> = [];

  // schema_version ascending → date= ascending → part-file ascending. Every level is sorted so the
  // last-writer-wins precedence documented above is reproducible on any machine.
  for (const sv of [1, 2] as const) {
    const svDir = join(localRoot, `schema_version=${sv}`);
    if (!existsSync(svDir)) continue;
    const dateDirs = (await fsp.readdir(svDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('date='))
      .map((e) => e.name)
      .sort();
    for (const name of dateDirs) {
      const dateStr = name.slice(5); // YYYY-MM-DD
      const dMs = dateToMs(dateStr);
      if (dMs + 86_400_000 < tsFrom || dMs > tsTo) continue;
      const partDir = join(svDir, name);
      const files = await fsp.readdir(partDir);
      for (const f of files.sort()) {
        if (f.startsWith('part-') && f.endsWith('.parquet')) {
          partFiles.push({ path: join(partDir, f), sv, dayStart: dMs });
        }
      }
    }
  }

  console.log(`[parquet] Reading ${partFiles.length} part-file(s)…`);
  if (partFiles.length === 0) return emptyHistorical();

  const bySymbol: Record<string, MinuteRow[]> = {};

  for (const { path, sv, dayStart } of partFiles) {
    const columns = sv === 2
      ? ['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd',
          'taker_buy_volume_usd', 'taker_sell_volume_usd']
      : ['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd'];

    const file = await asyncBufferFromFile(path);
    const rows = await parquetReadObjects({ file, columns, compressors }) as Record<string, unknown>[];

    for (const r of rows) {
      const ts = typeof r['minute_ts'] === 'bigint' ? Number(r['minute_ts']) : Number(r['minute_ts']);
      // Checked BEFORE the window filter, so an escaped row cannot slip past by also being out of
      // range. A row outside its own date= partition breaks the assumption that all versions of a
      // minute sit together, which is what makes a per-day duplicate scope complete.
      if (ts < dayStart || ts >= dayStart + 86_400_000) {
        throw new Error(
          `${path}: minute_ts ${ts} falls outside its date= partition [${dayStart}, ${dayStart + 86_400_000}) — ` +
            `duplicate resolution assumes every version of a minute lives under that minute's own date`,
        );
      }
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
        takerBuy: sv === 2 ? toNumOrNull(r['taker_buy_volume_usd']) : null,
        takerSell: sv === 2 ? toNumOrNull(r['taker_sell_volume_usd']) : null,
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

export function aggregateHistorical(bySymbol: Record<string, MinuteRow[]>): HistoricalBundle {
  const TIMEFRAMES = ['1h', '1d'];
  const barsBySymbolAndTimeframe: Record<string, Record<string, Bar[]>> = {};
  const fundingBySymbol: Record<string, FundingEntry[]> = {};
  const openInterestBySymbol: Record<string, OIEntry[]> = {};
  const liquidationsBySymbol: Record<string, LiqEntry[]> = {};
  const rowsBySymbol: Record<string, CanonicalRowV2[]> = {};

  for (const [sym, rows] of Object.entries(bySymbol)) {
    rows.sort((a, b) => a.ts - b.ts);
    barsBySymbolAndTimeframe[sym] = {};
    rowsBySymbol[sym] = rows.map(minuteRowToCanonicalRow);

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
      if (r.oi !== null) oiMap.set(r.ts, { tsMs: r.ts, symbol: sym, openInterestUsd: r.oi });
    }
    openInterestBySymbol[sym] = [...oiMap.values()].sort((a, b) => a.tsMs - b.tsMs);

    // Liquidations — дедуп по tsMs, затем разворот в контрактные per-side ряды (нулевые стороны опускаем)
    const liqByTs = new Map<number, { long: number; short: number }>();
    for (const r of rows) {
      if (r.liqLong !== null || r.liqShort !== null) {
        liqByTs.set(r.ts, { long: r.liqLong ?? 0, short: r.liqShort ?? 0 });
      }
    }
    const liqEntries: LiqEntry[] = [];
    for (const [ts, sides] of [...liqByTs.entries()].sort((a, b) => a[0] - b[0])) {
      if (sides.long > 0) liqEntries.push({ tsMs: ts, symbol: sym, side: 'long', sizeUsd: sides.long });
      if (sides.short > 0) liqEntries.push({ tsMs: ts, symbol: sym, side: 'short', sizeUsd: sides.short });
    }
    liquidationsBySymbol[sym] = liqEntries;
  }

  return { barsBySymbolAndTimeframe, fundingBySymbol, openInterestBySymbol, liquidationsBySymbol, rowsBySymbol };
}

function emptyHistorical(): HistoricalBundle {
  return {
    barsBySymbolAndTimeframe: {},
    fundingBySymbol: {},
    openInterestBySymbol: {},
    liquidationsBySymbol: {},
    rowsBySymbol: {},
  };
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
    tradeEvidenceByTrade: ops.tradeEvidenceByTrade,
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
  merged['tradeEvidenceByTrade'] = mergeDict((existing['tradeEvidenceByTrade'] as Record<string, unknown>) ?? {}, (newBundle['tradeEvidenceByTrade'] as Record<string, unknown>) ?? {});
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
      rowsBySymbol: { ...(oldHist.rowsBySymbol ?? {}) },
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
    const tsKey = (e: { tsMs: number; side?: string }): string => String(e.tsMs);
    const liqKey = (e: { tsMs: number; side?: string }): string => `${e.tsMs}:${e.side ?? ''}`;
    const keyForField: Record<string, (e: { tsMs: number; side?: string }) => string> = {
      fundingBySymbol: tsKey, openInterestBySymbol: tsKey, liquidationsBySymbol: liqKey,
    };
    for (const field of ['fundingBySymbol', 'openInterestBySymbol', 'liquidationsBySymbol'] as const) {
      const key = keyForField[field]!;
      for (const [sym, entries] of Object.entries(newHist[field])) {
        const old = (mh[field][sym] as { tsMs: number; side?: string }[]) ?? [];
        const byKey = new Map(old.map((e) => [key(e), e]));
        for (const e of entries as { tsMs: number; side?: string }[]) byKey.set(key(e), e);
        (mh[field] as Record<string, unknown[]>)[sym] = [...byKey.values()].sort(
          (a, b) => (a.tsMs - b.tsMs) || String(a.side ?? '').localeCompare(String(b.side ?? '')),
        );
      }
    }
    if (newHist.rowsBySymbol) {
      for (const [sym, rows] of Object.entries(newHist.rowsBySymbol)) {
        const old = mh.rowsBySymbol?.[sym] ?? [];
        const byTs = new Map(old.map((r) => [r.minute_ts, r]));
        for (const r of rows) byTs.set(r.minute_ts, r);
        mh.rowsBySymbol![sym] = [...byTs.values()].sort((a, b) => a.minute_ts - b.minute_ts);
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
  const checksumRef = 'checksums.json';

  const bundleBytes = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
  const bundleRef = bundleRefForByteLength(bundleBytes.length);
  const fileBytes = encodeBundleFileBytes(bundleBytes, bundleRef);
  const checksum = sha256Hex(fileBytes);

  const hist = bundle['historical'] as HistoricalBundle | undefined;
  const runCount = (bundle['runs'] as BotRun[]).length;
  const tradeCount = Object.values((bundle['tradesByRun'] as Record<string, ClosedTrade[]>)).reduce((s, v) => s + v.length, 0);
  const symCount = hist ? Object.keys(hist.barsBySymbolAndTimeframe).length : 0;
  const barCount = hist ? Object.values(hist.barsBySymbolAndTimeframe).reduce((s, tfMap) => s + Object.values(tfMap).reduce((ss, bars) => ss + bars.length, 0), 0) : 0;
  const rowCount = hist?.rowsBySymbol
    ? Object.values(hist.rowsBySymbol).reduce((s, rows) => s + rows.length, 0)
    : 0;

  console.log(`\n[snapshot] ref=${ref}`);
  console.log(`  runs:         ${runCount}`);
  console.log(`  trades:       ${tradeCount}`);
  console.log(`  hist symbols: ${symCount}, bars: ${barCount}, native 1m rows: ${rowCount}`);
  console.log(`  bundle size:  ${bundleBytes.length.toLocaleString()} bytes (json)`);
  if (bundleRef.endsWith('.gz')) {
    console.log(`  stored as:    ${bundleRef} (${fileBytes.length.toLocaleString()} bytes gzip)`);
  }
  console.log(`  checksum:     ${checksum.slice(0, 16)}…`);

  if (dryRun) {
    console.log('\n[dry-run] Files not written (--dry-run).');
    return;
  }

  mkdirSync(opsDir, { recursive: true });

  const exporterTs = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
  const manifest = {
    // ref is the logical snapshot identity (basename), independent of the storage
    // sub-path passed via --ref (e.g. "fixtures/2026-06-18-real-all" → "2026-06-18-real-all").
    ref: ref.split('/').pop() ?? ref,
    createdAtMs: NOW_MS,
    bundleRef,
    checksumsRef: checksumRef,
    versions: {
      snapshotSchemaVersion: 'snapshot.1',
      opsReadContractVersion: 'ops.6',
      researchReadContractVersion: 'research.1',
      analysisContractVersion: 'ops.4',
      exporterVersion: 'fetch-snapshot.1',
      sourcePlatformCommit: `vps-fetch-${exporterTs}`,
      redactionPolicyVersion: 'redact.1',
    },
  };

  writeFileSync(join(opsDir, bundleRef.replace('ops/', '')), fileBytes);
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
  const cfg = parseArgs(loadEnv());
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('[fatal]', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
