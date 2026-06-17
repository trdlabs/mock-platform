import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// The ops-read contract version the mock's fixtures + compat gate pin. The SDK is the source of truth;
// this constant is the value we REQUIRE the vendored SDK to carry (drift = hard fail).
const EXPECTED_OPS_VERSION = 'ops.3';
const SPEC_RE = /^file:(\.\/vendor\/trading-platform-sdk-\d+\.\d+\.\d+\.tgz)$/;

interface PkgJson { dependencies?: Record<string, string> }

/** No SDK import; returns specifier problems ([] = clean). Touches the filesystem only to check
 *  tarball existence — safe to unit-test for specifier-shape errors. */
export function checkSpecifier(pkg: PkgJson): string[] {
  const errs: string[] = [];
  const spec = pkg.dependencies?.['@trading-platform/sdk'];
  if (!spec) { errs.push('@trading-platform/sdk missing from dependencies'); return errs; }
  const m = SPEC_RE.exec(spec);
  if (!m) { errs.push(`@trading-platform/sdk specifier '${spec}' is not a vendored ./vendor/*.tgz file`); return errs; }
  const tarball = m[1] as string; // capture group 1 is always defined when SPEC_RE matches
  if (!existsSync(tarball)) errs.push(`vendored tarball ${tarball} does not exist`);
  return errs;
}

async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PkgJson;

  // 1. Validate the specifier + tarball FIRST. The SDK is imported only after this passes, so an
  //    unresolved/missing SDK surfaces here as a clear message — not a cryptic module-resolution throw.
  const errs = checkSpecifier(pkg);
  if (errs.length) {
    console.error(`vendored-sdk check failed:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }

  // 2. Now read the embedded contract version via a dynamic import.
  let version: string;
  try {
    ({ OPS_READ_CONTRACT_VERSION: version } = await import('@trading-platform/sdk/ops-read'));
  } catch (e) {
    console.error(`vendored-sdk check failed:\n  - cannot import '@trading-platform/sdk/ops-read' (is it installed from the vendored tgz?): ${(e as Error).message}`);
    process.exit(1);
  }
  if (version !== EXPECTED_OPS_VERSION) {
    console.error(`vendored-sdk check failed:\n  - vendored SDK OPS_READ_CONTRACT_VERSION '${version}' != expected '${EXPECTED_OPS_VERSION}'`);
    process.exit(1);
  }
  console.log(`vendored-sdk OK (@trading-platform/sdk ops-read ${version})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
