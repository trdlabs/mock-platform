/**
 * migrate-fixtures-ops6 — add BotRunRecord.bundleId (ops.6, platform 074) to the committed
 * fixtures: the first paper run in each bundle gets a stable non-null bundleId (so trading-lab
 * can integration-verify the exact candidateId↔run join its paper.monitor uses), every other
 * run gets null (in-repo bots). Idempotent. Bumps manifest opsReadContractVersion → ops.6,
 * re-checksums, self-validates via loadSnapshot.
 *
 * Usage: pnpm --config.verify-deps-before-run=false exec tsx scripts/migrate-fixtures-ops6.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { decodeBundleFileBytes, encodeBundleFileBytes } from '../src/snapshot/bundle-io.js';
import { loadSnapshot } from '../src/snapshot/loader.js';

const FIXTURES = [
  '2026-06-12-real-top5',
  '2026-06-16-synthetic',
  'historical-golden',
  '2026-06-18-real-all',
  '2026-06-16-to-18-extended',
  '2026-06-22-to-2026-06-28-vps',
];

const FIXTURE_BUNDLE_ID = 'pc_fixture-bundle-0001';

type Obj = Record<string, unknown>;

function migrateOne(ref: string): void {
  const root = join(process.cwd(), 'data/snapshots/fixtures', ref);
  const mp = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(mp, 'utf8')) as {
    bundleRef: string;
    versions: Record<string, string>;
  };
  const bundlePath = join(root, manifest.bundleRef);
  const fileBuf = readFileSync(bundlePath);
  const bundle = JSON.parse(
    decodeBundleFileBytes(fileBuf, manifest.bundleRef).toString('utf8'),
  ) as { runs?: Obj[] };

  let tagged = false;
  for (const run of bundle.runs ?? []) {
    if (!tagged && run['mode'] === 'paper') {
      run['bundleId'] = FIXTURE_BUNDLE_ID;
      tagged = true;
    } else if (run['bundleId'] === undefined) {
      run['bundleId'] = null;
    }
  }

  const jsonBuf = Buffer.from(JSON.stringify(bundle), 'utf8');
  const outBuf = encodeBundleFileBytes(jsonBuf, manifest.bundleRef);
  writeFileSync(bundlePath, outBuf);
  writeFileSync(
    join(root, 'checksums.json'),
    JSON.stringify({ [manifest.bundleRef]: sha256Hex(outBuf) }, null, 2),
  );

  manifest.versions['opsReadContractVersion'] = 'ops.6';
  writeFileSync(mp, JSON.stringify(manifest, null, 2));

  loadSnapshot(root); // schema + checksum + compat + secret-scan
  console.log(`tagged '${ref}' → ops.6 (paper bundleId=${tagged ? FIXTURE_BUNDLE_ID : 'none — no paper runs'})`);
}

function main(): void { for (const ref of FIXTURES) migrateOne(ref); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
