// scripts/wfo-rank.ts — reads a {SYMBOL: turnover} JSON map (from tools/fetch-snapshot/wfo-turnover.ts),
// ranks HUSDT + top-4, writes a ranking-provenance file proving WHY those 4 were chosen (turnover
// hash, candidate count, selected symbols with rank + turnover, probe window), and prints the 5
// symbols as CSV. Exits non-zero (blocker) if it cannot produce enough.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { rankWfoSymbols, canonicalTurnover } from './wfo-select.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

function main(): void {
  const turnover = JSON.parse(readFileSync(arg('turnover'), 'utf8')) as Record<string, number>;
  const primary = arg('primary').toUpperCase();
  const count = Number(arg('count'));
  const probeFrom = Number(arg('probe-from'));
  const probeTo = Number(arg('probe-to'));
  const outRanking = arg('out-ranking');

  const symbols = rankWfoSymbols(turnover, primary, count);
  if (symbols.length !== count + 1) { console.error(`BLOCKER: ranked ${symbols.length} symbols, need ${count + 1}`); process.exit(2); }

  writeFileSync(outRanking, JSON.stringify({
    probeWindow: { fromMs: probeFrom, toMs: probeTo },
    turnoverSha256: sha256Hex(canonicalTurnover(turnover)),
    candidateCount: Object.keys(turnover).length,
    primary,
    selected: symbols.map((s, i) => ({ symbol: s, rank: i, turnover: turnover[s] ?? 0 })),
  }, null, 2));
  console.log(symbols.join(','));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
