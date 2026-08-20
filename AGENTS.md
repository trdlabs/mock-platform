# AGENTS.md — trading-mock-platform

Репозиторий входит в экосистему `trdlabs`. Кросс-репозиторные вопросы — архитектура и границы,
контракты API / MCP / SDK, раскатка и миграции, локальный стек, фикстуры mock-платформы — ведутся
из `../control-center`: начинать с [`../control-center/AGENTS.md`](../control-center/AGENTS.md).
Он несёт канонический порядок чтения и указывает на `repos.yaml` и на инвентарь этого
репозитория под `repos/`.

<!-- До 2026-08-21 здесь лежала своя копия этого порядка из семи пунктов — в шести
     репозиториях сразу. Копия разошлась бы с оригиналом при первой же правке; указателя
     достаточно. -->

Если `../control-center` рядом нет (отдельный клон) — пользоваться локальными документами.

## Что это
**Standalone, read-only, snapshot-backed мок read-поверхностей** приватной
`trading-platform`. Позволяет `trading-office` (и позже `trading-lab`) работать в
demo/course/research-средах **без** приватной платформы, бирж, кредов, прод-БД и VPS.

### Поверхности
- **Surface A — Ops Read** (потребитель: trading-office): HTTP GET (`ops.6`, **частичный** parity) +
  WS `/ops/events` replay + Tier-2 `/ops/runs/:id/analysis` (`ops.4`, capability-aware).
  `ops.6` — это версия контракта, а не равенство наборов роутов: мок отдаёт 11 из 18 платформенных
  `/ops`-роутов. Не реализованы `positions`, `runs/:id/state`, `runs/:id/positions`,
  `runs/:id/trades`, `log-refs`, `candidates`, `candidates/:id` — их нечем наполнить из
  санитизированного снапшота (обращение к ним даёт дефолтный 404 Hono, не `OpsError`).
  `/ops/runs/:id/analysis` — наоборот, **mock-only**: на платформе такого роута нет вовсе,
  сверять его byte-identity не с чем. Полная таблица — в README, раздел «Surface A — Ops Read parity».
- **Surface B — Research Read** (потребитель: trading-lab): контракт + snapshot→DTO адаптер +
  read-only capability descriptor. Транспорт (MCP/HTTP) — будущий инкремент; сейчас только seam.

⚠️ **НЕ делает (не дрейфуй за эти границы):** не исполняет и не симулирует торговлю/бэктест,
не держит кредов, не ходит на биржу/прод-БД, не ингестит live-данные. Бэктест/гипотезы —
это будущий `trading-backtester` (мок-инструменты бэктеста = `unavailable`,
reason `backtesting_moved_to_trading_backtester`).

## Стек
- **TypeScript**, **pnpm** монорепо, сборка `tsc` → `dist/`
- **Hono** (`@hono/node-server`, `@hono/node-ws`) — HTTP/WS
- **ajv** — валидация контрактов; **@modelcontextprotocol/sdk** — MCP (research-read)
- **tsx** (dev), **Vitest** (тесты), Docker (`docker-compose.mock.yml`)

## Структура `src/`
- `contract/` — **import-clean, извлекаемый** контракт: `common`, `ops-read`, `research-read`,
  `analysis`, `snapshot` (изоляция проверяется `verify:contract-isolation`)
- `snapshot/` + `snapshot/readers/` — чтение санитизированных снапшотов
- `http/`, `events/`, `ops/` (+ `ops/handlers/`) — Ops Read surface
- `research-read/` (+ `research-read/mcp/`) — Research Read surface
- `access/`, `safety/`, `bin/` — доступ, безопасность, точки входа

## Команды
```bash
cp .env.example .env
pnpm install && pnpm build       # tsc → dist/
MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic pnpm start
curl -s localhost:8839/ops/discover

pnpm typecheck                   # tsc --noEmit
pnpm test                        # vitest run
pnpm dev                         # tsx src/bin/start-mock-ops.ts
pnpm start:research-mcp          # research-read MCP сервер

# Гейты:
pnpm verify:contract-isolation   # contract/** не тянет приватное
pnpm verify:no-forbidden-deps    # нет запрещённых зависимостей
pnpm verify:no-secrets           # нет секретов
pnpm check                       # typecheck + contract-isolation + test
pnpm check:ci                    # check + no-forbidden-deps + no-secrets

# VPS → snapshot (isolated deps — see tools/fetch-snapshot/README.md):
cd tools/fetch-snapshot && pnpm install --ignore-workspace && cd ../..
pnpm fetch:snapshot -- --help
pnpm make:fixture -- --source data/snapshots/<raw-ref> --out data/snapshots/fixtures/<name> --top 11

# After fetch: skill `mock-snapshot-default-rollout` → ../control-center/scripts/rollout-mock-default-snapshot.sh
# SSOT: ../control-center/ecosystem-defaults.yaml — do not patch lab env by hand.
```

