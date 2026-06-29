/**
 * migrate-fixtures-ops4 — привести committed-фикстуры к ops.4 shape БЕЗ потери данных:
 * каждому ClosedTrade добавить entryPrice/exitPrice (null ТОЛЬКО если поле отсутствует —
 * существующие значения сохраняются), гарантировать bundle.tradeEvidenceByTrade (если нет — {}),
 * проставить manifest.opsReadContractVersion='ops.4', пересчитать checksums.json, прогнать loadSnapshot.
 * Идемпотентно: повторный прогон на фикстуре с реальными ценами их НЕ затрёт.
 *
 * Usage: pnpm --config.verify-deps-before-run=false exec tsx scripts/migrate-fixtures-ops4.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';

// Только standalone-фикстуры. 2026-06-16-to-18-extended деривится из real-all отдельно
// (scripts/make-extended-fixture.ts) и здесь НЕ трогается.
const FIXTURES = [
  '2026-06-12-real-top5',
  '2026-06-16-synthetic',
  'historical-golden',
  '2026-06-18-real-all',
];

interface BundleLike {
  tradesByRun?: Record<string, Array<Record<string, unknown>>>;
  tradeEvidenceByTrade?: Record<string, unknown>;
  [k: string]: unknown;
}

function migrateOne(ref: string): void {
  const root = join(process.cwd(), 'data/snapshots/fixtures', ref);
  const bundlePath = join(root, 'ops', 'bundle.json');
  const manifestPath = join(root, 'manifest.json');

  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as BundleLike;

  for (const trades of Object.values(bundle.tradesByRun ?? {})) {
    for (const t of trades) {
      if (!('entryPrice' in t)) t['entryPrice'] = null;
      if (!('exitPrice' in t)) t['exitPrice'] = null;
    }
  }
  if (bundle.tradeEvidenceByTrade === undefined) bundle.tradeEvidenceByTrade = {};

  const bundleStr = JSON.stringify(bundle);
  writeFileSync(bundlePath, bundleStr);
  writeFileSync(join(root, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { versions: Record<string, string> };
  manifest.versions['opsReadContractVersion'] = 'ops.4';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  loadSnapshot(root); // self-validation: schema + checksum + compat + secret-scan
  console.log(`migrated '${ref}' → ops.4`);
}

function main(): void {
  for (const ref of FIXTURES) migrateOne(ref);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
