import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { openSnapshot } from '../../src/snapshot/registry.js';
import { createApp } from '../../src/http/app.js';
import { readRows } from '../../src/snapshot/readers/rows.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';
import type { CanonicalRowV2 } from '../../src/contract/historical-read/dto.js';
// Vendored copy of the shared harness (import-free ESM), sourced from the SDK repo.
// The sync gate (scripts/verify_harness_sync.mjs) proves this byte-matches that source.
import { runHistoricalConformance, type ConformanceSkip } from './_vendored/historical.conformance.mjs';

let snap: LoadedSnapshot;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let goldenRows: readonly CanonicalRowV2[];

beforeAll(async () => {
  snap = openSnapshot('data/snapshots/fixtures', 'historical-golden');
  goldenRows = readRows(snap.bundle, { symbol: 'BTCUSDT' });
  const { app } = createApp({ snapshot: snap, tokenAllowlist: [], replay: { mode: 'once', speed: 1 } });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('mock == real: shared historical conformance harness over the golden snapshot', () => {
  it('passes the shared harness (discover historical.2, rows resource, 19 fields, pagination union, open-toMs, unknown-symbol graceful, half-open range, multi-symbol ordering, limit/clamp) + byte-identity, with no skipped checks', async () => {
    expect(goldenRows.length).toBe(30);
    // The golden fixture carries a second symbol so the harness can actually run its
    // multi-symbol ordering check instead of reporting it as unexercisable.
    expect(readRows(snap.bundle, { symbol: 'ETHUSDT' })).toHaveLength(30);

    // A skipped check is a check the dataset could not exercise — it is NOT a pass.
    // Any skip means this fixture stopped covering part of the contract, so it fails
    // the gate rather than silently shrinking coverage.
    const skips: ConformanceSkip[] = [];
    const result = await runHistoricalConformance({ baseUrl }, {
      goldenRows,
      onSkip: (skip) => skips.push(skip),
    });

    expect(skips).toEqual([]);
    expect(result).toEqual({ ok: true });
  });
});