## Правила для агента (границы — критично)
- **НЕ импортируй** приватный platform runtime/core/db/execution/exchange/config и не требуй
  приватный репо/пакет/GitHub-auth на этапе Docker build/run.
- `src/contract/**` держи **import-clean** — `verify:contract-isolation` должен проходить.
- **Не реализуй и не фейкай бэктест** — он переехал в `trading-backtester`; держи `unavailable`.
- Никаких кредов/секретов в коде (`verify:no-secrets`).
- Обе поверхности строятся из одного снапшота: office = Ops Read, lab = research-read (seam).
- README/документация и уточняющие вопросы — на русском.

## Навигация по коду
**Обязательно** Gortex MCP вместо Read/Grep/Glob (PreToolUse hooks блокируют прямое чтение
индексированного кода). Полный workflow — в `CLAUDE.md`.

<!-- Перенесено из CLAUDE.md 2026-08-20 при сведении инструкций в один файл.
     Держать ВНЕ маркеров gortex:*, иначе `gortex init` затрёт. -->

## Gortex — граф вместо чтения файлов

Инструменты Gortex MCP предпочитать чтению файлов. Их перечень и порядок вызовов **впрыскивает
сам сервер** в начале каждой сессии — здесь он не повторяется. Повторённый, он протухает: до
2026-08-21 тут перечислялись `smart_context`, `verify_change`, `batch_edit`, `check_guards`,
`search_symbols` и ещё десяток имён, которых в поверхности `facade-v1` уже нет.

**Калибровка, которой у сервера нет: граф сужает область, исходник подтверждает поведение.**
Граф говорит, ГДЕ логика и ЧТО с ней связано; как она себя ведёт — говорит исходник. Символ,
который правишь или на который опираешься, читай телом целиком, а не по однострочной сводке.

Особенно с поведенчески-критичным кодом — миграции, повторы и откаты, слои совместимости,
конкурентные участки и пиннящие их тесты. Там читать настоящую реализацию и никогда не
передавать `compress_bodies:true`: он вырезает ровно те ветки, в которых риск.

## What this repo is (do not drift)
trading-mock-platform mirrors the READ surfaces of the private trading-platform from sanitized snapshots.
- It MUST NOT import private platform runtime/core/db/execution/exchange/config, nor require the private
  repo/package/GitHub auth at Docker build/run.
- `src/contract/**` is import-clean and extractable, with TWO deliberate exceptions — the SDK seams:
  `src/contract/ops-read/dto.sdk.ts` re-exports the live bot-results contract from `@trdlabs/sdk/ops-read`,
  and `src/contract/historical-read/dto.sdk.ts` re-exports `CanonicalRowV2` from `@trdlabs/sdk/historical`.
  `pnpm verify:contract-isolation` machine-enforces that these are the *only* contract files importing the SDK —
  `research-read/dto.ts` and the rest stay dependency-free and extractable.
- A3 (feature 004): the shared contract is OWNED by `@trdlabs/sdk`, consumed as an EXACT npm pin — this is
  NOT a private-platform-runtime import. `pg`/`ccxt`/exchange SDKs, the private platform package, and the
  whole legacy `@trading-platform/*` scope stay forbidden with no carve-out (`verify:no-forbidden-deps`);
  the exact pin, its `SDK_VERSION`, its `ops.6`, and the `/conformance` export are gated by `verify:sdk-pin`.
  The conformance harness comes from that same package — nothing is vendored except the platform-owned
  historical golden, which `verify:golden-sync` checks.
- Two surfaces from one snapshot: Ops Read (office, HTTP/WS) and Research Read (lab, seam only here).
- No backtesting is implemented or faked; backtest tools are `unavailable` (reason
  `backtesting_moved_to_trading_backtester`). Execution belongs to the future trading-backtester.
- Framing: office = Ops Read consumer; lab = research-read consumer (integration deferred); backtester = future.
