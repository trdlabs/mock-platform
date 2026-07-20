import { describe, it, expect } from 'vitest';
import { handleRows } from '../../src/historical/handlers/rows.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';
import type { CanonicalRowV2, RowsPage } from '../../src/contract/historical-read/dto.js';

function row(symbol: string, minute_ts: number): CanonicalRowV2 {
  return {
    schema_version: 2,
    minute_ts,
    symbol,
    open: 1,
    high: 2,
    low: 0,
    close: 1.5,
    volume: 10,
    turnover: 15,
    oi_total_usd: null,
    funding_rate: null,
    liq_long_usd: null,
    liq_short_usd: null,
    has_oi: false,
    has_funding: false,
    has_liquidations: false,
    taker_buy_volume_usd: null,
    taker_sell_volume_usd: null,
    has_taker_flow: false,
  };
}

const T0 = 60_000;
const STEP = 60_000;
const N = 12;
const grid = Array.from({ length: N }, (_, i) => T0 + i * STEP);

// Three symbols on a fully overlapping timestamp grid: every minute_ts ties across all
// three, so the (symbol ASC) tie-break is exercised on every single comparison.
const bundle = {
  historical: {
    rowsBySymbol: {
      AAAUSDT: grid.map((t) => row('AAAUSDT', t)),
      BBBUSDT: grid.map((t) => row('BBBUSDT', t)),
      CCCUSDT: grid.map((t) => row('CCCUSDT', t)),
    },
  },
} as unknown as SnapshotBundle;

const ASOF = 1_000;

function isPage(r: RowsPage | { category: string }): r is RowsPage {
  return 'items' in r;
}

/** Drain every page, following nextCursor — the order under test is a property of the
 *  whole stream, not of the first page. */
function drain(params: Parameters<typeof handleRows>[1]): CanonicalRowV2[] {
  const out: CanonicalRowV2[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = handleRows(bundle, params, ASOF, cursor);
    if (!isPage(page)) throw new Error(`unexpected error page: ${JSON.stringify(page)}`);
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (++pages > 100) throw new Error('pagination did not terminate');
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  return out;
}

function assertGloballyOrdered(rows: readonly CanonicalRowV2[]): void {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    const ordered =
      cur.minute_ts > prev.minute_ts
      || (cur.minute_ts === prev.minute_ts && cur.symbol > prev.symbol);
    expect(
      ordered,
      `not ordered at index ${i}: (${prev.minute_ts}, ${prev.symbol}) then (${cur.minute_ts}, ${cur.symbol})`,
    ).toBe(true);
  }
}

