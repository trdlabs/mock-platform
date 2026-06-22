import { readFileSync } from 'node:fs';

// Clarification #1: allowlist is checked against DIRECT dependencies only; denylist scans the whole lockfile.
// A3 (feature 004): @trading-platform/sdk is admitted as a standalone tarball ONLY — now sourced from a
// public GitHub release asset (https URL) rather than a vendored ./vendor/*.tgz file.
const RUNTIME_ALLOWLIST = new Set(['hono', '@hono/node-server', '@hono/node-ws', 'ajv', '@modelcontextprotocol/sdk', '@trading-platform/sdk']);
// bare denylist tokens — the private platform runtime, db, and exchange SDKs.
// NOTE: '@trading-platform' is intentionally NOT a bare token: the @trading-platform scope is policed
// separately below so the standalone @trading-platform/sdk can be admitted while everything else under
// the scope (e.g. a private @trading-platform/platform) stays denied.
const DENYLIST = [
  'trading-platform',
  'pg', 'ccxt',
  'binance-api-node', 'node-binance-api', 'bybit-api', 'okx-api',
];
// Non-registry specifier forms that are banned outright. https remote tarballs are also non-registry,
// so they are policed explicitly below (the SDK release-asset URL is the sole permitted https tarball).
const NON_REGISTRY = /^(?:file:|link:|git\+|git:|github:|workspace:|https?:)/;
// The single permitted non-registry specifier: the SDK GitHub release-asset tarball URL.
const VENDORED_SDK_NAME = '@trading-platform/sdk';
const VENDORED_SDK_SPEC = /^https:\/\/github\.com\/.+\/releases\/download\/sdk-v\d+\.\d+\.\d+\/trading-platform-sdk-\d+\.\d+\.\d+\.tgz$/;

const violations = [];

let pkg;
try { pkg = JSON.parse(readFileSync('package.json', 'utf8')); }
catch { console.error('forbidden-deps: cannot read package.json'); process.exit(1); }

const deps = pkg.dependencies ?? {};
const devDeps = pkg.devDependencies ?? {};

// (a) runtime allowlist — DIRECT dependencies only
for (const name of Object.keys(deps)) {
  if (!RUNTIME_ALLOWLIST.has(name)) {
    violations.push(`runtime dependency '${name}' is not in the allowlist {${[...RUNTIME_ALLOWLIST].join(', ')}}`);
  }
}

// (c) non-registry specifiers — across direct deps + devDeps; the vendored SDK tarball is the sole exception
for (const [name, spec] of [...Object.entries(deps), ...Object.entries(devDeps)]) {
  if (typeof spec !== 'string' || !NON_REGISTRY.test(spec)) continue;
  if (name === VENDORED_SDK_NAME && VENDORED_SDK_SPEC.test(spec)) continue; // allowed: vendored SDK tgz
  violations.push(`dependency '${name}' uses a non-registry specifier '${spec}'`);
}

// (b) denylist anywhere in the lockfile (covers direct + transitive)
let lock = '';
try { lock = readFileSync('pnpm-lock.yaml', 'utf8'); }
catch { violations.push('pnpm-lock.yaml not found'); }
for (const bad of DENYLIST) {
  const esc = bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a package name token in a pnpm lockfile is bounded by start/indent/quote/paren and followed by @ / : ' "
  const re = new RegExp(`(?:^|[\\s/'"(])${esc}(?:[@/:'\"\\s])`, 'm');
  if (re.test(lock)) {
    violations.push(`forbidden package '${bad}' present in pnpm-lock.yaml`);
  }
}
// @trading-platform scope: deny every @trading-platform/* EXCEPT the standalone @trading-platform/sdk.
const TP_SCOPE_RE = /(?:^|[\s/'"(])@trading-platform\/([a-z0-9-]+)/gm;
for (const m of lock.matchAll(TP_SCOPE_RE)) {
  if (m[1] !== 'sdk') {
    violations.push(`forbidden package '@trading-platform/${m[1]}' present in pnpm-lock.yaml`);
  }
}

if (violations.length) {
  console.error(`Forbidden-dependency violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  process.exit(1);
}
console.log('forbidden-deps OK');
