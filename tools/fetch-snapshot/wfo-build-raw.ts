// Build a 5-symbol raw snapshot LOCALLY from cached parquet (no VPS): 5-symbol historical merged
// with the ops from the primary-only probe bundle. Pure merge core + a thin read/write shell.
// SnapshotManifest is mock-platform's own fixture-format contract — a type-only import is correct.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../../src/snapshot/checksums.js';
import { bundleRefForByteLength, encodeBundleFileBytes, decodeBundleFileBytes } from '../../src/snapshot/bundle-io.js';
import type { SnapshotManifest } from '../../src/contract/snapshot/manifest.js';

/** Replace only the historical block; preserve ops. Pure; testable without parquet. */
export function assembleRawBundle<H>(base: Record<string, unknown>, historical: H): Record<string, unknown> {
  return { ...base, historical };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

async function main(): Promise<void> {
  const { readParquetDir } = await import('./fetch-snapshot.js'); // dynamic: keeps pg/hyparquet out of unit tests
  const probe = arg('probe');
  const out = arg('out');
  const parquetLocal = arg('parquet-local');
  const symbols = arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const tsFrom = Number(arg('from'));
  const tsTo = Number(arg('to'));

  const probeManifest = JSON.parse(readFileSync(join(probe, 'manifest.json'), 'utf8')) as { versions: SnapshotManifest['versions']; bundleRef: string };
  const base = JSON.parse(decodeBundleFileBytes(readFileSync(join(probe, probeManifest.bundleRef)), probeManifest.bundleRef).toString('utf8')) as Record<string, unknown>;

  const historical = await readParquetDir(parquetLocal, symbols, tsFrom, tsTo);
  const bytes = Buffer.from(JSON.stringify(assembleRawBundle(base, historical)), 'utf8');
  const bundleRef = bundleRefForByteLength(bytes.length);
  const encoded = encodeBundleFileBytes(bytes, bundleRef);

  const ref = out.split('/').filter(Boolean).slice(-1)[0]!;
  const manifest: SnapshotManifest = { ref, createdAtMs: Date.now(), versions: { ...probeManifest.versions }, bundleRef, checksumsRef: 'checksums.json' };
  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, bundleRef), encoded);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ [bundleRef]: sha256Hex(encoded) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`raw 5-symbol snapshot written to ${out} (${symbols.join(', ')})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
