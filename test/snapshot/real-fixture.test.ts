import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSnapshot } from '../../src/snapshot/loader.js';

const FIXTURE = join(process.cwd(), 'data/snapshots/fixtures/2026-06-12-real-top5');

describe('real-data demo fixture (2026-06-12-real-top5)', () => {
  const snap = loadSnapshot(FIXTURE); // throws on schema / checksum / secret-scan failure

  it('loads with the expected manifest ref', () => {
    expect(snap.manifest.ref).toBe('2026-06-12-real-top5');
  });

  it('carries exactly the 5 top-traded symbols in historical', () => {
    const h = snap.bundle.historical;
    expect(h).toBeDefined();
    expect(Object.keys(h!.barsBySymbolAndTimeframe).sort()).toEqual(
      ['BEATUSDT', 'COAIUSDT', 'ESPORTSUSDT', 'HUSDT', 'SIRENUSDT'],
    );
    expect(Object.keys(h!.fundingBySymbol).sort()).toEqual(
      ['BEATUSDT', 'COAIUSDT', 'ESPORTSUSDT', 'HUSDT', 'SIRENUSDT'],
    );
  });

  it('retains all 73 real trades for those symbols', () => {
    const trades = Object.values(snap.bundle.tradesByRun).reduce((s, a) => s + a.length, 0);
    expect(trades).toBe(73);
  });

  it('every historical symbol has at least one trade (coherent demo)', () => {
    const traded = new Set<string>();
    for (const arr of Object.values(snap.bundle.tradesByRun)) for (const t of arr) traded.add((t as { symbol: string }).symbol);
    for (const sym of Object.keys(snap.bundle.historical!.barsBySymbolAndTimeframe)) {
      expect(traded.has(sym)).toBe(true);
    }
  });
});
