// verify_golden_sync — proves the vendored platform historical golden has not drifted.
//
//  HARD : sha256(local vendored copy) === recorded .sha256 (tamper detect).
//  SOFT : if the platform repo is reachable, byte-compare the vendored copy against the
//         live source (source-drift detect). Repo unreachable / artifact absent =>
//         warning + skip the cross-repo check (the local sha stays hard).
//
// The golden fixture's byte-identity source of truth is the platform repo
// (test/fixtures/historical-golden/MANIFEST.json). The SDK does not own it, so it cannot come
// from the npm package — it stays vendored, and this gate is what keeps it honest.
//
// This file used to be verify_harness_sync and also byte-compared a vendored copy of the
// conformance harness against a compile of the SDK repo. That half is gone: the harness now comes
// from the published `@trdlabs/sdk` npm package (mock-contract-parity item 5), so there is no
// vendored copy to drift and no sibling checkout to compile. The pin itself is gated by
// verify_sdk_pin.ts. Only the golden remains cross-repo, hence the rename — the old name outlived
// what the script does.
//
// Был .mjs на голом node; стал .ts под tsx, потому что PLATFORM_REPO теперь читается через
// типизированный src/env.ts (env-catalog item 5) — единственную точку чтения окружения в репо.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { loadEnv } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const GOLDEN = join(repoRoot, 'test/conformance/_vendored/platform-historical-golden.json');
const GOLDEN_SHA_FILE = join(repoRoot, 'test/conformance/_vendored/platform-historical-golden.sha256');

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

function fail(msg: string): never {
  console.error(`verify_golden_sync: FAIL — ${msg}`);
  process.exit(1);
}

// Sibling-relative, not an absolute machine path: a hardcoded
// /home/.../projects/trading-platform once pointed at an unrelated stub directory, so the
// cross-repo check below WARNed and skipped on every run instead of ever comparing anything.
const PLATFORM = loadEnv().PLATFORM_REPO ?? resolve(repoRoot, '../platform');

// --- HARD: vendored platform golden matches its recorded checksum ---
if (!existsSync(GOLDEN)) fail(`vendored golden missing: ${GOLDEN}`);
if (!existsSync(GOLDEN_SHA_FILE)) fail(`golden checksum file missing: ${GOLDEN_SHA_FILE}`);

const goldenBuf = readFileSync(GOLDEN);
const goldenSha = sha256(goldenBuf);
const recordedGoldenSha = readFileSync(GOLDEN_SHA_FILE, 'utf8').trim();
if (goldenSha !== recordedGoldenSha) {
  fail(`vendored golden sha256 mismatch (local tamper):\n  recorded ${recordedGoldenSha}\n  actual   ${goldenSha}`);
}

// --- SOFT: cross-repo byte-identity against the live platform MANIFEST ---
const PLATFORM_GOLDEN = join(PLATFORM, 'test/fixtures/historical-golden/MANIFEST.json');
if (!existsSync(PLATFORM) || !existsSync(PLATFORM_GOLDEN)) {
  console.warn(`verify_golden_sync: WARN — platform golden unreachable (${PLATFORM_GOLDEN}); cross-repo check skipped`);
} else {
  const platformGoldenBuf = readFileSync(PLATFORM_GOLDEN);
  if (sha256(platformGoldenBuf) !== goldenSha) {
    fail(`vendored golden drifted from platform source:\n  platform sha ${sha256(platformGoldenBuf)}\n  vendored sha ${goldenSha}\n  re-vendor: cp ${PLATFORM_GOLDEN} ${GOLDEN} && sha256 -> .sha256`);
  }
  console.log('verify_golden_sync: golden cross-repo byte-identity OK');
}

console.log('verify_golden_sync: OK');
