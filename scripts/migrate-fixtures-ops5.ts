/**
 * migrate-fixtures-ops5 — re-key the 4 committed standalone fixtures (listed in FIXTURES below)
 * from raw close_reason strings to the canonical CloseReason union (ops.5). For every ClosedTrade
 * and TradeEvidence: closeReasonRaw = the original raw, closeReason = classifyCloseReason(raw).
 * Idempotent (always derived from raw). Bumps manifest opsReadContractVersion → ops.5, re-checksums,
 * self-validates via loadSnapshot. Note: 2026-06-16-to-18-extended is re-derived separately via
 * scripts/make-extended-fixture.ts (which deep-clones the re-keyed 2026-06-18-real-all).
 *
 * Usage: pnpm --config.verify-deps-before-run=false exec tsx scripts/migrate-fixtures-ops5.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { classifyCloseReason } from '../src/contract/ops-read/close-reason.js';

const FIXTURES = [
  '2026-06-12-real-top5',
  '2026-06-16-synthetic',
  'historical-golden',
  '2026-06-18-real-all',
];

type Obj = Record<string, unknown>;

function rekey(obj: Obj): void {
  const raw = (obj['closeReasonRaw'] ?? obj['closeReason']) as string | null;
  obj['closeReasonRaw'] = raw ?? null;
  obj['closeReason'] = classifyCloseReason(raw ?? null);
}

function migrateOne(ref: string): void {
  const root = join(process.cwd(), 'data/snapshots/fixtures', ref);
  const bundlePath = join(root, 'ops', 'bundle.json');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
    tradesByRun?: Record<string, Obj[]>;
    tradeEvidenceByTrade?: Record<string, Obj>;
  };

  for (const trades of Object.values(bundle.tradesByRun ?? {})) for (const t of trades) rekey(t);
  for (const ev of Object.values(bundle.tradeEvidenceByTrade ?? {})) rekey(ev);

  const bundleStr = JSON.stringify(bundle);
  writeFileSync(bundlePath, bundleStr);
  writeFileSync(join(root, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));

  const mp = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(mp, 'utf8')) as { versions: Record<string, string> };
  manifest.versions['opsReadContractVersion'] = 'ops.5';
  writeFileSync(mp, JSON.stringify(manifest, null, 2));

  loadSnapshot(root); // schema + checksum + compat + secret-scan
  console.log(`re-keyed '${ref}' → ops.5`);
}

function main(): void { for (const ref of FIXTURES) migrateOne(ref); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
