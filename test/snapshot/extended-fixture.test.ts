import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSnapshot } from '../../src/snapshot/loader.js';
import type { CanonicalRowV2 } from '../../src/contract/historical-read/dto.js';

// Synthetic 3-day extension of 2026-06-18-real-all: the real day (2026-06-18) replicated
// back two whole days (2026-06-17, 2026-06-16) by shifting minute_ts by -1d / -2d, so the
// row series spans ~3 days. Downstream (trading-lab commitXTermMath) resamples these 1m
// rows to 1h and needs >= 28 hourly bars; one day (~24h) is not enough.
const DAY_MS = 86_400_000;
const SOURCE = join(process.cwd(), 'data/snapshots/fixtures/2026-06-18-real-all');
const FIXTURE = join(process.cwd(), 'data/snapshots/fixtures/2026-06-16-to-18-extended');

// Anchors from the source real day (2026-06-18T00:00:00Z .. 2026-06-18T23:59:00Z).
const SOURCE_FIRST_TS = 1781740800000; // 2026-06-18T00:00:00Z
const SOURCE_LAST_TS = 1781827140000; // 2026-06-18T23:59:00Z
const EXTENDED_FIRST_TS = SOURCE_FIRST_TS - 2 * DAY_MS; // 2026-06-16T00:00:00Z = 1781568000000

function hourBuckets(rows: readonly CanonicalRowV2[]): number {
  return new Set(rows.map((r) => Math.floor(r.minute_ts / 3_600_000))).size;
}

describe('synthetic extended fixture (2026-06-16-to-18-extended)', () => {
  const snap = loadSnapshot(FIXTURE); // throws on schema / checksum / secret-scan / compat failure
  const source = loadSnapshot(SOURCE);

  it('loads with the expected manifest ref and an honest synthetic exporterVersion', () => {
    expect(snap.manifest.ref).toBe('2026-06-16-to-18-extended');
    expect(snap.manifest.versions.exporterVersion).toMatch(/synthetic-extend/);
  });

  it('extends every rowsBySymbol symbol present in the source, and no others', () => {
    const src = source.bundle.historical!.rowsBySymbol!;
    const ext = snap.bundle.historical!.rowsBySymbol!;
    expect(Object.keys(ext).sort()).toEqual(Object.keys(src).sort());
  });

  it('each symbol is exactly 3x the source rows (verbatim replication, no dropped/added rows)', () => {
    const src = source.bundle.historical!.rowsBySymbol!;
    const ext = snap.bundle.historical!.rowsBySymbol!;
    for (const [sym, rows] of Object.entries(src)) {
      expect(ext[sym]!.length).toBe(rows.length * 3);
    }
  });

  it('all five historical maps are extended to 3x (funding/oi/liq/bars too)', () => {
    const s = source.bundle.historical!;
    const e = snap.bundle.historical!;
    for (const [sym, arr] of Object.entries(s.fundingBySymbol)) {
      expect(e.fundingBySymbol[sym]!.length).toBe(arr.length * 3);
    }
    for (const [sym, arr] of Object.entries(s.openInterestBySymbol)) {
      expect(e.openInterestBySymbol[sym]!.length).toBe(arr.length * 3);
    }
    for (const [sym, arr] of Object.entries(s.liquidationsBySymbol)) {
      expect(e.liquidationsBySymbol[sym]!.length).toBe(arr.length * 3);
    }
    for (const [sym, byTf] of Object.entries(s.barsBySymbolAndTimeframe)) {
      for (const [tf, bars] of Object.entries(byTf)) {
        expect(e.barsBySymbolAndTimeframe[sym]![tf]!.length).toBe(bars.length * 3);
      }
    }
  });

  it('every row series is strictly increasing, 60000-aligned, all 19 fields present', () => {
    const ext = snap.bundle.historical!.rowsBySymbol!;
    const FIELDS = [
      'schema_version', 'minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume', 'turnover',
      'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd',
      'has_oi', 'has_funding', 'has_liquidations',
      'taker_buy_volume_usd', 'taker_sell_volume_usd', 'has_taker_flow',
    ];
    for (const [sym, rows] of Object.entries(ext)) {
      expect(rows.length).toBeGreaterThan(0);
      let prev = -Infinity;
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual([...FIELDS].sort());
        expect(r.schema_version).toBe(2);
        expect(r.symbol).toBe(sym);
        expect(r.minute_ts % 60_000).toBe(0);
        expect(r.minute_ts).toBeGreaterThan(prev); // strictly increasing, no dups
        prev = r.minute_ts;
      }
    }
  });

  it('ESPORTSUSDT spans 2026-06-16T00:00Z .. 2026-06-18T23:59Z and yields >= 28 hourly buckets', () => {
    const rows = snap.bundle.historical!.rowsBySymbol!.ESPORTSUSDT!;
    expect(rows.length).toBeGreaterThanOrEqual(28 * 60);
    expect(rows[0]!.minute_ts).toBe(EXTENDED_FIRST_TS);
    expect(rows[rows.length - 1]!.minute_ts).toBe(SOURCE_LAST_TS); // tail stays on the real day
    expect(hourBuckets(rows)).toBeGreaterThanOrEqual(28);
  });

  it('every symbol yields >= 28 distinct hourly buckets (1m->1h resample is viable)', () => {
    const ext = snap.bundle.historical!.rowsBySymbol!;
    for (const rows of Object.values(ext)) {
      expect(hourBuckets(rows)).toBeGreaterThanOrEqual(28);
    }
  });

  it('the replicated rows are verbatim copies of the source day shifted by whole days', () => {
    const src = source.bundle.historical!.rowsBySymbol!.ESPORTSUSDT!;
    const ext = snap.bundle.historical!.rowsBySymbol!.ESPORTSUSDT!;
    const n = src.length;
    // last n rows == source day untouched
    for (let i = 0; i < n; i++) {
      expect(ext[ext.length - n + i]).toEqual(src[i]);
    }
    // first n rows == source day shifted back 2 whole days (only minute_ts changes)
    for (let i = 0; i < n; i++) {
      expect(ext[i]).toEqual({ ...src[i], minute_ts: src[i]!.minute_ts - 2 * DAY_MS });
    }
  });

  it('leaves the source fixture (2026-06-18-real-all) untouched', () => {
    expect(source.manifest.ref).toBe('2026-06-18-real-all');
    const rows = source.bundle.historical!.rowsBySymbol!.ESPORTSUSDT!;
    expect(rows[0]!.minute_ts).toBe(SOURCE_FIRST_TS);
    expect(rows[rows.length - 1]!.minute_ts).toBe(SOURCE_LAST_TS);
  });
});
