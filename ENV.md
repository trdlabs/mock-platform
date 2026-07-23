# Переменные окружения — trading-mock-platform

<!-- СГЕНЕРИРОВАНО из src/env.ts командой `pnpm env:docs` — НЕ редактировать руками. -->
<!-- Дрейф-гейт: test/env/env-docs.test.ts. Машинный экспорт: `pnpm env:schema`. -->

Контракт: `env-schema.1` (control-center docs/architecture/contracts/env-schema.md). Единственная точка чтения переменных окружения — `src/env.ts`; невалидный env валит процесс на старте со списком всех ошибок разом.

| Имя | Тип | Обяз. | Дефолт | Secret | Flag | Описание |
| --- | --- | --- | --- | --- | --- | --- |
| `HOME` | `string` | нет | — | нет | нет | Системная $HOME (задаёт ОС). Читается только как дефолт пути SSH-ключа в tools/fetch-snapshot; объявлена ради полноты — env.ts единственная точка чтения process.env |
| `MOCK_OPS_BIND` | `string` | нет | `127.0.0.1` | нет | нет | Адрес bind HTTP ops-сервера (Surface A). Loopback по умолчанию; non-loopback (напр. 0.0.0.0 в Docker) требует непустой MOCK_OPS_TOKENS — иначе fail-closed отказ старта |
| `MOCK_OPS_PORT` | `int` | нет | `8839` | нет | нет | Порт HTTP ops-сервера; дефолт совпадает с дефолтом TRADING_PLATFORM_READ_URL в trading-office |
| `MOCK_OPS_TOKENS` | `csv` | нет | `''` (пусто) | нет | нет | Allowlist доступа к Surface A: sha256-hex ХЭШИ токенов через запятую (не сами токены — поэтому не secret). Пусто = доверие только loopback-клиентам |
| `MOCK_REPLAY_MODE` | enum: `once` \| `loop` | нет | `loop` | нет | нет | Режим WS-реплея /ops/events: once — один проход по кадрам, loop — по кругу |
| `MOCK_REPLAY_SPEED` | `float` | нет | `1` | нет | нет | Множитель скорости WS-реплея (> 0); 1 = реальное время кадров снапшота |
| `MOCK_RESEARCH_TOKEN` | `string` | нет | — | да | нет | Сырой bearer-токен, который research-гейтвей (Surface B, stdio MCP) предъявляет при старте; сверяется по sha256 с MOCK_RESEARCH_TOKENS. Не нужен при пустом allowlist (spawn-trusted) |
| `MOCK_RESEARCH_TOKENS` | `csv` | нет | `''` (пусто) | нет | нет | Allowlist доступа к research-гейтвею (Surface B): sha256-hex ХЭШИ токенов через запятую (зеркало семантики MOCK_OPS_TOKENS). Пусто = spawn-trusted |
| `MOCK_SNAPSHOT_DB_URL` | `url` | нет | — | да | нет | Postgres URL VPS для tools/fetch-snapshot (содержит пароль — НИКОГДА не argv, см. #40; альтернатива — --db-url-file с файлом 0600) |
| `MOCK_SNAPSHOT_DIR` | `string` | нет | `./data/snapshots` | нет | нет | Каталог снапшотов (data/snapshots в репо; в Docker монтируется томом) |
| `MOCK_SNAPSHOT_REF` | `string` | нет | `fixtures/2026-06-22-to-2026-06-28-vps` | нет | нет | Ref снапшота внутри MOCK_SNAPSHOT_DIR; дефолт — T1 native-1m SSOT-фикстура (одна константа на оба entrypoint'а — вторая копия однажды разъехалась) |
| `PLATFORM_GOLDEN` | `string` | нет | — | нет | нет | Dev-переменная scripts/make-golden-fixture.ts: путь до platform historical-golden MANIFEST.json; без неё берётся vendored-копия test/conformance/_vendored |
| `PLATFORM_REPO` | `string` | нет | — | нет | нет | Dev-переменная scripts/verify_golden_sync.ts: путь до чекаута platform для кросс-репо сверки golden; без неё берётся сосед ../platform, недоступен — WARN-skip |

Секреты: в каталоге/примерах — только имя и форма, никогда значение (значение в SOPS/age-контуре, см. b2c-ops-hardening item 3).
