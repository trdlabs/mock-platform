# AGENTS.md — trading-mock-platform

Часть экосистемы `trdlabs`. Кросс-репозиторные вопросы — архитектура, контракты, раскатка,
локальный стек — из [`../control-center/AGENTS.md`](../control-center/AGENTS.md): там канонический
порядок чтения и карта владения. Соседа рядом нет (отдельный клон) — работать по локальным документам.

## Что это

Standalone read-only мок read-поверхностей приватной `platform`, работающий из
санитизированных снимков. Позволяет `office` и `lab` работать в demo, курсовых и
исследовательских средах **без** приватной платформы, бирж, кредов, прод-БД и VPS.

Две поверхности из одного снимка: **Ops Read** (потребитель `office`, HTTP + WS) и
**Research Read** (потребитель `lab`, пока только шов).

**Не делает и дрейфовать за эти границы нельзя:** не исполняет и не симулирует торговлю и
бэктест, не держит кредов, не ходит на биржу и прод-БД, не ингестит живые данные. Бэктест
переехал в `backtester`; мок-инструменты бэктеста остаются `unavailable` с причиной
`backtesting_moved_to_trading_backtester`.

## Гейты

```bash
pnpm check       # typecheck + contract-isolation + test
pnpm check:ci    # check + no-forbidden-deps + no-secrets
```

Снимок с VPS: `tools/fetch-snapshot` ставится отдельно (`pnpm install --ignore-workspace`),
дальше `pnpm fetch:snapshot`, `pnpm make:fixture`. **Дефолтный снимок — SSOT в
`../control-center/ecosystem-defaults.yaml`; окружение `lab` руками не патчить.**

## Правила и грабли

- **Приватный runtime платформы не импортировать** (core, db, execution, exchange, config) и не
  требовать приватный репозиторий, пакет или GitHub-auth на этапе Docker build/run.
- `src/contract/**` держать import-clean — это машинно принуждается `verify:contract-isolation`.
  Два намеренных исключения — швы SDK: `contract/ops-read/dto.sdk.ts` и
  `contract/historical-read/dto.sdk.ts` реэкспортируют из `@trdlabs/sdk`. Гейт утверждает, что
  они **единственные** контрактные файлы, тянущие SDK.
- Общий контракт **принадлежит `@trdlabs/sdk`** и потребляется точным npm-пином — это не импорт
  приватного рантайма. `pg`, `ccxt`, биржевые SDK и весь legacy-скоуп `@trading-platform/*`
  запрещены без исключений (`verify:no-forbidden-deps`); пин, `SDK_VERSION`, `ops.6` и экспорт
  `/conformance` гейтит `verify:sdk-pin`.
- **`ops.6` — версия контракта, а не равенство наборов роутов.** Мок отдаёт 11 из 18
  платформенных `/ops`-роутов; отсутствующие дают дефолтный 404 Hono, а не `OpsError`.
  `/ops/runs/:id/analysis` наоборот mock-only — сверять его byte-identity не с чем.
  Полная таблица — README, раздел «Surface A — Ops Read parity».
- Секретов в коде нет (`verify:no-secrets`).
- Документация и уточняющие вопросы — на русском.
