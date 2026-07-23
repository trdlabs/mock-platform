# 2026-07-24 — принятие env-catalog (item 5): типизированная env-схема

Статус: сделано в этом репо (PR `feat/env-schema`). Инициатива и контракт живут в control-center:
`docs/architecture/contracts/env-schema.md` + `scripts/src/contracts/env-schema-1.schema.json`
(контракт `env-schema.1`, cc#131).

## Что принято

- **Один `env.ts`** (`src/env.ts`, zod) — единственная точка чтения `process.env`; все 13
  переменных репо объявлены с типом, дефолтом, описанием, признаками secret/flag, owner_unit
  (`mock-platform`) и списком потребителей. Fail-fast: невалидный env валит старт со списком всех
  ошибок разом (значения секретов не печатаются).
- **Экспорт**: `pnpm env:schema` печатает документ `env-schema.1` в stdout (детерминированный
  JSON, сортировка по `name`; файл не коммитится). Repo id — `trading-mock-platform`.
- **Генерация**: `pnpm env:docs` производит `ENV.md` и `.env.example` из схемы; ручное
  редактирование запрещено, дрейф ловит `test/env/env-docs.test.ts`.
- **Гейты в тестах** (работают в обычном `pnpm test`):
  - полнота — `process.env` вне `src/env.ts` в `src/`/`scripts/`/`tools/` = красный тест;
  - контракт — экспорт валидируется вендоренной JSON Schema (ajv, draft 2020-12) + семантические
    правила (сортировка, уникальность, secret ⇒ default null);
  - генерация — перегенерация ENV.md/.env.example обязана дать те же байты.

## Решения по краям

- `HOME` объявлена в схеме ради полноты (единственное чтение — дефолт пути SSH-ключа в
  `tools/fetch-snapshot`); поведение `os.homedir()` не подменяли, чтобы не менять семантику.
- `MOCK_OPS_TOKENS` / `MOCK_RESEARCH_TOKENS` — **не** secret: это sha256-хэши токенов, не сами
  токены. Secret — `MOCK_RESEARCH_TOKEN` (сырой bearer) и `MOCK_SNAPSHOT_DB_URL` (пароль в URL,
  снят с argv в #40).
- `scripts/verify_golden_sync` переехал с `.mjs` (голый node) на `.ts` (tsx), чтобы читать
  `PLATFORM_REPO` через `env.ts`.
- `zod` добавлен в runtime-allowlist `verify_no_forbidden_deps` (Docker ставит `--prod`, а
  `src/env.ts` исполняется в проде).
- Деплой-таймовых флагов E4b-паттерна в репо пока нет — `flag: true` не объявлен ни у одной
  переменной.

## Дальше (вне этого PR)

- Агрегатор env-registry в control-center (item 6) начнёт захватывать `pnpm env:schema` этого
  репо; CI-дрейф-гейт каталога — на стороне control-center.
