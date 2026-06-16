import { describe, it, expect, beforeAll } from 'vitest';
import { openSnapshot } from '../../src/snapshot/registry.js';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';

let snap: LoadedSnapshot;
beforeAll(() => { snap = openSnapshot('data/snapshots', 'fixtures/2026-06-16-synthetic'); });
const app = () => createApp({ snapshot: snap, tokenAllowlist: [], replay: { mode: 'once', speed: 1 } }).app;

describe('golden conformance over the synthetic fixture', () => {
  it('office happy path: /ops/runs?mode=live items each carry strategy.name + numeric *Ms', async () => {
    const res = await app().request('/ops/runs?mode=live');
    const body = await res.json() as { items: Array<{ strategy: { name: string }; startedAtMs: number; lastSeenMs: number }> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const r of body.items) {
      expect(typeof r.strategy.name).toBe('string');
      expect(Number.isFinite(r.startedAtMs)).toBe(true);
      expect(Number.isFinite(r.lastSeenMs)).toBe(true);
    }
  });
  it('coverage preserves present vs unsupported', async () => {
    const res = await app().request('/ops/coverage');
    const body = await res.json() as { entries: Array<{ kind: string; state: string }> };
    expect(body.entries.find((e) => e.kind === 'funding')!.state).toBe('unsupported');
  });
  it('analysis is capability-aware: features omitted as {available:false}', async () => {
    const res = await app().request('/ops/runs/run_paper_002/analysis');
    const body = await res.json() as { features: { available: boolean } };
    expect(body.features.available).toBe(false);
  });
  it('summary aggregates the win + loss correctly', async () => {
    const res = await app().request('/ops/runs/run_paper_002/summary');
    const body = await res.json() as { wins: number; losses: number; pnlUsd: string };
    expect(body.wins).toBe(1);
    expect(body.losses).toBe(1);
    expect(body.pnlUsd).toBe('24.25000000');
  });
});
