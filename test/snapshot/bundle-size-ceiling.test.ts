import { describe, it, expect } from 'vitest';
import { constants as bufferConstants } from 'node:buffer';
import {
  BUNDLE_MAX_DECODED_BYTES,
  assertBundleFitsInMemory,
} from '../../src/snapshot/bundle-io.js';

// Measured on the committed T2 fixture (5 symbols x 42 days, 2026-07-27): the decoded bundle is
// 171.1 MiB, of which 167.3 MiB is symbol data — 33.5 MiB per symbol per 42 days. loadSnapshot
// decodes the whole bundle into ONE JavaScript string before JSON.parse, so V8's max string length
// (512 MiB) caps a 42-day fixture at ~15 symbols. Gzip does not help: the ceiling is on the
// decoded form. Without this guard the ceiling is discovered as an opaque V8 failure, after the
// fixture has already been written to disk.
describe('bundle decoded-size ceiling', () => {
  it('defaults to V8 max string length — the actual thing loadSnapshot hits', () => {
    expect(BUNDLE_MAX_DECODED_BYTES).toBe(bufferConstants.MAX_STRING_LENGTH);
  });

  it('passes anything at or below the limit', () => {
    expect(() => assertBundleFitsInMemory(10, 'x', 10)).not.toThrow();
    expect(() => assertBundleFitsInMemory(9, 'x', 10)).not.toThrow();
  });

  it('rejects above the limit and names both numbers', () => {
    expect(() => assertBundleFitsInMemory(11, 'data/snapshots/wfo/wide', 10))
      .toThrow(/data\/snapshots\/wfo\/wide/);
    expect(() => assertBundleFitsInMemory(11, 'x', 10)).toThrow(/11/);
    expect(() => assertBundleFitsInMemory(11, 'x', 10)).toThrow(/10/);
  });

  it('tells the operator what to do instead — split, not gzip', () => {
    // The wrong reflex is "it is gzipped, so it fits". The message must close that door: runs
    // select one dataset at a time, so a wide symbol set belongs in several fixtures.
    expect(() => assertBundleFitsInMemory(11, 'x', 10)).toThrow(/several fixtures|split/i);
  });
});
