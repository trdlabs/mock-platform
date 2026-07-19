#!/usr/bin/env node
// verify_harness_sync — proves the vendored cross-repo artifacts have not drifted:
//   (a) the historical conformance harness, and
//   (b) the platform historical golden (byte-identity source of truth).
//
//  HARD : sha256(local vendored copy) === recorded .sha256 (tamper detect).
//  SOFT : if the source repo is reachable, byte-compare the vendored copy against the
//         live source (source-drift detect). Repo unreachable / artifact absent =>
//         warning + skip the cross-repo check (the local sha stays hard).
//
// Canonical harness source: the SDK repo (trdlabs/sdk, conformance/historical.conformance.ts),
// per control-center initiative mock-contract-parity item 5 — NOT the platform copy it was
// originally vendored from. The golden fixture's byte-identity source of truth remains the
// platform repo (test/fixtures/historical-golden/MANIFEST.json), which the SDK does not own.
//
// Delivery note: the harness is consumed as a vendored, import-free artifact rather than
// through the `@trdlabs/sdk` npm package, because the npm release carrying this harness
// revision does not exist yet (latest published: 0.10.0, predates SDK commit c7e3064).
// Migrating the pin to npm is a follow-up blocked on that release.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const VENDORED = join(repoRoot, 'test/conformance/_vendored/historical.conformance.mjs');
const SHA_FILE = join(repoRoot, 'test/conformance/_vendored/historical.conformance.sha256');
const GOLDEN = join(repoRoot, 'test/conformance/_vendored/platform-historical-golden.json');
const GOLDEN_SHA_FILE = join(repoRoot, 'test/conformance/_vendored/platform-historical-golden.sha256');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function fail(msg) {
  console.error(`verify_harness_sync: FAIL — ${msg}`);
  process.exit(1);
}

// Harness source (SDK repo) and golden source (platform repo) are now distinct.
const SDK = process.env.SDK_REPO ?? resolve(repoRoot, '../sdk');
const PLATFORM = process.env.PLATFORM_REPO ?? '/home/alexxxnikolskiy/projects/trading-platform';

// === harness ===
// --- HARD: local vendored copy matches its recorded checksum ---
if (!existsSync(VENDORED)) fail(`vendored harness missing: ${VENDORED}`);
if (!existsSync(SHA_FILE)) fail(`checksum file missing: ${SHA_FILE}`);

const vendoredBuf = readFileSync(VENDORED);
const localSha = sha256(vendoredBuf);
const recordedSha = readFileSync(SHA_FILE, 'utf8').trim();
if (localSha !== recordedSha) {
  fail(`vendored harness sha256 mismatch (local tamper):\n  recorded ${recordedSha}\n  actual   ${localSha}`);
}

// --- SOFT: cross-repo byte-identity against the SDK source artifact ---
const TSCONFIG = join(SDK, 'tsconfig.conformance.json');
// Built into a scratch outDir with sourcemaps off: the vendored copy has no sibling
// .map file, so a sourceMappingURL comment in it would make every consumer (vitest,
// node) warn about an unreadable map. Byte-identity is asserted against THIS shape.
const BUILD_DIR = join(repoRoot, 'node_modules/.cache/harness-sync');
const ARTIFACT = join(BUILD_DIR, 'historical.conformance.js');

if (!existsSync(SDK) || !existsSync(TSCONFIG)) {
  // The repo is genuinely absent (standalone clone / CI without the sibling checked out).
  // Nothing can be compared, and that is not a drift signal — skip, keeping the local sha hard.
  console.warn(`verify_harness_sync: WARN — sdk repo unreachable (${SDK}); harness cross-repo check skipped`);
} else {
  // Once the source repo IS present, every remaining outcome is a hard failure. A stale
  // artifact from an earlier run would otherwise let a broken or drifted SDK pass as
  // "byte-identity OK", so the build dir is removed first and the comparison only ever
  // runs against output produced by a compile that just succeeded.
  rmSync(BUILD_DIR, { recursive: true, force: true });
  try {
    execFileSync('npx', ['tsc', '-p', TSCONFIG, '--sourceMap', 'false', '--outDir', BUILD_DIR], { cwd: SDK, stdio: 'pipe' });
  } catch (e) {
    const detail = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join('\n').trim();
    fail(`sdk harness failed to compile (${TSCONFIG}); cannot verify byte-identity`
      + `${detail ? `\n${detail}` : ''}`);
  }
  if (!existsSync(ARTIFACT)) {
    fail(`sdk harness compiled but produced no artifact at ${ARTIFACT}`);
  }
  const sdkBuf = readFileSync(ARTIFACT);
  if (sha256(sdkBuf) !== localSha) {
    fail(`vendored harness drifted from sdk source:\n  sdk sha      ${sha256(sdkBuf)}\n  vendored sha ${localSha}\n  re-vendor: cp ${ARTIFACT} ${VENDORED} && sha256 -> .sha256`);
  }
  console.log('verify_harness_sync: harness cross-repo byte-identity OK (source: sdk)');
}

// === golden ===
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
  console.warn(`verify_harness_sync: WARN — platform golden unreachable (${PLATFORM_GOLDEN}); golden cross-repo check skipped`);
} else {
  const platformGoldenBuf = readFileSync(PLATFORM_GOLDEN);
  if (sha256(platformGoldenBuf) !== goldenSha) {
    fail(`vendored golden drifted from platform source:\n  platform sha ${sha256(platformGoldenBuf)}\n  vendored sha ${goldenSha}\n  re-vendor: cp ${PLATFORM_GOLDEN} ${GOLDEN} && sha256 -> .sha256`);
  }
  console.log('verify_harness_sync: golden cross-repo byte-identity OK');
}

console.log('verify_harness_sync: OK');
