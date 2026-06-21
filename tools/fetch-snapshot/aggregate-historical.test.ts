import { describe, it, expect } from 'vitest';
import { aggregateHistorical, type MinuteRow } from './fetch-snapshot.ts';

function makeRow(overrides: Partial<MinuteRow> & { ts: number; sym: string }): MinuteRow {
  return {
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 100,
    oi: null,
    funding: null,
    liqLong: null,
    liqShort: null,
    ...overrides,
  };
}

describe('aggregateHistorical', () => {
  describe('openInterestBySymbol', () => {
    it('uses openInterestUsd field (not oiUsd)', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', oi: 500_000 }),
        makeRow({ ts: 2_000_000, sym: 'BTCUSDT', oi: 600_000 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.openInterestBySymbol['BTCUSDT']!;
      expect(entries).toHaveLength(2);
      expect(entries[0]).toHaveProperty('openInterestUsd', 500_000);
      expect(entries[1]).toHaveProperty('openInterestUsd', 600_000);
      // ensure old field name is absent
      expect(entries[0]).not.toHaveProperty('oiUsd');
    });

    it('sorts entries by tsMs ascending', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 3_000_000, sym: 'ETHUSDT', oi: 300 }),
        makeRow({ ts: 1_000_000, sym: 'ETHUSDT', oi: 100 }),
        makeRow({ ts: 2_000_000, sym: 'ETHUSDT', oi: 200 }),
      ];
      const result = aggregateHistorical({ ETHUSDT: rows });
      const tsMsList = result.openInterestBySymbol['ETHUSDT']!.map((e) => e.tsMs);
      expect(tsMsList).toEqual([1_000_000, 2_000_000, 3_000_000]);
    });
  });

  describe('liquidationsBySymbol', () => {
    it('emits one long row when only longUsd > 0', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', liqLong: 1000, liqShort: 0 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.liquidationsBySymbol['BTCUSDT']!;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ tsMs: 1_000_000, symbol: 'BTCUSDT', side: 'long', sizeUsd: 1000 });
    });

    it('emits one short row when only shortUsd > 0', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', liqLong: 0, liqShort: 2000 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.liquidationsBySymbol['BTCUSDT']!;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ tsMs: 1_000_000, symbol: 'BTCUSDT', side: 'short', sizeUsd: 2000 });
    });

    it('emits two rows (long first) when both sides > 0', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', liqLong: 1500, liqShort: 2500 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.liquidationsBySymbol['BTCUSDT']!;
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ side: 'long', sizeUsd: 1500 });
      expect(entries[1]).toMatchObject({ side: 'short', sizeUsd: 2500 });
    });

    it('emits no rows when both sides are 0 or null', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', liqLong: 0, liqShort: 0 }),
        makeRow({ ts: 2_000_000, sym: 'BTCUSDT', liqLong: null, liqShort: null }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.liquidationsBySymbol['BTCUSDT'] ?? [];
      expect(entries).toHaveLength(0);
    });

    it('omits the zero side when only one side is null and the other is 0', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', liqLong: null, liqShort: 0 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      // liqLong is null → liqLong ?? 0 = 0 → no long row; liqShort = 0 → no short row
      const entries = result.liquidationsBySymbol['BTCUSDT'] ?? [];
      expect(entries).toHaveLength(0);
    });

    it('sorts multiple minutes by tsMs ascending, long before short within same minute', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 3_000_000, sym: 'ETHUSDT', liqLong: 300, liqShort: 350 }),
        makeRow({ ts: 1_000_000, sym: 'ETHUSDT', liqLong: 100, liqShort: 150 }),
        makeRow({ ts: 2_000_000, sym: 'ETHUSDT', liqLong: 200, liqShort: 0 }),
      ];
      const result = aggregateHistorical({ ETHUSDT: rows });
      const entries = result.liquidationsBySymbol['ETHUSDT']!;
      // ts=1: long+short, ts=2: long only, ts=3: long+short → 5 rows total
      expect(entries).toHaveLength(5);
      expect(entries[0]).toMatchObject({ tsMs: 1_000_000, side: 'long' });
      expect(entries[1]).toMatchObject({ tsMs: 1_000_000, side: 'short' });
      expect(entries[2]).toMatchObject({ tsMs: 2_000_000, side: 'long' });
      expect(entries[3]).toMatchObject({ tsMs: 3_000_000, side: 'long' });
      expect(entries[4]).toMatchObject({ tsMs: 3_000_000, side: 'short' });
    });

    it('uses per-side contract shape (no longUsd/shortUsd fields)', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', liqLong: 500, liqShort: 600 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.liquidationsBySymbol['BTCUSDT']!;
      for (const e of entries) {
        expect(e).not.toHaveProperty('longUsd');
        expect(e).not.toHaveProperty('shortUsd');
        expect(e).toHaveProperty('side');
        expect(e).toHaveProperty('sizeUsd');
      }
    });
  });

  describe('fundingBySymbol', () => {
    it('keeps { tsMs, symbol, rate } shape unchanged', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', funding: 0.0001 }),
        makeRow({ ts: 2_000_000, sym: 'BTCUSDT', funding: -0.0002 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.fundingBySymbol['BTCUSDT']!;
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ tsMs: 1_000_000, symbol: 'BTCUSDT', rate: 0.0001 });
      expect(entries[1]).toMatchObject({ tsMs: 2_000_000, symbol: 'BTCUSDT', rate: -0.0002 });
    });

    it('skips null funding entries', () => {
      const rows: MinuteRow[] = [
        makeRow({ ts: 1_000_000, sym: 'BTCUSDT', funding: null }),
        makeRow({ ts: 2_000_000, sym: 'BTCUSDT', funding: 0.0003 }),
      ];
      const result = aggregateHistorical({ BTCUSDT: rows });
      const entries = result.fundingBySymbol['BTCUSDT']!;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.tsMs).toBe(2_000_000);
    });
  });
});
