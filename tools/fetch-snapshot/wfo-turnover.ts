// Local, read-only turnover aggregate over cached parquet. Pure core + a thin parquet reader.
import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TurnoverRow { symbol: string; close: number; volume: number; minute_ts: number }

/** turnover = Σ close·volume per symbol within [fromMs, toMs). Pure; testable without parquet.
 *  Fail-closed: non-finite close/volume throws; a repeated (symbol, minute_ts) — e.g. the same
 *  minute present in both schema_version=1 and =2 partitions — throws rather than double-counting.
 *  Deterministic: the caller must feed rows in a stable (sorted) file order. */
export function aggregateTurnover(rows: Iterable<TurnoverRow>, fromMs: number, toMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.minute_ts < fromMs || r.minute_ts >= toMs) continue;
    const s = r.symbol.trim().toUpperCase();
    if (!Number.isFinite(r.close) || !Number.isFinite(r.volume)) {
      throw new Error(`non-finite close/volume for ${s} @ ${r.minute_ts}`);
    }
    const key = `${s}|${r.minute_ts}`;
    if (seen.has(key)) throw new Error(`duplicate (symbol, minute_ts) ${key} across parquet partitions — refusing to double-count`);
    seen.add(key);
    out[s] = (out[s] ?? 0) + r.close * r.volume;
  }
  return out;
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

  // Collect rows in a STABLE order (sorted schema_version → date → part-file), then aggregate in a
  // single pass so the duplicate check spans files and schema versions.
  const all: TurnoverRow[] = [];
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
        const file = await asyncBufferFromFile(join(partDir, f));
        const rows = (await parquetReadObjects({ file, columns: ['minute_ts', 'symbol', 'close', 'volume'], compressors })) as Record<string, unknown>[];
        for (const r of rows) all.push({ symbol: String(r['symbol']), close: Number(r['close']), volume: Number(r['volume']), minute_ts: Number(r['minute_ts']) });
      }
    }
  }
  process.stdout.write(JSON.stringify(aggregateTurnover(all, fromMs, toMs)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
