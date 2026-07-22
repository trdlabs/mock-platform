import { describe, it, expect } from 'vitest';
import { aggregateTurnover, createTurnoverAccumulator, DAY_MS } from './wfo-turnover.js';
import { assembleRawBundle, dedupeRowsBySymbol } from './wfo-build-raw.js';

describe('aggregateTurnover', () => {
  it('sums close*volume per symbol within [from, to), upper-casing symbols', () => {
    const rows = [
      { symbol: 'a', close: 2, volume: 3, minute_ts: 60_000 },   // 6  (a→A)
      { symbol: 'A', close: 1, volume: 1, minute_ts: 120_000 },  // +1
      { symbol: 'B', close: 5, volume: 2, minute_ts: 0 },        // below from → excluded
      { symbol: 'B', close: 4, volume: 1, minute_ts: 180_000 },  // == to → excluded (half-open)
    ];
    expect(aggregateTurnover(rows, 60_000, 180_000)).toEqual({ A: 7 });
  });
  it('throws on a non-finite value', () => {
    expect(() => aggregateTurnover([{ symbol: 'A', close: NaN, volume: 1, minute_ts: 60_000 }], 0, 120_000)).toThrow(/non-finite/);
  });
  it('throws on a CONFLICTING duplicate (symbol, minute_ts) instead of double-counting', () => {
    const dup = [
      { symbol: 'A', close: 1, volume: 1, minute_ts: 60_000 },
      { symbol: 'a', close: 2, volume: 2, minute_ts: 60_000 }, // same symbol+minute (upper-cased)
    ];
    expect(() => aggregateTurnover(dup, 0, 120_000)).toThrow(/conflicting duplicate/);
  });
  it('collapses an EXACT re-write of the same bar instead of throwing or double-counting', () => {
    // The real corpus holds 1,431 of these (ingest re-writing a minute under a second part-file)
    // and zero conflicting ones — so this path must be lossless, not fatal.
    const dup = [
      { symbol: 'A', close: 2, volume: 3, minute_ts: 60_000 },
      { symbol: 'a', close: 2, volume: 3, minute_ts: 60_000 }, // byte-identical re-write
    ];
    expect(aggregateTurnover(dup, 0, 120_000)).toEqual({ A: 6 }); // counted once, not 12
  });
});

describe('createTurnoverAccumulator (streaming path used against real parquet)', () => {
  const DAY0 = Date.parse('2026-06-12T00:00:00Z');
  const rowsIn = (dayStart: number) => [
    { symbol: 'A', close: 2, volume: 3, minute_ts: dayStart + 60_000 },
    { symbol: 'B', close: 1, volume: 4, minute_ts: dayStart + 120_000 },
  ];

  it('per-day streaming yields exactly what the batch wrapper yields', () => {
    const from = DAY0, to = DAY0 + 2 * DAY_MS;
    const day0 = rowsIn(DAY0), day1 = rowsIn(DAY0 + DAY_MS);

    const acc = createTurnoverAccumulator(from, to);
    acc.beginDay(DAY0); for (const r of day0) acc.add(r);
    acc.beginDay(DAY0 + DAY_MS); for (const r of day1) acc.add(r);

    expect(acc.result()).toEqual(aggregateTurnover([...day0, ...day1], from, to));
    expect(acc.result()).toEqual({ A: 12, B: 8 });
  });

  it('still catches a duplicate spanning schema_version=1 and =2 of the SAME day', () => {
    // The real corpus overlaps on exactly one migration-boundary date; both partitions of that day
    // are fed into one scope, so the guard must fire across them.
    const acc = createTurnoverAccumulator(DAY0, DAY0 + DAY_MS);
    acc.beginDay(DAY0);
    acc.add({ symbol: 'A', close: 1, volume: 1, minute_ts: DAY0 + 60_000 }); // schema_version=1 part
    expect(() => acc.add({ symbol: 'A', close: 9, volume: 9, minute_ts: DAY0 + 60_000 })) // =2 part
      .toThrow(/conflicting duplicate/);
  });

  it('collapses an identical cross-schema_version re-write of the same day', () => {
    const acc = createTurnoverAccumulator(DAY0, DAY0 + DAY_MS);
    acc.beginDay(DAY0);
    acc.add({ symbol: 'A', close: 2, volume: 3, minute_ts: DAY0 + 60_000 }); // sv=1 part
    acc.add({ symbol: 'A', close: 2, volume: 3, minute_ts: DAY0 + 60_000 }); // sv=2 part, same bar
    expect(acc.result()).toEqual({ A: 6 });
  });

  it('rejects a row that escapes its date= partition, since per-day dedup could not catch it', () => {
    const acc = createTurnoverAccumulator(DAY0, DAY0 + 2 * DAY_MS);
    acc.beginDay(DAY0);
    expect(() => acc.add({ symbol: 'A', close: 1, volume: 1, minute_ts: DAY0 + DAY_MS }))
      .toThrow(/outside its date= partition/);
  });

  it('does not let a same-minute duplicate slip through by sitting in a different day scope', () => {
    // Guards the soundness argument itself: if partition alignment were NOT enforced, this pair
    // would double-count. The partition assertion is what makes that unreachable.
    const acc = createTurnoverAccumulator(DAY0, DAY0 + 2 * DAY_MS);
    acc.beginDay(DAY0);
    acc.add({ symbol: 'A', close: 1, volume: 1, minute_ts: DAY0 + 60_000 });
    acc.beginDay(DAY0 + DAY_MS);
    expect(() => acc.add({ symbol: 'A', close: 1, volume: 1, minute_ts: DAY0 + 60_000 }))
      .toThrow(/outside its date= partition/);
  });
});

