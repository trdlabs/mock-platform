import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotManifest } from '../contract/snapshot/manifest.js';
import type { SnapshotBundle } from '../contract/snapshot/bundle.js';
import { verifyChecksum } from './checksums.js';
import { assertSnapshotCompatible } from './compat.js';
import { assertValidManifest, assertValidBundle } from './validate.js';
import { scanForSecrets } from '../safety/secret-scan.js';

export interface LoadedSnapshot {
  readonly dir: string;
  readonly manifest: SnapshotManifest;
  readonly bundle: SnapshotBundle;
}

export function loadSnapshot(dir: string): LoadedSnapshot {
  // 1. manifest: scan text → parse → schema-validate (exact keys) → exact-version compat gate
  const manifestStr = readFileSync(join(dir, 'manifest.json'), 'utf8');
  scanForSecrets('manifest.json', manifestStr);
  const manifestRaw = JSON.parse(manifestStr) as unknown;
  assertValidManifest(manifestRaw);
  const manifest = manifestRaw as SnapshotManifest;
  assertSnapshotCompatible(manifest.versions);

  // 2. bundle: checksum → scan text → parse → schema-validate (exact keys, additionalProperties:false)
  const checksums = JSON.parse(readFileSync(join(dir, manifest.checksumsRef), 'utf8')) as Record<string, string>;
  const bundleBuf = readFileSync(join(dir, manifest.bundleRef));
  const expected = checksums[manifest.bundleRef];
  if (!expected) throw new Error(`checksums.json missing entry for ${manifest.bundleRef}`);
  verifyChecksum(manifest.bundleRef, bundleBuf, expected);

  const bundleStr = bundleBuf.toString('utf8');
  scanForSecrets(manifest.bundleRef, bundleStr);
  const bundleRaw = JSON.parse(bundleStr) as unknown;
  assertValidBundle(bundleRaw);
  const bundle = bundleRaw as SnapshotBundle;

  return { dir, manifest, bundle };
}
