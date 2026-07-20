import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/verify_no_forbidden_deps.mjs');

function runOK(cwd: string): void {
  execFileSync('node', [SCRIPT], { cwd, encoding: 'utf8', stdio: 'pipe' });
}
function expectFail(cwd: string, re: RegExp): void {
  let err: { stderr?: string; stdout?: string } | undefined;
  try { execFileSync('node', [SCRIPT], { cwd, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { err = e as { stderr?: string; stdout?: string }; }
  expect(err, 'expected the script to exit non-zero').toBeDefined();
  expect(`${err?.stderr ?? ''}${err?.stdout ?? ''}`).toMatch(re);
}
function fixture(pkg: object, lock = ''): string {
  const d = mkdtempSync(join(tmpdir(), 'deps-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(d, 'pnpm-lock.yaml'), lock);
  return d;
}

describe('verify_no_forbidden_deps', () => {
  it('passes on the real repo', () => {
    expect(() => runOK(process.cwd())).not.toThrow();
  });
  it('fails on a runtime dependency outside the allowlist', () => {
    expectFail(fixture({ dependencies: { lodash: '^4' } }), /allowlist/i);
  });
  it('fails on a denylisted package anywhere in the lockfile', () => {
    expectFail(fixture({ dependencies: {} }, 'packages:\n  ccxt@4.5.51:\n    resolution: {}\n'), /ccxt/i);
  });
  it('fails on the private platform package in the lockfile', () => {
    expectFail(fixture({ dependencies: {} }, "packages:\n  '@trading-platform/platform@1.0.0':\n"), /@trading-platform\/platform/i);
  });
  it('fails on @trading-platform/sdk in the lockfile — the carve-out is gone', () => {
    // It used to be the one admitted @trading-platform/* member, because no npm release existed.
    // The SDK ships as @trdlabs/sdk now, so the legacy scope has no exception left: seeing it
    // again means a rollback slipped in.
    expectFail(fixture({ dependencies: {} }, "packages:\n  '@trading-platform/sdk@0.9.3':\n"), /@trading-platform\/sdk/i);
  });
  it('accepts @trdlabs/sdk as a direct dependency', () => {
    expect(() => runOK(fixture({ dependencies: { '@trdlabs/sdk': '0.11.0' } }))).not.toThrow();
  });
  it('fails on a non-registry specifier', () => {
    expectFail(fixture({ dependencies: {}, devDependencies: { x: 'file:./x' } }), /non-registry/i);
  });
  it('fails on an https tarball specifier — no SDK carve-out remains', () => {
    expectFail(
      fixture({ dependencies: { '@trdlabs/sdk': 'https://github.com/trdlabs/sdk/releases/download/sdk-v0.11.0/trdlabs-sdk-0.11.0.tgz' } }),
      /non-registry/i,
    );
  });
  it('allows transitive prod deps in the lockfile (allowlist is direct-deps only)', () => {
    // a transitive package that is NOT in the runtime allowlist must NOT trip the allowlist check
    expect(() => runOK(fixture(
      { dependencies: { hono: '^4' } },
      'packages:\n  some-transitive-dep@1.0.0:\n    resolution: {}\n',
    ))).not.toThrow();
  });
});