// Platform serves a multi-symbol request as one globally ordered stream
// (minute_ts ASC, symbol ASC). The mock used to concatenate per symbol in request
// order — control-center audit P1-1.
describe('handleRows: global multi-symbol ordering', () => {
  const REVERSED = ['CCCUSDT', 'BBBUSDT', 'AAAUSDT'];

  it('sorts globally by (minute_ts ASC, symbol ASC) regardless of request symbol order', () => {
    const page = handleRows(bundle, { symbols: REVERSED, limit: 200 }, ASOF);
    if (!isPage(page)) throw new Error('expected a page');
    expect(page.items).toHaveLength(N * 3);
    assertGloballyOrdered(page.items);
    // Explicitly: the caller's order is NOT echoed — the first rows are the earliest
    // minute, ascending by symbol, not all of CCCUSDT first.
    expect(page.items.slice(0, 3).map((r) => r.symbol)).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
    expect(page.items.slice(0, 3).map((r) => r.minute_ts)).toEqual([T0, T0, T0]);
  });

  it('holds the global order across page boundaries, not just within the first page', () => {
    const all = drain({ symbols: REVERSED, limit: 5 });
    expect(all).toHaveLength(N * 3);
    assertGloballyOrdered(all);
  });

  it('paginated union equals the unpaginated result, row for row', () => {
    const single = handleRows(bundle, { symbols: REVERSED, limit: 200 }, ASOF);
    if (!isPage(single)) throw new Error('expected a page');
    const drained = drain({ symbols: REVERSED, limit: 7 });
    expect(JSON.stringify(drained)).toBe(JSON.stringify(single.items));
  });

  it('is independent of the requested symbol order', () => {
    const forward = handleRows(bundle, { symbols: ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'], limit: 200 }, ASOF);
    const reverse = handleRows(bundle, { symbols: REVERSED, limit: 200 }, ASOF);
    if (!isPage(forward) || !isPage(reverse)) throw new Error('expected pages');
    expect(JSON.stringify(reverse.items)).toBe(JSON.stringify(forward.items));
  });

  // Platform resolves the requested symbols through a Set, so a repeated symbol selects
  // it once instead of emitting its rows twice.
  it('de-duplicates repeated symbols instead of duplicating their rows', () => {
    const page = handleRows(bundle, { symbols: ['AAAUSDT', 'AAAUSDT'], limit: 200 }, ASOF);
    if (!isPage(page)) throw new Error('expected a page');
    expect(page.items).toHaveLength(N);
    const keys = page.items.map((r) => `${r.minute_ts}|${r.symbol}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a repeated symbol does not perturb the global order of the others', () => {
    const withDup = handleRows(bundle, { symbols: ['CCCUSDT', 'AAAUSDT', 'CCCUSDT', 'BBBUSDT'], limit: 200 }, ASOF);
    const clean = handleRows(bundle, { symbols: REVERSED, limit: 200 }, ASOF);
    if (!isPage(withDup) || !isPage(clean)) throw new Error('expected pages');
    assertGloballyOrdered(withDup.items);
    expect(JSON.stringify(withDup.items)).toBe(JSON.stringify(clean.items));
  });

  // A bars-only 1h/1d snapshot has nothing that can back minute rows. Returning an empty
  // page would be indistinguishable from "your window matched nothing", so the handler
  // fails loudly instead — audit P1-2.
  it('returns minute_rows_unavailable for a bars-only 1h/1d snapshot', () => {
    const barsOnly = {
      historical: {
        barsBySymbolAndTimeframe: {
          BTCUSDT: { '1h': [{ tsMs: 3_600_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
        },
      },
    } as unknown as SnapshotBundle;
    const res = handleRows(barsOnly, { symbols: ['BTCUSDT'], limit: 10 }, ASOF);
    expect(isPage(res)).toBe(false);
    expect(res).toMatchObject({ category: 'not_found', code: 'minute_rows_unavailable' });
  });

  it('still serves rows when the snapshot has minute-grain bars but no native rows', () => {
    const minuteBars = {
      historical: {
        barsBySymbolAndTimeframe: {
          BTCUSDT: {
            '1m': [
              { tsMs: 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
              { tsMs: 120_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            ],
          },
        },
      },
    } as unknown as SnapshotBundle;
    const res = handleRows(minuteBars, { symbols: ['BTCUSDT'], limit: 10 }, ASOF);
    if (!isPage(res)) throw new Error('expected a page');
    expect(res.items).toHaveLength(2);
    expect(res.items[1]!.minute_ts - res.items[0]!.minute_ts).toBe(60_000);
  });

  it('serves an unknown symbol as a graceful empty page, not an error', () => {
    const page = handleRows(bundle, { symbols: ['NOPEUSDT'], limit: 10 }, ASOF);
    if (!isPage(page)) throw new Error('expected a page');
    expect(page.items).toEqual([]);
  });

  it('half-open range applies to every symbol in a multi-symbol request', () => {
    const page = handleRows(
      bundle,
      { symbols: REVERSED, fromMs: grid[0]!, toMs: grid[2]!, limit: 200 },
      ASOF,
    );
    if (!isPage(page)) throw new Error('expected a page');
    // [t0, t2) → minutes t0 and t1 only, for all three symbols; t2 excluded.
    expect(page.items).toHaveLength(6);
    expect(page.items.map((r) => r.minute_ts)).not.toContain(grid[2]);
    assertGloballyOrdered(page.items);
  });
});

// A snapshot need not be uniform: one symbol can carry native minute rows while another has
// nothing finer than 1h bars. A snapshot-wide availability check would call the resource
// available and then answer a HOURLY-only request with an empty page — indistinguishable from
// "your window matched nothing", the very failure P1-2 exists to remove. The guard is therefore
// scoped to the requested symbols.
describe('handleRows: mixed-grain snapshot, per-request guard', () => {
  const mixed = {
    historical: {
      rowsBySymbol: {
        MINUTEUSDT: grid.map((t) => row('MINUTEUSDT', t)),
      },
      barsBySymbolAndTimeframe: {
        HOURLYUSDT: {
          '1h': [
            { tsMs: 3_600_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { tsMs: 7_200_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
          ],
        },
      },
    },
  } as unknown as SnapshotBundle;

  it('fails when every requested known symbol is coarse-only', () => {
    const res = handleRows(mixed, { symbols: ['HOURLYUSDT'], limit: 10 }, ASOF);
    expect(isPage(res)).toBe(false);
    expect(res).toMatchObject({ category: 'not_found', code: 'minute_rows_unavailable' });
    // The message names the offending symbol rather than blaming the whole snapshot,
    // which does carry minute data for MINUTEUSDT.
    expect((res as { message: string }).message).toContain('HOURLYUSDT');
  });

  it('serves the request when at least one requested symbol is minute-capable', () => {
    const res = handleRows(mixed, { symbols: ['HOURLYUSDT', 'MINUTEUSDT'], limit: 200 }, ASOF);
    if (!isPage(res)) throw new Error(`expected a page, got ${JSON.stringify(res)}`);
    expect(res.items).toHaveLength(N);
    // The coarse-only symbol contributes nothing — it is never projected into minute_ts.
    expect(new Set(res.items.map((r) => r.symbol))).toEqual(new Set(['MINUTEUSDT']));
    assertGloballyOrdered(res.items);
  });

  it('keeps an unknown symbol a graceful empty page while the resource is available', () => {
    const res = handleRows(mixed, { symbols: ['NOPEUSDT'], limit: 10 }, ASOF);
    if (!isPage(res)) throw new Error(`expected a page, got ${JSON.stringify(res)}`);
    expect(res.items).toEqual([]);
  });

  it('still fails snapshot-wide when the request names nothing known and nothing is minute-grain', () => {
    const barsOnly = {
      historical: {
        barsBySymbolAndTimeframe: {
          HOURLYUSDT: { '1h': [{ tsMs: 3_600_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
        },
      },
    } as unknown as SnapshotBundle;
    const res = handleRows(barsOnly, { symbols: ['NOPEUSDT'], limit: 10 }, ASOF);
    expect(isPage(res)).toBe(false);
    expect(res).toMatchObject({ category: 'not_found', code: 'minute_rows_unavailable' });
  });
});
