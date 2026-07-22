// Local, read-only turnover aggregate over cached parquet. Pure core + a thin parquet reader.
import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TurnoverRow { symbol: string; close: number; volume: number; minute_ts: number }

export const DAY_MS = 86_400_000;

export interface TurnoverAccumulator {
  /** Open a new dedup scope covering the UTC day starting at dayStartMs. Every row added while the
   *  scope is open MUST fall inside that day — this is what makes per-day dedup equivalent to a
   *  global one, so it is asserted rather than assumed. */
  beginDay(dayStartMs: number): void;
  add(row: TurnoverRow): void;
  result(): Record<string, number>;
}

/** Streaming core of the turnover aggregate. Memory is bounded by one day of keys rather than by
 *  the whole scan: the real corpus is ~22M rows across ~366 symbols, so neither the rows nor a
 *  global (symbol, minute_ts) key set fit in a default heap.
 *
 *  Fail-closed on three counts: non-finite close/volume throws; a row landing outside its own
 *  date= partition throws, since that would silently defeat the per-day dedup scope; and a repeated
 *  (symbol, minute_ts) carrying DIFFERENT close/volume throws rather than double-counting.
 *
 *  A repeat carrying identical close/volume is collapsed (keep-one) instead of throwing. That is
 *  measured, not assumed: across the full 50-day corpus (21,630,730 rows) there are 1,431 such
 *  repeats — the ingest pipeline re-writing one minute under a second part-file — and ZERO
 *  conflicting ones. Collapsing an exact re-write cannot change any sum; a conflicting pair still
 *  aborts the run, which is where genuine corruption would surface. */
export function createTurnoverAccumulator(fromMs: number, toMs: number): TurnoverAccumulator {
  const out: Record<string, number> = {};
  // key → the value signature already counted for it, so an exact re-write can be told apart from a
  // conflicting one. A bare Set could only do the latter.
  let seen = new Map<string, string>();
  let dayStart: number | null = null;

  return {
    beginDay(dayStartMs: number): void {
      dayStart = dayStartMs;
      seen = new Map<string, string>();
    },
    add(r: TurnoverRow): void {
      if (dayStart !== null && (r.minute_ts < dayStart || r.minute_ts >= dayStart + DAY_MS)) {
        throw new Error(
          `row minute_ts ${r.minute_ts} falls outside its date= partition starting ${dayStart} — ` +
            `per-day dedup would not catch a cross-partition duplicate`,
        );
      }
      if (r.minute_ts < fromMs || r.minute_ts >= toMs) return;
      const s = r.symbol.trim().toUpperCase();
      if (!Number.isFinite(r.close) || !Number.isFinite(r.volume)) {
        throw new Error(`non-finite close/volume for ${s} @ ${r.minute_ts}`);
      }
      const key = `${s}|${r.minute_ts}`;
      const sig = `${r.close}/${r.volume}`;
      const prev = seen.get(key);
      if (prev !== undefined) {
        if (prev !== sig) {
          throw new Error(
            `conflicting duplicate (symbol, minute_ts) ${key} across parquet partitions: ` +
              `${prev} vs ${sig} — refusing to pick a winner`,
          );
        }
        return; // exact re-write of the same bar — collapse, never double-count
      }
      seen.set(key, sig);
      out[s] = (out[s] ?? 0) + r.close * r.volume;
    },
    result(): Record<string, number> {
      return out;
    },
  };
}

/** turnover = Σ close·volume per symbol within [fromMs, toMs). Pure; testable without parquet.
 *  Batch wrapper over {@link createTurnoverAccumulator} with a single global dedup scope (no
 *  partition assertion), so the semantics the unit tests pin stay exactly as they were.
 *  Deterministic: the caller must feed rows in a stable (sorted) file order. */
export function aggregateTurnover(rows: Iterable<TurnoverRow>, fromMs: number, toMs: number): Record<string, number> {
  const acc = createTurnoverAccumulator(fromMs, toMs);
  for (const r of rows) acc.add(r);
  return acc.result();
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

async function main(): Promise<void> {
  const localRoot = arg('parquet-local');
  const fromMs = Number(arg('from'));
  const toMs = Number(arg('to'));

  // Dynamic imports keep hyparquet out of the module surface unit tests import.
  const { parquetReadObjects } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const { asyncBufferFromFile } = (await import('hyparquet/src/node.js')) as {
    asyncBufferFromFile: (p: string) => Promise<{ byteLength: number; slice(s: number, e?: number): ArrayBuffer | Promise<ArrayBuffer> }>;
  };

  // Group part-files by DATE first (not by schema_version), so both schema versions of the same day
  // — the only place a cross-partition duplicate can occur — land in one dedup scope. Within a date
  // the order stays stable: schema_version asc, then file name asc.
  const byDate = new Map<string, { sv: number; path: string }[]>();
  for (const sv of [1, 2] as const) {
    const svDir = join(localRoot, `schema_version=${sv}`);
    if (!existsSync(svDir)) continue;
    const dateDirs = readdirSync(svDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('date='))
      .map((e) => e.name)
      .sort();
    for (const date of dateDirs) {
      const partDir = join(svDir, date);
      for (const f of (await readdir(partDir)).sort()) {
        if (!f.startsWith('part-') || !f.endsWith('.parquet')) continue;
        const list = byDate.get(date) ?? [];
        list.push({ sv, path: join(partDir, f) });
        byDate.set(date, list);
      }
    }
  }

  // Stream: one part-file is resident at a time, and the accumulator keeps a single day of keys.
  const acc = createTurnoverAccumulator(fromMs, toMs);
  for (const date of [...byDate.keys()].sort()) {
    const dayStart = Date.parse(`${date.slice('date='.length)}T00:00:00Z`);
    if (!Number.isFinite(dayStart)) throw new Error(`unparseable partition directory ${date}`);
    if (dayStart + DAY_MS <= fromMs || dayStart >= toMs) continue; // wholly outside the window
    acc.beginDay(dayStart);
    const parts = (byDate.get(date) ?? []).sort((a, b) => a.sv - b.sv || a.path.localeCompare(b.path));
    for (const { path } of parts) {
      const file = await asyncBufferFromFile(path);
      const rows = (await parquetReadObjects({ file, columns: ['minute_ts', 'symbol', 'close', 'volume'], compressors })) as Record<string, unknown>[];
      for (const r of rows) {
        acc.add({ symbol: String(r['symbol']), close: Number(r['close']), volume: Number(r['volume']), minute_ts: Number(r['minute_ts']) });
      }
    }
  }
  process.stdout.write(JSON.stringify(acc.result()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
