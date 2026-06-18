# Phase 011 — Unified Demo Stack: Design Spec

**Date:** 2026-06-18  
**Status:** draft  
**Repo changes:** `trading-lab` (smoke.sh, e2e.mjs, Makefile, README.md)  
**Dependencies:** Phase 010 done (docker-compose.demo.yml, .env.demo.example wired)

---

## Goal

После Phase 010 demo-стек поднимает 5 сервисов одной командой (`make demo`).  
Phase 011 добавляет:
1. **smoke** — проверяет все 5 сервисов, включая mock-platform + backtester
2. **e2e** — доказывает полный цикл: `strategy.onboard → research.run_cycle.completed`
3. **README** — документирует unified demo в одном разделе на русском

---

## Scope (изменения только в `trading-lab`)

| Файл | Действие |
|------|----------|
| `scripts/smoke.sh` | Расширить: demo-секция с mock-platform + backtester |
| `scripts/e2e.mjs` | Создать: Node.js ESM полный цикл |
| `Makefile` | Добавить цель `e2e` |
| `README.md` | Обновить раздел "Запуск и демонстрация" |

---

## 1. `scripts/smoke.sh` — расширение demo-секции

Вставить блок **после** проверок `office` и **перед** финальным `if [ "$fail" ]`:

```bash
if [ "$MODE" = "demo" ]; then
  echo "[smoke:${MODE}] mock-platform (via ingress container)…"
  MOCK_TOKEN="${MOCK_OPS_TOKEN:-}"
  $COMPOSE exec -T ingress node -e \
    "fetch('http://mock-platform:8839/ops/discover',{headers:{Authorization:'Bearer ${MOCK_TOKEN}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "mock-platform /ops/discover" || bad "mock-platform /ops/discover"

  echo "[smoke:${MODE}] backtester (via ingress container)…"
  $COMPOSE exec -T ingress node -e \
    "fetch('http://backtester:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "backtester /health" || bad "backtester /health"
fi
```

> Используем ingress-контейнер потому что mock-platform/backtester не пробрасывают порты на хост.  
> MOCK_OPS_TOKEN уже загружен из .env.demo через `set -a; . "$ENV_FILE"; set +a` в начале скрипта.

---

## 2. `scripts/e2e.mjs` — полный цикл

Node.js ES-модуль, запускается внутри ingress-контейнера:

```
docker compose ... exec -T ingress node --input-type=module < scripts/e2e.mjs
```

### Алгоритм

```
1. POST /tasks (port 3000)  → strategy.onboard { kind:'bot_code', content: E2E_CONTENT }
   → {taskId: taskId1}

2. POLL /v1/agent-events?taskId=taskId1 (port 3100, каждые 2s, таймаут 5min)
   Ждём одно из:
     a) event.type === 'strategy.onboard.deduped'
        → profileId = event.payload.strategyId   (уже известен, переходим к шагу 4)
     b) event.type === 'strategy_analyst.completed'
        → переходим к шагу 3

3. sleep 2s (DB write завершится)
   POST /tasks → strategy.onboard с тем же E2E_CONTENT
   → {taskId: taskId1b}
   POLL /v1/agent-events?taskId=taskId1b до strategy.onboard.deduped
   → profileId = event.payload.strategyId

4. POST /tasks → research.run_cycle { strategyProfileId: profileId }
   → {taskId: taskId2}

5. POLL /v1/agent-events?taskId=taskId2 (каждые 5s, таймаут 8min)
   Ждём event.type === 'research.run_cycle.completed'
   → EXIT 0

   При таймауте или 'research.run_cycle.failed' → EXIT 1
```

### Константы

