import { describe, it, expect } from 'vitest';
import { aggregateHistorical, type MinuteRow } from '../../tools/fetch-snapshot/fetch-snapshot.js';

const minute = (over: Partial<MinuteRow>): MinuteRow => ({
  ts: 1_781_220_000_000,
  sym: 'ESPORTSUSDT',
  open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
  oi: null, funding: null, liqLong: null, liqShort: null,
  takerBuy: null, takerSell: null,
  ...over,
});

describe('aggregateHistorical → rowsBySymbol', () => {
  it('emits one canonical v2 row per minute with taker carried through', () => {
    const rows = [
      minute({ ts: 1_781_220_000_000, close: 1.5, volume: 100, takerBuy: 600, takerSell: 400 }),
      minute({ ts: 1_781_220_060_000, close: 2.0, volume: 50, oi: 9_000, funding: 0.0001 }),
    ];
    const out = aggregateHistorical({ ESPORTSUSDT: rows });
    const r = out.rowsBySymbol['ESPORTSUSDT'];
    expect(r).toHaveLength(2);

    expect(r![0]).toMatchObject({
      schema_version: 2,
      minute_ts: 1_781_220_000_000,
      symbol: 'ESPORTSUSDT',
      close: 1.5,
      turnover: 150, // volume * close
      taker_buy_volume_usd: 600,
      taker_sell_volume_usd: 400,
      has_taker_flow: true,
      has_oi: false,
      funding_rate: null,
      has_funding: false,
    });

    expect(r![1]).toMatchObject({
      taker_buy_volume_usd: null,
      taker_sell_volume_usd: null,
      has_taker_flow: false,
      oi_total_usd: 9_000,
      has_oi: true,
      funding_rate: 0.0001,
      has_funding: true,
    });
  });

  it('rows are sorted ascending and deduped by minute_ts (last-wins)', () => {
    const out = aggregateHistorical({
      ESPORTSUSDT: [
        minute({ ts: 1_781_220_060_000, close: 9 }),
        minute({ ts: 1_781_220_000_000, close: 1 }),
        minute({ ts: 1_781_220_060_000, close: 2 }), // dup ts → wins
      ],
    });
    const r = out.rowsBySymbol['ESPORTSUSDT']!;
    expect(r.map((x) => x.minute_ts)).toEqual([1_781_220_000_000, 1_781_220_060_000]);
    expect(r[1]!.close).toBe(2);
  });
});
