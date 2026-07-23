import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseEnv,
  loadEnv,
  EnvValidationError,
  DEFAULT_SNAPSHOT_DIR,
  DEFAULT_SNAPSHOT_REF,
} from '../../src/env.js';

describe('parseEnv — defaults (behaviour pinned to the pre-env.ts code paths)', () => {
  it('yields every documented default on an empty environment', () => {
    const env = parseEnv({});
    expect(env.MOCK_OPS_BIND).toBe('127.0.0.1');
    expect(env.MOCK_OPS_PORT).toBe(8839);
    expect(env.MOCK_OPS_TOKENS).toEqual([]);
    expect(env.MOCK_REPLAY_MODE).toBe('loop');
    expect(env.MOCK_REPLAY_SPEED).toBe(1);
    expect(env.MOCK_RESEARCH_TOKENS).toEqual([]);
    expect(env.MOCK_SNAPSHOT_DIR).toBe(DEFAULT_SNAPSHOT_DIR);
    expect(env.MOCK_SNAPSHOT_REF).toBe(DEFAULT_SNAPSHOT_REF);
    expect(DEFAULT_SNAPSHOT_DIR).toBe('./data/snapshots');
    expect(DEFAULT_SNAPSHOT_REF).toBe('fixtures/2026-06-22-to-2026-06-28-vps');
  });
  it('optional variables without a default come back undefined', () => {
    const env = parseEnv({});
    expect(env.MOCK_RESEARCH_TOKEN).toBeUndefined();
    expect(env.MOCK_SNAPSHOT_DB_URL).toBeUndefined();
    expect(env.PLATFORM_GOLDEN).toBeUndefined();
    expect(env.PLATFORM_REPO).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });
});

describe('parseEnv — typed parsing', () => {
  it('parses int / float / enum / csv values', () => {
    const env = parseEnv({
      MOCK_OPS_PORT: '9000',
      MOCK_REPLAY_SPEED: '2.5',
      MOCK_REPLAY_MODE: 'once',
      MOCK_OPS_TOKENS: ' a , b ,',
      MOCK_RESEARCH_TOKENS: 'x,y',
    });
    expect(env.MOCK_OPS_PORT).toBe(9000);
    expect(env.MOCK_REPLAY_SPEED).toBe(2.5);
    expect(env.MOCK_REPLAY_MODE).toBe('once');
    expect(env.MOCK_OPS_TOKENS).toEqual(['a', 'b']); // trimmed, empties dropped
    expect(env.MOCK_RESEARCH_TOKENS).toEqual(['x', 'y']);
  });
  it('accepts a well-formed postgres URL for MOCK_SNAPSHOT_DB_URL', () => {
    const url = 'postgres://user:pass@localhost:5432/db';
    expect(parseEnv({ MOCK_SNAPSHOT_DB_URL: url }).MOCK_SNAPSHOT_DB_URL).toBe(url);
  });
});

describe('parseEnv — fail-fast negatives', () => {
  it('rejects a non-integer port', () => {
    expect(() => parseEnv({ MOCK_OPS_PORT: 'abc' })).toThrow(/MOCK_OPS_PORT/);
  });
  it('rejects a non-positive port', () => {
    expect(() => parseEnv({ MOCK_OPS_PORT: '0' })).toThrow(/MOCK_OPS_PORT/);
  });
  it('rejects an unknown replay mode', () => {
    expect(() => parseEnv({ MOCK_REPLAY_MODE: 'bounce' })).toThrow(/MOCK_REPLAY_MODE/);
  });
  it('rejects a non-positive replay speed', () => {
    expect(() => parseEnv({ MOCK_REPLAY_SPEED: '0' })).toThrow(/MOCK_REPLAY_SPEED/i);
    expect(() => parseEnv({ MOCK_REPLAY_SPEED: 'fast' })).toThrow(/MOCK_REPLAY_SPEED/i);
  });
  it('rejects a malformed MOCK_SNAPSHOT_DB_URL', () => {
    expect(() => parseEnv({ MOCK_SNAPSHOT_DB_URL: 'not a url' })).toThrow(/MOCK_SNAPSHOT_DB_URL/);
  });
  it('reports ALL invalid variables at once (safeParse, not first-error)', () => {
    let err: EnvValidationError | undefined;
    try {
      parseEnv({ MOCK_OPS_PORT: 'x', MOCK_REPLAY_MODE: 'y', MOCK_REPLAY_SPEED: '-1' });
    } catch (e) {
      err = e as EnvValidationError;
    }
    expect(err).toBeInstanceOf(EnvValidationError);
    expect(err!.issues).toHaveLength(3);
    expect(err!.message).toMatch(/MOCK_OPS_PORT/);
    expect(err!.message).toMatch(/MOCK_REPLAY_MODE/);
    expect(err!.message).toMatch(/MOCK_REPLAY_SPEED/);
  });
  it('never leaks a secret value into the error message', () => {
    const secretish = 'sup3rs3cret это вообще не URL';
    let err: Error | undefined;
    try {
      parseEnv({ MOCK_SNAPSHOT_DB_URL: secretish });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('MOCK_SNAPSHOT_DB_URL');
    expect(err!.message).not.toContain('sup3rs3cret');
  });
});

describe('loadEnv — process-level fail-fast', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('prints every issue to stderr and exits 1 on an invalid environment', () => {
    vi.stubEnv('MOCK_OPS_PORT', 'nope');
    vi.stubEnv('MOCK_REPLAY_MODE', 'bounce');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => loadEnv()).toThrow('__exit_1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = errSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/MOCK_OPS_PORT/);
    expect(out).toMatch(/MOCK_REPLAY_MODE/);
  });
  it('returns the parsed env on a valid environment', () => {
    vi.stubEnv('MOCK_OPS_PORT', '9001');
    expect(loadEnv().MOCK_OPS_PORT).toBe(9001);
  });
});
