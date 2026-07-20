import { readFileSync } from 'node:fs';

// Clarification #1: allowlist is checked against DIRECT dependencies only; denylist scans the whole lockfile.
// A3 (feature 004): the shared contract SDK is admitted as a normal registry dependency — @trdlabs/sdk,
// pinned exactly (shape enforced by scripts/verify_sdk_pin.ts). It used to be @trading-platform/sdk
// consumed as a non-registry artifact (a vendored ./vendor/*.tgz, later a GitHub release-asset URL)
// because no npm release existed; that is over, so the carve-outs those forms needed are gone.
const RUNTIME_ALLOWLIST = new Set(['hono', '@hono/node-server', '@hono/node-ws', 'ajv', '@modelcontextprotocol/sdk', '@trdlabs/sdk']);
// bare denylist tokens — the private platform runtime, db, and exchange SDKs.
// NOTE: '@trading-platform' is intentionally NOT a bare token — the '@' prefix means the bare-token
// regex below would not match it anyway. The whole scope is policed separately, and now with no
// exception at all: @trading-platform/sdk moved to @trdlabs/sdk, so nothing under the legacy scope
// may appear. A reappearance means a rollback slipped in.
const DENYLIST = [
  'trading-platform',
  'pg', 'ccxt',
  'binance-api-node', 'node-binance-api', 'bybit-api', 'okx-api',
];
// Non-registry specifier forms, banned outright with NO exception. https remote tarballs count as
// non-registry too. The SDK release-asset URL used to be carved out here; every dependency now comes
// from the registry, so the carve-out is gone and any reintroduction fails.
const NON_REGISTRY = /^(?:file:|link:|git\+|git:|github:|workspace:|https?:)/;

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

// (c) non-registry specifiers — across direct deps + devDeps; no exceptions
for (const [name, spec] of [...Object.entries(deps), ...Object.entries(devDeps)]) {
  if (typeof spec !== 'string' || !NON_REGISTRY.test(spec)) continue;
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
// @trading-platform scope: deny EVERY @trading-platform/*, with no exception. The SDK that used to
// be carved out here now ships as @trdlabs/sdk from the registry.
const TP_SCOPE_RE = /(?:^|[\s/'"(])@trading-platform\/([a-z0-9-]+)/gm;
for (const m of lock.matchAll(TP_SCOPE_RE)) {
  violations.push(`forbidden package '@trading-platform/${m[1]}' present in pnpm-lock.yaml`);
}

if (violations.length) {
  console.error(`Forbidden-dependency violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  process.exit(1);
}
console.log('forbidden-deps OK');