describe('assembleRawBundle', () => {
  it('replaces historical and preserves everything else', () => {
    const base = { runs: [1], tradesByRun: { r: [] }, historical: { old: true } };
    expect(assembleRawBundle(base, { fresh: true })).toEqual({ runs: [1], tradesByRun: { r: [] }, historical: { fresh: true } });
  });
});

describe('dedupeRowsBySymbol', () => {
  const bar = (minute_ts: number, extra: Record<string, unknown> = {}) => ({
    minute_ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, turnover: 15,
    oi_total_usd: 100, funding_rate: 0.0001, taker_buy_volume_usd: 5, taker_sell_volume_usd: 5,
    has_oi: true, has_funding: true, has_taker_flow: true, schema_version: 2, ...extra,
  });

  it('collapses an exact repeat and reports the count', () => {
    const { rows, collapsed, resolved } = dedupeRowsBySymbol({ A: [bar(60_000), bar(60_000), bar(120_000)] });
    expect([collapsed, resolved]).toEqual([1, 0]);
    expect(rows.A!.map((r) => r.minute_ts)).toEqual([60_000, 120_000]);
  });

  it('resolves a DERIVED-metric conflict last-writer-wins and counts it', () => {
    // The measured real-world shape: same bar, later snapshot of open interest / funding / flows.
    const { rows, collapsed, resolved } = dedupeRowsBySymbol({
      A: [bar(60_000, { oi_total_usd: 100 }), bar(60_000, { oi_total_usd: 999, funding_rate: 0.9 })],
    });
    expect([collapsed, resolved]).toEqual([0, 1]);
    expect(rows.A![0]).toMatchObject({ oi_total_usd: 999, funding_rate: 0.9 });
  });

  it('still throws when a PRICE field disagrees', () => {
    expect(() => dedupeRowsBySymbol({ A: [bar(60_000), bar(60_000, { close: 99 })] }))
      .toThrow(/price field\(s\) close disagree/);
  });

  it('throws on a field belonging to neither list, rather than defaulting to "derived"', () => {
    expect(() => dedupeRowsBySymbol({ A: [bar(60_000), bar(60_000, { some_new_column: 7 })] }))
      .toThrow(/unclassified field\(s\) some_new_column disagree/);
  });

  it('sorts rows by minute_ts, so a filesystem-ordered read still yields identical bytes', () => {
    const { rows } = dedupeRowsBySymbol({ A: [bar(180_000), bar(60_000), bar(120_000)] });
    expect(rows.A!.map((r) => r.minute_ts)).toEqual([60_000, 120_000, 180_000]);
  });

  it('dedups per symbol, so the same minute under two symbols is kept', () => {
    expect(dedupeRowsBySymbol({ A: [bar(60_000)], B: [bar(60_000)] }).collapsed).toBe(0);
  });
});