```javascript
const INGRESS_URL    = 'http://localhost:3000';
const READ_API_URL   = 'http://localhost:3100';
const TASK_TOKEN     = process.env.TRADING_LAB_TASK_TOKEN ?? 'demo-task-token';
const READ_TOKEN     = process.env.TRADING_LAB_READ_TOKEN ?? 'demo-read-token';
const ONBOARD_TIMEOUT_MS  = 5 * 60 * 1000;   // 5 min
const RESEARCH_TIMEOUT_MS = 8 * 60 * 1000;   // 8 min
// Фиксированный контент (первый запуск создаёт профиль, последующие — deduped)
const E2E_CONTENT = `// e2e-smoke strategy — do not modify
function run(ctx) { return ctx.signals.slice(0, 1); }
`;
```

### Выход

- `EXIT 0` + `[e2e] PASS  <timing>`
- `EXIT 1` + `[e2e] FAIL  <reason>`

---

## 3. `Makefile` — цель `e2e`

```makefile
e2e: ## Full end-to-end: strategy.onboard → research.run_cycle.completed (demo mode only)
	@MODE=${MODE:-demo}; \
	  echo "[e2e] running inside ingress container (MODE=$$MODE)…"; \
	  docker compose -f docker-compose.yml -f docker-compose.$$MODE.yml \
	    --env-file .env.$$MODE exec -T ingress \
	    node --input-type=module < scripts/e2e.mjs
```

Использование: `make e2e` или `make e2e MODE=demo`.

---

## 4. `README.md` — раздел "Запуск и демонстрация"

Обновить раздел (на русском). Структура:

```
## Запуск демо-стека

### Предварительные условия
- Docker Desktop / Docker Engine запущен
- Рядом склонированы: trading-mock-platform, trading-backtester (нужны для demo-стека)
- Скопировать .env.demo.example → .env.demo и вписать пути к соседним репо

### Быстрый старт
make demo             # поднимает 5 сервисов: mock-platform, backtester, ingress, worker, office
make smoke MODE=demo  # проверяет все 5 сервисов
make e2e              # доказывает полный исследовательский цикл (~5–10 мин)

### Что проверяет e2e
1. strategy.onboard — стратегия анализируется analyst-агентом
2. Получение strategyProfileId через dedup-событие
3. research.run_cycle — гипотезы строятся через backtester ← mock-platform
4. research.run_cycle.completed — полный цикл завершён

### Переменные окружения (.env.demo)
| Переменная                 | Описание |
|----------------------------|----------|
| TRADING_MOCK_PLATFORM_PATH | Путь к склонированному trading-mock-platform |
| TRADING_BACKTESTER_PATH    | Путь к склонированному trading-backtester |
| MOCK_OPS_TOKEN             | Bearer-токен для mock-platform |
| MOCK_OPS_TOKENS            | SHA256-хеш токена (проверяется mock-platform) |
| MOCK_SNAPSHOT_REF          | Имя снапшота (напр. fixtures/2026-06-16-synthetic) |
| BACKTESTER_AUTH_TOKEN      | Bearer-токен для backtester |
| TRADING_LAB_TASK_TOKEN     | Bearer-токен для POST /tasks |
| TRADING_LAB_READ_TOKEN     | Bearer-токен для GET /v1/* |
```

---

## Критерии готовности (Done when)

- [ ] `make smoke MODE=demo` проходит на чистом старте — 7 проверок, все зелёные
- [ ] `make e2e` завершается EXIT 0 в течение 15 минут на демо-данных
- [ ] README содержит unified demo раздел с командами и таблицей env vars
- [ ] `pnpm check` проходит без ошибок (typecheck + contract-isolation + test)

---

## Технические риски

| Риск | Митигация |
|------|-----------|
| Profile не успел сохраниться перед dedup-запросом | sleep 2s в e2e.mjs между `strategy_analyst.completed` и вторым POST |
| Гипотезы failing (нет данных в снапшоте) | `research.run_cycle.completed` эмитится даже при 0 гипотезах — e2e всё равно проходит |
| Таймаут backtester на холодном старте | Compose healthcheck ждёт ready; smoke.sh запускается после `make demo` (who blocks until healthy) |
