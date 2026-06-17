# AGENTS.md — trading-mock-platform

> Гид для AI-агентов (Codex, Claude Code и др.). Обязательный навигационный workflow
> (Gortex MCP) и границы — в `CLAUDE.md`. Здесь — быстрый контекст и команды.

## Что это
**Standalone, read-only, snapshot-backed мок read-поверхностей** приватной
`trading-platform`. Позволяет `trading-office` (и позже `trading-lab`) работать в
demo/course/research-средах **без** приватной платформы, бирж, кредов, прод-БД и VPS.

### Поверхности
- **Surface A — Ops Read** (потребитель: trading-office): HTTP GET (`ops.3` parity) +
  WS `/ops/events` replay + Tier-2 `/ops/runs/:id/analysis` (`ops.4`, capability-aware).
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
