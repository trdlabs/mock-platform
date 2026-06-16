import { readFileSync } from 'node:fs';

// Clarification #1: allowlist is checked against DIRECT dependencies only; denylist scans the whole lockfile.
const RUNTIME_ALLOWLIST = new Set(['hono', '@hono/node-server', '@hono/node-ws', 'ajv', '@modelcontextprotocol/sdk']);
const DENYLIST = [
  'trading-platform', '@trading-platform',
  'pg', 'ccxt',
  'binance-api-node', 'node-binance-api', 'bybit-api', 'okx-api',
];
const NON_REGISTRY = /^(?:file:|link:|git\+|git:|github:|workspace:)/;

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

// (c) non-registry specifiers — across direct deps + devDeps
for (const [name, spec] of [...Object.entries(deps), ...Object.entries(devDeps)]) {
  if (typeof spec === 'string' && NON_REGISTRY.test(spec)) {
    violations.push(`dependency '${name}' uses a non-registry specifier '${spec}'`);
  }
}

// (b) denylist anywhere in the lockfile (covers direct + transitive)
let lock = '';
try { lock = readFileSync('pnpm-lock.yaml', 'utf8'); }
catch { violations.push('pnpm-lock.yaml not found'); }
for (const bad of DENYLIST) {
  const esc = bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a package name token in a pnpm lockfile is bounded by start/indent/quote/paren and followed by @ / : ' "
  const re = new RegExp(`(?:^|[\\s/'"(])${esc}(?:[@/:'"\\s])`, 'm');
  if (re.test(lock)) {
    violations.push(`forbidden package '${bad}' present in pnpm-lock.yaml`);
  }
}

if (violations.length) {
  console.error(`Forbidden-dependency violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  process.exit(1);
}
console.log('forbidden-deps OK');
