# Спека: зеркало ops.4 (entry/exit + trade-evidence/lifecycle) в trading-mock-platform

**Дата:** 2026-06-29
**Статус:** одобрено (дизайн), ожидает ревью спеки
**Источник истины формы:** `trading-platform/src/operations/dto.ts` (ops.4), зеркалится через
`@trading-platform/sdk/ops-read` (пакет 0.8.0, contract `ops.4`).

## Цель

Платформа подняла ops-read `ops.3 → ops.4`:
1. `ClosedTrade` получил `entryPrice`/`exitPrice` (`string | null`).
2. Новый батч-endpoint `GET /ops/trade-evidence?tradeIds=<id1>,…` (cap ≤ 25), возвращающий
   `PageEnvelope<TradeEvidence>` (single-page, `nextCursor: null`), где
   `TradeEvidence { tradeId, runId, symbol, side, openedAtMs, closedAtMs, entryPrice, exitPrice,
   realizedPnl, pnlPct, closeReason, lifecycle: TradeLifecycleEvent[] }`, а
   `TradeLifecycleEvent { tsMs, type: 'entry'|'dca'|'tp'|'sl'|'exit'|'stop_update', price: string|null,
   qty: string|null, note?: string|null }`.

Mock зеркалит READ-поверхность из санитизированных снапшотов. Live-DB у mock нет — он отдаёт
заранее запечённые `bundle.json`. Поэтому весь маппинг канонических событий в ops-форму выполняет
экспортёр (`tools/fetch-snapshot`), а runtime-хендлер просто отдаёт уже ops-shaped данные из бандла.

## Ключевое решение: lockstep-миграция версии

`src/snapshot/compat.ts` — exact-match на одну версию; `src/contract/ops-read/version.ts` — чистый
реэкспорт из SDK-сшивки (`dto.sdk.ts`). Следствие: апгрейд SDK `0.5.0 → 0.8.0` транзитивно переводит
`OPS_READ_CONTRACT_VERSION` в `ops.4`, и `compat` начинает требовать `ops.4`. Значит **все 5 фикстур**
должны переехать на ops.4 одновременно (не только две целевые), иначе `loadSnapshot`/CI краснеют.

## Lifecycle scope (без синтеза)

Маппинг `canonical.trade_lifecycle_event.event_type → ops`:

| canonical event_type        | ops type | price источник            | qty  |
|-----------------------------|----------|---------------------------|------|
| `trade_opened`              | `entry`  | `fill_price`              | `qty`|
| `trade_scaled_in`           | `dca`    | `fill_price`              | `qty`|
| `tp1_armed` / `tp_armed`    | `tp`     | `trigger_price`           | `null` (arm-событие не несёт qty) |
| `trade_closed`              | `exit`   | `fill_price`              | `qty`|

- `tsMs = business_ts_ms`; `note = redact(reason)`.
- `sl`/`stop_update` **НЕ синтезируем** — таких событий в журнале нет (стоп-лосс виден как
  `closeReason='stop_loss'` на `exit`). Они есть в union только ради forward-compat с lab-контрактом.
- Неизвестный `event_type` — defensive skip.

## Архитектура изменений (по узлам)

### 1. SDK-сшивка
- `package.json`: `@trading-platform/sdk` →
  `https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.8.0/trading-platform-sdk-0.8.0.tgz`.
- `src/contract/ops-read/dto.sdk.ts`: добавить в реэкспорт `TradeEvidence`, `TradeLifecycleEvent`,
  `OpsTradeLifecycleEventType`. `ClosedTrade` уже реэкспортится → `entryPrice/exitPrice` приходят сами.
- `src/contract/ops-read/version.ts`, `src/snapshot/compat.ts` — **не трогаем** (станут ops.4 транзитивно).
- `scripts/verify_vendored_sdk.ts`: `EXPECTED_OPS_VERSION` `'ops.3' → 'ops.4'`.

### 2. Контракт DTO
- `src/contract/ops-read/dto.local.ts`: алиас `export type TradeEvidencePage = PageEnvelope<TradeEvidence>`.
- `dto.ts` (barrel) — убедиться, что новые типы видны потребителям через сшивку.

### 3. Bundle + JSON-схема
- `src/contract/snapshot/bundle.ts`: `readonly tradeEvidenceByTrade: Readonly<Record<string, TradeEvidence>>`
  (ключ — opaque `tradeId`).
- `src/contract/snapshot/schema.ts` (всё `additionalProperties:false`):
  - в `$defs.closedTrade`: добавить `entryPrice`/`exitPrice` (`type: ['string','null']`) в `properties`
    **и** в `required`.
  - новые `$defs.tradeLifecycleEvent` и `$defs.tradeEvidence`.
  - `tradeEvidenceByTrade` в `BUNDLE_SCHEMA.properties` **и** `required`.

### 4. Reader + handler (зеркало `trades.ts`)
- `src/snapshot/readers/trade-evidence.ts`:
  `readTradeEvidence(bundle, tradeIds: readonly string[]): readonly TradeEvidence[]` — батч из
  `bundle.tradeEvidenceByTrade`, порядок = порядок запроса, отсутствующие опускаются.
  Импортирует типы из `dto.js` barrel (не из `dto.sdk.js`) — паттерн contract-isolation.
