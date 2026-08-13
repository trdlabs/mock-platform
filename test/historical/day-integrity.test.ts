// Д3 — целостность ключа дня в моке.
//
// Предмет проверки — не «умеем отказать», а то, ради чего отказ заведён: ответ
// перестал зависеть от `limit`. Курсор роняет вторую копию ключа, если граница
// страницы легла между копиями, и возвращает, если не легла, — то есть один и
// тот же запрос отдавал разное число строк при разном размере страницы.

import { describe, it, expect } from 'vitest';
import { handleRows } from '../../src/historical/handlers/rows.js';
import { createApp } from '../../src/http/app.js';
import { isDayIntegrityRejection } from '../../src/contract/historical-read/day-integrity.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../src/contract/historical-read/dto.js';

function row(symbol: string, minute_ts: number, oi: number | null): CanonicalRowV2 {
  return {
    schema_version: 2, minute_ts, symbol,
    open: 1, high: 2, low: 0, close: 1.5, volume: 10, turnover: 15,
    oi_total_usd: oi, funding_rate: null, liq_long_usd: null, liq_short_usd: null,
    has_oi: oi !== null, has_funding: false, has_liquidations: false,
    taker_buy_volume_usd: null, taker_sell_volume_usd: null, has_taker_flow: false,
  };
}

const DAY = Date.parse('2026-08-12T00:00:00Z');
const MIN = 60_000;
const N = 12;
/** Стык стоит в середине, чтобы граница страницы могла лечь и до, и после него. */
const SEAM_IDX = 5;
const SEAM_TS = DAY + SEAM_IDX * MIN;
const SYMBOL = 'AAAUSDT';

const seamRows = (): CanonicalRowV2[] => {
  const rows = Array.from({ length: N }, (_, i) => row(SYMBOL, DAY + i * MIN, 9_424_512.51));
  // Прогревочная копия: свеча тождественна, агрегат расходится — ровно как на
  // проде. Различить их по данным нельзя.
  rows.push(row(SYMBOL, SEAM_TS, 1_659_073.71));
  return rows;
};

const bundleWithSeam = { historical: { rowsBySymbol: { [SYMBOL]: seamRows() } } } as unknown as SnapshotBundle;
const cleanBundle = {
  historical: { rowsBySymbol: { [SYMBOL]: Array.from({ length: N }, (_, i) => row(SYMBOL, DAY + i * MIN, 1)) } },
} as unknown as SnapshotBundle;

const ASOF = 1_000;

describe('целостность ключа дня', () => {
  it('дубль ключа → отказ с точным телом', () => {
    const res = handleRows(bundleWithSeam, { symbols: [SYMBOL], limit: 100 }, ASOF);
    expect(isDayIntegrityRejection(res)).toBe(true);
    if (!isDayIntegrityRejection(res)) return;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'day integrity violated',
      code: 'DUPLICATE_ROW_KEY',
      permanent: true,
      retryFromStart: false,
      date: '2026-08-12',
      symbol: SYMBOL,
      minuteTs: SEAM_TS,
      generation: null,
    });
  });

  it('РАЗНЫЕ limit дают один и тот же ответ', () => {
    // Ядро проверки. До инварианта результат зависел от того, легла ли граница
    // страницы между копиями: при одном limit копия терялась, при другом нет.
    const bodies = [1, 2, 5, 6, 7, 1000].map((limit) => {
      const r = handleRows(bundleWithSeam, { symbols: [SYMBOL], limit }, ASOF);
      return JSON.stringify(isDayIntegrityRejection(r) ? r.body : { page: r });
    });
    expect(new Set(bodies).size).toBe(1);
  });

  it('чистый набор не задет', () => {
    // Разделяющая: без неё «fail-closed» неотличимо от «отказывает всегда».
    const res = handleRows(cleanBundle, { symbols: [SYMBOL], limit: 100 }, ASOF);
    expect(isDayIntegrityRejection(res)).toBe(false);
    expect((res as unknown as { items: unknown[] }).items).toHaveLength(N);
  });

  it('одна минута у РАЗНЫХ символов дублем не считается', () => {
    // Ключ составной. Проверка, сравнивающая только штамп, покраснела бы здесь —
    // и была бы бесполезна на любом многосимвольном запросе.
    const twoSymbols = {
      historical: {
        rowsBySymbol: {
          AAAUSDT: Array.from({ length: N }, (_, i) => row('AAAUSDT', DAY + i * MIN, 1)),
          BBBUSDT: Array.from({ length: N }, (_, i) => row('BBBUSDT', DAY + i * MIN, 1)),
        },
      },
    } as unknown as SnapshotBundle;
    const res = handleRows(twoSymbols, { symbols: ['AAAUSDT', 'BBBUSDT'], limit: 100 }, ASOF);
    expect(isDayIntegrityRejection(res)).toBe(false);
    expect((res as unknown as { items: unknown[] }).items).toHaveLength(2 * N);
  });

  it('проекция не прячет дубль: ключ входит в identity и из проекции не выпадает', () => {
    const res = handleRows(bundleWithSeam, { symbols: [SYMBOL], limit: 100, kinds: ['candles'] }, ASOF);
    expect(isDayIntegrityRejection(res)).toBe(true);
  });
});

describe('HTTP: отказ идёт мимо карты OpsError', () => {
  const appOf = (bundle: SnapshotBundle) =>
    createApp({
      snapshot: { bundle } as never,
      tokenAllowlist: [],
      replay: { mode: 'once', speed: 1 },
    }).app;

  const get = async (bundle: SnapshotBundle, qs: string) => {
    const res = await appOf(bundle).fetch(new Request(`http://mock/historical/rows?${qs}`));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('409 с телом контракта, а не 400/404/500', async () => {
    const r = await get(bundleWithSeam, `symbols=${SYMBOL}&limit=100`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DUPLICATE_ROW_KEY');
    expect(r.body.permanent).toBe(true);
    expect(r.body.retryFromStart).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(
      ['code', 'date', 'error', 'generation', 'minuteTs', 'permanent', 'retryFromStart', 'symbol'],
    );
  });

  it('разные limit — идентичный HTTP-ответ', async () => {
    const seen = new Set<string>();
    for (const limit of [1, 5, 6, 1000]) {
      const r = await get(bundleWithSeam, `symbols=${SYMBOL}&limit=${limit}`);
      seen.add(`${r.status}|${JSON.stringify(r.body)}`);
    }
    expect(seen.size).toBe(1);
  });

  it('чистый набор по-прежнему 200', async () => {
    const r = await get(cleanBundle, `symbols=${SYMBOL}&limit=100`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(N);
  });
});
