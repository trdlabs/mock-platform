// verify_sdk_pin — proves the SDK is consumed as an EXACT pin of the published npm package,
// and that the package behind that pin carries the contract surface the mock depends on.
//
// History: the mock used to consume `@trading-platform/sdk` as a non-registry artifact — first a
// vendored ./vendor/*.tgz, then a GitHub release-asset URL — because no npm release existed.
// `@trdlabs/sdk` is published now (control-center initiative mock-contract-parity, item 5), so the
// only permitted shape is a registry specifier. This gate is what stops a silent slide back:
// a range, a tarball URL, or a file:/git+ specifier all fail here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const SDK_PKG = '@trdlabs/sdk';
/** The exact version the mock is pinned to. Bumping the dependency without bumping this
 *  constant (or vice versa) is a hard failure — the two must move together. */
const EXPECTED_SDK_VERSION = '0.13.0';
/** The ops-read contract version the mock's fixtures + compat gate pin. The SDK is the source of
 *  truth; this constant is the value we REQUIRE the published SDK to carry (drift = hard fail). */
const EXPECTED_OPS_VERSION = 'ops.6';
/** Exact semver only — no ^, ~, ranges, tags, URLs, or file:/git+/link:/workspace: specifiers. */
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+$/;

interface PkgJson { dependencies?: Record<string, string> }

/** No SDK import; returns specifier problems ([] = clean). Pure shape check on the dep spec —
 *  safe to unit-test for specifier-shape errors. */
export function checkSpecifier(pkg: PkgJson): string[] {
  const errs: string[] = [];
  const spec = pkg.dependencies?.[SDK_PKG];
  if (!spec) { errs.push(`${SDK_PKG} missing from dependencies`); return errs; }
  if (!EXACT_SEMVER_RE.test(spec)) {
    errs.push(`${SDK_PKG} specifier '${spec}' is not an exact npm version (expected e.g. '${EXPECTED_SDK_VERSION}' — no ranges, tags, or non-registry specifiers)`);
    return errs;
  }
  if (spec !== EXPECTED_SDK_VERSION) {
    errs.push(`${SDK_PKG} pinned to '${spec}' but this gate expects '${EXPECTED_SDK_VERSION}'; bump EXPECTED_SDK_VERSION in scripts/verify_sdk_pin.ts together with the dependency`);
  }
  return errs;
}

async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PkgJson;

  // 1. Validate the specifier FIRST. The SDK is imported only after this passes, so an
  //    unresolved/missing SDK surfaces here as a clear message — not a cryptic module-resolution throw.
  const errs = checkSpecifier(pkg);
  if (errs.length) {
    console.error(`sdk-pin check failed:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }

  // 2. The installed package must carry the version it claims. Guards against a lockfile or
  //    node_modules that resolved to something other than the pinned version.
  let sdkVersion: string;
  try {
    ({ SDK_VERSION: sdkVersion } = await import(SDK_PKG));
  } catch (e) {
    console.error(`sdk-pin check failed:\n  - cannot import '${SDK_PKG}' (is it installed?): ${(e as Error).message}`);
    process.exit(1);
  }
  if (sdkVersion !== EXPECTED_SDK_VERSION) {
    console.error(`sdk-pin check failed:\n  - installed ${SDK_PKG} SDK_VERSION '${sdkVersion}' != pinned '${EXPECTED_SDK_VERSION}'`);
    process.exit(1);
  }

  // 3. The ops-read contract behind the pin must be the one the fixtures and compat gate expect.
  let opsVersion: string;
  try {
    ({ OPS_READ_CONTRACT_VERSION: opsVersion } = await import(`${SDK_PKG}/ops-read`));
  } catch (e) {
    console.error(`sdk-pin check failed:\n  - cannot import '${SDK_PKG}/ops-read': ${(e as Error).message}`);
    process.exit(1);
  }
  if (opsVersion !== EXPECTED_OPS_VERSION) {
    console.error(`sdk-pin check failed:\n  - ${SDK_PKG} OPS_READ_CONTRACT_VERSION '${opsVersion}' != expected '${EXPECTED_OPS_VERSION}'`);
    process.exit(1);
  }

  // 4. The conformance harness must be reachable from the package. This is the subpath the mock's
  //    conformance test imports; if the published package ever stops exporting it, the test would
  //    fail with a module-resolution error far from the cause. Fail here instead, explicitly.
  try {
    const conformance = await import(`${SDK_PKG}/conformance`);
    if (typeof conformance.runHistoricalConformance !== 'function') {
      console.error(`sdk-pin check failed:\n  - '${SDK_PKG}/conformance' does not export runHistoricalConformance`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`sdk-pin check failed:\n  - cannot import '${SDK_PKG}/conformance': ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(`sdk-pin OK (${SDK_PKG}@${sdkVersion}, ops-read ${opsVersion}, conformance harness present)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