- `src/ops/handlers/trade-evidence.ts`:
  `handleTradeEvidence(bundle, tradeIdsCsv: string, asOf: number): TradeEvidencePage | OpsError`.
  Семантика платформенного `get-trade-evidence.ts`: split/trim/filter csv; пусто →
  `validation_error/missing_trade_ids`; `> 25` → `validation_error/too_many_trade_ids`; иначе
  single-page envelope с `nextCursor: null`. **Не курсорная пагинация** — `paginate()` не используется;
  envelope собирается напрямую (проверить хелпер сборки `PageEnvelope` в `ops/pagination.ts`/`common`).

### 5. HTTP + discover
- `src/http/app.ts`: `app.get('/ops/trade-evidence', (c) => respond(c, handleTradeEvidence(bundle,
  c.req.query('tradeIds') ?? '', now())))`.
- `src/ops/handlers/discover.ts::buildDiscover`: дескриптор ресурса `trade-evidence`
  (`supportedFilters: ['tradeIds']`, `pagination: null` — батч, `fields`: 12 полей TradeEvidence).
  `opsContractVersion` станет `ops.4` транзитивно.

### 6. fetch-snapshot (экспортёр)
- trades-SQL: добавить `avg_entry::text AS "entryPrice"`, `exit_price::text AS "exitPrice"` и протянуть
  в маппинг ClosedTrade.
- новый запрос к `canonical.trade_lifecycle_event`:
  `SELECT trade_id, event_type, business_ts_ms::text, fill_price::text, trigger_price::text, qty::text, reason
   FROM canonical.trade_lifecycle_event WHERE trade_id = ANY($1::text[]) ORDER BY trade_id, sequence_in_trade ASC`.
- сборка `tradeEvidenceByTrade`: на каждый закрытый trade в окне — `TradeEvidence` из полей `canonical.trade`
  (prices/pnl/closeReason) + `lifecycle[]` по маппингу выше (event_type→ops, tp-price из trigger_price,
  `note = redact(reason)`, skip неизвестных, без sl/stop_update).
- `manifest.versions.opsReadContractVersion`: `'ops.3' → 'ops.4'`.
- `buildBundle` и `mergeWithExisting`: учесть новый ключ `tradeEvidenceByTrade`.

### 7. Миграция фикстур
- новый `scripts/migrate-fixtures-ops4.ts`: для каждой фикстуры — добавить `entryPrice:null/exitPrice:null`
  в каждый `ClosedTrade`, `tradeEvidenceByTrade: {}`, bump manifest `opsReadContractVersion → ops.4`,
  пересчитать `checksums.json`, прогнать `loadSnapshot` как self-validation.
  Прогоняется на всех 5 фикстурах (`2026-06-12-real-top5`, `2026-06-16-synthetic`, `historical-golden`,
  `2026-06-18-real-all`, `2026-06-16-to-18-extended`) → репо зелёный сразу. Для двух целевых это
  временный placeholder, который заменит реальный fetch.
- `scripts/make-extended-fixture.ts`: править не нужно — deep-clone переносит новые поля, manifest через
  константу `OPS_READ_CONTRACT_VERSION` станет ops.4 (проверить, что `tradeEvidenceByTrade` клонируется).

### 8. Реальные данные (запускает пользователь через `!`)
DATABASE_URL + SSH к VPS недоступны в среде агента. После зелёного кода — точная команда:
`! pnpm fetch:snapshot ... --ref 2026-06-18-real-all` (перезапечёт real-all реальными ESPORTSUSDT
ценами + lifecycle), затем `! tsx scripts/make-extended-fixture.ts` (re-derive extended). Это апгрейдит
две целевые фикстуры с placeholder на реальные данные.

## Тесты (TDD)

- unit `readTradeEvidence`: батч, порядок запроса, пропуск missing.
- unit `handleTradeEvidence`: cap-25, пустой `tradeIds`, форма single-page envelope (`nextCursor:null`).
- schema: ClosedTrade с `entryPrice/exitPrice`; валидный/невалидный `TradeEvidence`.
- gate: `verify:vendored-sdk` ждёт `ops.4`.
- conformance/typecheck: реэкспорт ops.4-типов компилируется; contract-isolation не нарушен.

## Критерии приёмки

1. `/ops/trades` отдаёт реальные `entryPrice/exitPrice` для ESPORTSUSDT (после fetch).
2. `/ops/trade-evidence` отдаёт реальный lifecycle ESPORTSUSDT (после fetch).
3. `loadSnapshot` валиден на всех 5 фикстурах.
4. `/ops/discover` показывает `ops.4` + ресурс `trade-evidence`.
5. Гейты зелёные: `verify:vendored-sdk` (ops.4), `verify:contract-isolation`, `verify:no-forbidden-deps`,
   `typecheck`, `test`.

## Вне scope

- Бэктестинг (остаётся `unavailable`).
- Интеграция потребителей (office/lab) — отдельные циклы.
- Синтез `sl`/`stop_update`.
