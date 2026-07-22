import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_URL_ENV, resolveDbUrl, fetchSnapshotDoc } from './fetch-snapshot.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** A password distinctive enough that finding it anywhere is unambiguous. */
const PASS = 'sup3rs3cr3t-vps-pw';
const URL_WITH_PASS = `postgres://mockro:${PASS}@127.0.0.1:1/trading`;

function secretFile(mode: number): string {
  const p = join(mkdtempSync(join(tmpdir(), 'dburl-')), 'db-url');
  writeFileSync(p, `${URL_WITH_PASS}\n`);
  chmodSync(p, mode);
  return p;
}

describe('resolveDbUrl — the secret never travels as an argument', () => {
  const noFiles = { read: () => { throw new Error('should not read'); }, mode: () => 0o600 };

  it('refuses --db-url outright, and does not echo the value it refused', () => {
    // The point of the flag being fatal rather than deprecated: pnpm prints the script's whole
    // command line before running it, so a tolerated --db-url leaks on every single invocation.
    let msg = '';
    try {
      resolveDbUrl(['--db-url', URL_WITH_PASS, '--ref', 'x'], {}, noFiles);
      throw new Error('expected resolveDbUrl to throw');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('--db-url');
    expect(msg).toContain(DB_URL_ENV);
    expect(msg).not.toContain(PASS);
  });

  it('reads the URL from the environment', () => {
    expect(resolveDbUrl([], { [DB_URL_ENV]: URL_WITH_PASS }, noFiles)).toBe(URL_WITH_PASS);
  });

  it('trims trailing whitespace, so a here-doc or `echo >` file still works', () => {
    expect(resolveDbUrl([], { [DB_URL_ENV]: `${URL_WITH_PASS}\n` }, noFiles)).toBe(URL_WITH_PASS);
  });

  it('reads a private file given by path — the PATH is the argument, not the secret', () => {
    const p = secretFile(0o600);
    expect(resolveDbUrl(['--db-url-file', p], {}, realFiles())).toBe(URL_WITH_PASS);
  });

  it('refuses a secret file that others can read, naming the path but not the contents', () => {
    const p = secretFile(0o644);
    let msg = '';
    try {
      resolveDbUrl(['--db-url-file', p], {}, realFiles());
      throw new Error('expected resolveDbUrl to throw');
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(p);
    expect(msg).toContain('0600');
    expect(msg).not.toContain(PASS);
  });

  it('fails with actionable guidance when neither source is given', () => {
    let msg = '';
    try {
      resolveDbUrl([], {}, noFiles);
      throw new Error('expected resolveDbUrl to throw');
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(DB_URL_ENV);
    expect(msg).toContain('--db-url-file');
  });

  it('rejects an empty env value instead of handing "" to pg', () => {
    expect(() => resolveDbUrl([], { [DB_URL_ENV]: '   ' }, noFiles)).toThrow();
  });

  it('the help text shows no password, so copy-paste cannot teach the leak', () => {
    expect(fetchSnapshotDoc).not.toMatch(/postgres:\/\/[^\s"]*:[^\s"@]+@/);
    expect(fetchSnapshotDoc).toContain(DB_URL_ENV);
  });
});

function realFiles(): { read: (p: string) => string; mode: (p: string) => number } {
  return { read: (p) => readFileSync(p, 'utf8'), mode: (p) => statSync(p).mode };
}

describe('fetch-snapshot CLI — end to end, the secret reaches pg but nothing else', () => {
  it('never puts the password in argv or in any log line', () => {
    const args = [
      join(HERE, 'fetch-snapshot.ts'),
      '--no-tunnel', '--no-parquet',
      '--from', '2026-01-01', '--to', '2026-01-01',
      '--ref', 'secret-hygiene-probe',
      '--dry-run',
    ];

    const res = spawnSync(join(HERE, 'node_modules/.bin/tsx'), args, {
      encoding: 'utf8',
      env: { ...process.env, [DB_URL_ENV]: URL_WITH_PASS },
      timeout: 60_000,
    });

    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    // 1. Not in what we had to type. This is the regression: the documented invocation cannot
    //    contain the secret, so pnpm's "> tsx …" banner has nothing to echo.
    expect(args.join(' ')).not.toContain(PASS);

    // 2. Not in anything the run printed — stdout or stderr, including the failure path.
    expect(output).not.toContain(PASS);

    // 3. …and the URL genuinely arrived: the run reached the pg connect and masked it there.
    //    Without this the test would also pass if no URL had been delivered at all.
    expect(output).toContain('[pg] Connecting to');
    expect(output).toContain('mockro:***@');
  });
});
