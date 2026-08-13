import { describe, it, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';
import type { CanonicalRowV2 } from '../../src/contract/historical-read/dto.js';
import { runDayIntegrityConformance } from '@trdlabs/sdk/conformance';

// Отдельный файл, а не блок в historical.conformance.test.ts: там уже поднимается
// свой сервер, и два сервера в одном файле под нагрузкой мешали друг другу —
// первый тест выбирал таймаут, второй получал `fetch failed`. Разделение делает
// каждый прогон независимым.
// Д3 — контракт целостности дня, проверенный ХАРНЕССОМ ИЗ УСТАНОВЛЕННОГО SDK.
//
// Остальные тесты этого файла проверяют мок нашими же утверждениями. Этот —
// утверждениями второй стороны: тем самым кодом из реестра, которым сверяется
// платформа. Расхождение real/mock, найденное на артефакте 0.17.0, прошло мимо
// локальных тестов именно потому, что они не знают, чего ждёт платформа.
describe('mock == real: day-integrity harness from the installed SDK', () => {
  const MIN = 60_000;
  const SYMBOL = 'AAAUSDT';
  const SYMBOL2 = 'BBBUSDT';
  const DATE = '2026-06-30';
  const DATE2 = '2026-07-01';
  const T0 = Date.parse(`${DATE}T00:00:00Z`);
  const T1 = Date.parse(`${DATE2}T00:00:00Z`);
  const MINUTES = 40;
  const DUP_IDX = 10;
  const DUP_TS = T0 + DUP_IDX * MIN;

  const mkRow = (symbol: string, minute_ts: number, i: number, oi: number): CanonicalRowV2 => ({
    schema_version: 2, minute_ts, symbol,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 + i, turnover: 1000 + i,
    oi_total_usd: oi, funding_rate: 0.0001, liq_long_usd: 5, liq_short_usd: 2, has_oi: true,
    has_funding: true, has_liquidations: true, taker_buy_volume_usd: 7, taker_sell_volume_usd: 6, has_taker_flow: true,
  });

  let srv: ReturnType<typeof serve>;
  let base: string;

  beforeAll(async () => {
    const bundle = {
      historical: {
        rowsBySymbol: {
          [SYMBOL]: [
            ...Array.from({ length: MINUTES }, (_, i) => mkRow(SYMBOL, T0 + i * MIN, i, 9_424_512.51)),
            // Прогревочная копия: свеча тождественна, агрегат расходится.
            mkRow(SYMBOL, DUP_TS, DUP_IDX, 1_659_073.71),
            // Другой, заведомо исправный день.
            ...Array.from({ length: MINUTES }, (_, i) => mkRow(SYMBOL, T1 + i * MIN, i, 7_000_000)),
          ],
          // Соседний символ того же дня, без собственного дубля.
          [SYMBOL2]: Array.from({ length: MINUTES }, (_, i) => mkRow(SYMBOL2, T0 + i * MIN, i, 5_000_000)),
        },
        barsBySymbolAndTimeframe: {},
        availability: {
          state: 'ready',
          earliestAvailableDay: DATE,
          lastContiguousClosedDay: DATE2,
          days: 2,
          archiveId: 'arch-conf',
          datasetId: 'ds-conf',
          availabilityId: `sha256:${'a'.repeat(64)}`,
          builtAtMs: 1_000,
        },
      },
    } as unknown as LoadedSnapshot['bundle'];

    const { app } = createApp({
      snapshot: { bundle } as LoadedSnapshot,
      tokenAllowlist: [],
      replay: { mode: 'once', speed: 1 },
    });
    await new Promise<void>((resolve) => {
      srv = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
    });
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  // Явный таймаут: харнесс делает семь последовательных HTTP-запросов, и
  // пятисекундного умолчания vitest на загруженной машине не хватает.
  it('passes runDayIntegrityConformance (4 limits, same-day clean window, other symbol, healthy other day)', async () => {
    await runDayIntegrityConformance({ baseUrl: base }, {
      symbol: SYMBOL,
      date: DATE,
      minuteTs: DUP_TS,
      fromMs: T0,
      toMs: T0 + MINUTES * MIN,
      sameDayCleanWindow: { fromMs: T0, toMs: T0 + (DUP_IDX - 1) * MIN },
      otherSymbolSameDay: SYMBOL2,
      healthyOtherDay: { fromMs: T1, toMs: T1 + MINUTES * MIN },
    });
  }, 30_000);
});
