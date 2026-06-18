# Phase 011 — Unified Demo Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Расширить demo-стек smoke-проверками для mock-platform/backtester и добавить e2e-тест полного исследовательского цикла.

**Architecture:** Все изменения — только в `trading-lab`. Worktree для `trading-lab` создаётся из `/home/alexxxnikolskiy/projects/trading-lab`. Smoke.sh получает demo-блок с двумя новыми проверками через ingress-контейнер. Новый `scripts/e2e.mjs` (Node.js ESM) запускается внутри ingress-контейнера через stdin pipe и тестирует полный цикл strategy.onboard → research.run_cycle.completed.

**Tech Stack:** bash, Node.js ESM (e2e.mjs), docker compose exec, Makefile, Markdown

---

## Контекст для агента

- Worktree: работаем в `/home/alexxxnikolskiy/projects/trading-lab` (прямо, без дополнительного worktree — это уже sibling-проект)
- Ветка создаётся: `git -C /home/alexxxnikolskiy/projects/trading-lab checkout -b feat/011-unified-demo-stack`
- Spec: `docs/superpowers/specs/2026-06-18-phase-011-unified-demo-stack-design.md` (в trading-mock-platform)
- Сервисы в demo-стеке (Docker network): `mock-platform:8839`, `backtester:8080`, `ingress:3000`, `read-api:3100`
- Env vars доступны внутри ingress-контейнера: `TRADING_LAB_TASK_TOKEN`, `TRADING_LAB_READ_TOKEN`, `MOCK_OPS_TOKEN`

---

## File Structure

| Файл | Действие |
|------|----------|
| `trading-lab/scripts/smoke.sh` | Modify: добавить demo-блок после office-проверок |
| `trading-lab/scripts/e2e.mjs` | Create: Node.js ESM полный цикл |
| `trading-lab/Makefile` | Modify: добавить цель `e2e` |
| `trading-lab/README.md` | Modify: обновить раздел "Запуск и демонстрация" |

---

## Task 1: Расширить smoke.sh — проверки mock-platform + backtester

**Files:**
- Modify: `scripts/smoke.sh` (в `/home/alexxxnikolskiy/projects/trading-lab/`)

- [ ] **Step 1: Создать ветку**

```bash
git -C /home/alexxxnikolskiy/projects/trading-lab checkout -b feat/011-unified-demo-stack
```

Expected: `Switched to a new branch 'feat/011-unified-demo-stack'`

- [ ] **Step 2: Найти точку вставки в smoke.sh**

Открыть `scripts/smoke.sh`. Найти строку:
```bash
if [ "$MODE" != "demo" ]; then
```

Новый demo-блок вставляется **перед** этой строкой.

- [ ] **Step 3: Вставить demo-блок в smoke.sh**

Заменить в `scripts/smoke.sh` строку:
```bash
if [ "$MODE" != "demo" ]; then
```

На:
```bash
if [ "$MODE" = "demo" ]; then
  echo "[smoke:${MODE}] mock-platform (via ingress container)…"
  MOCK_TOKEN="${MOCK_OPS_TOKEN:-}"
  $COMPOSE exec -T ingress node -e "fetch('http://mock-platform:8839/ops/discover',{headers:{Authorization:'Bearer ${MOCK_TOKEN}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "mock-platform /ops/discover" || bad "mock-platform /ops/discover"

  echo "[smoke:${MODE}] backtester (via ingress container)…"
  $COMPOSE exec -T ingress node -e "fetch('http://backtester:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "backtester /health" || bad "backtester /health"
fi

if [ "$MODE" != "demo" ]; then
```

- [ ] **Step 4: Проверить синтаксис**

```bash
bash -n /home/alexxxnikolskiy/projects/trading-lab/scripts/smoke.sh
```

Expected: нет вывода (синтаксис OK)

- [ ] **Step 5: Commit**

```bash
git -C /home/alexxxnikolskiy/projects/trading-lab add scripts/smoke.sh
git -C /home/alexxxnikolskiy/projects/trading-lab commit -m "feat(011): extend smoke.sh with mock-platform + backtester checks in demo mode"
```

---

## Task 2: Создать scripts/e2e.mjs — полный исследовательский цикл

**Files:**
- Create: `scripts/e2e.mjs` (в `/home/alexxxnikolskiy/projects/trading-lab/`)

- [ ] **Step 1: Создать `scripts/e2e.mjs`**

Создать файл `/home/alexxxnikolskiy/projects/trading-lab/scripts/e2e.mjs` со следующим содержимым:

```javascript
#!/usr/bin/env node
/**
 * e2e smoke — полный исследовательский цикл.
 * Запускается внутри ingress-контейнера через stdin pipe:
 *   docker compose ... exec -T ingress node --input-type=module < scripts/e2e.mjs
 *
 * Алгоритм:
 *   1. POST /tasks → strategy.onboard (фиксированный контент)
 *   2. POLL /v1/agent-events?taskId=<id> до strategy.onboard.deduped ИЛИ strategy_analyst.completed
 *      a) deduped → profileId из payload.strategyId, переход к шагу 4
 *      b) completed → sleep 2s → повторный POST → deduped → profileId
 *   3. POST /tasks → research.run_cycle { strategyProfileId }
 *   4. POLL /v1/agent-events?taskId=<id2> до research.run_cycle.completed (таймаут 8 мин)
 *   5. EXIT 0 PASS / EXIT 1 FAIL
 */

const INGRESS_URL          = 'http://localhost:3000';
const READ_API_URL         = 'http://localhost:3100';
const TASK_TOKEN           = process.env.TRADING_LAB_TASK_TOKEN ?? 'demo-task-token';
const READ_TOKEN           = process.env.TRADING_LAB_READ_TOKEN ?? 'demo-read-token';
const ONBOARD_TIMEOUT_MS   = 5 * 60 * 1000;
const RESEARCH_TIMEOUT_MS  = 8 * 60 * 1000;
const POLL_INTERVAL_MS     = 2_000;
const RESEARCH_POLL_MS     = 5_000;

// Фиксированный контент — первый запуск создаёт профиль, последующие дают deduped
const E2E_CONTENT = `// e2e-smoke strategy — do not modify
function run(ctx) { return ctx.signals.slice(0, 1); }
`;

const start = Date.now();
const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

function log(msg) { console.log(`[e2e ${elapsed()}] ${msg}`); }
function fail(reason) { console.error(`[e2e ${elapsed()}] FAIL  ${reason}`); process.exit(1); }

async function postTask(payload) {
  const res = await fetch(`${INGRESS_URL}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TASK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /tasks ${res.status}: ${text}`);
  }
  return res.json();
}

async function pollEvents(taskId, predicate, timeoutMs, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;
  let after = undefined;
  while (Date.now() < deadline) {
    const url = new URL(`${READ_API_URL}/v1/agent-events`);
    url.searchParams.set('taskId', taskId);
    if (after) url.searchParams.set('cursor', after);
    url.searchParams.set('limit', '50');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    if (!res.ok) throw new Error(`GET /v1/agent-events ${res.status}`);

    const body = await res.json();
    for (const ev of body.data ?? []) {
      const result = predicate(ev);
      if (result !== null && result !== undefined && result !== false) return result;
    }
    if (body.page?.nextCursor) {
      after = body.page.nextCursor;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Шаг 1: Onboard ──────────────────────────────────────────────────────────
log('submitting strategy.onboard…');
let onboardTask;
try {
  onboardTask = await postTask({
    taskType: 'strategy.onboard',
    source: 'e2e',
    correlationId: `e2e-${Date.now()}`,
    payload: { kind: 'bot_code', content: E2E_CONTENT },
  });
} catch (err) {
  fail(`strategy.onboard submit: ${err.message}`);
}
const taskId1 = onboardTask.taskId;
log(`strategy.onboard taskId=${taskId1}`);

// ── Шаг 2: Ждём profileId ───────────────────────────────────────────────────
log('waiting for strategy profile (deduped or analyst.completed)…');
let profileId = await pollEvents(taskId1, ev => {
  if (ev.type === 'strategy.onboard.deduped') {
    log(`deduped: strategyId=${ev.payload?.strategyId}`);
    return ev.payload?.strategyId ?? null;
  }
  if (ev.type === 'strategy_analyst.completed') {
    log('analyst.completed (fresh profile), will re-submit to get profileId…');
    return 'FRESH';
  }
  return false;
}, ONBOARD_TIMEOUT_MS);

if (profileId === null) fail(`strategy.onboard timed out after ${ONBOARD_TIMEOUT_MS / 1000}s`);

if (profileId === 'FRESH') {
  // ── Шаг 3: Повторный POST чтобы получить deduped с profileId ──────────────
  await sleep(2_000);
  log('re-submitting strategy.onboard to extract profileId via dedup…');
  let dedupeTask;
  try {
    dedupeTask = await postTask({
      taskType: 'strategy.onboard',
      source: 'e2e',
      correlationId: `e2e-dedup-${Date.now()}`,
      payload: { kind: 'bot_code', content: E2E_CONTENT },
    });
  } catch (err) {
    fail(`strategy.onboard dedup-submit: ${err.message}`);
  }
  const taskId1b = dedupeTask.taskId;
  log(`dedup taskId=${taskId1b}, waiting for strategy.onboard.deduped…`);
  profileId = await pollEvents(taskId1b, ev => {
    if (ev.type === 'strategy.onboard.deduped') {
      log(`deduped: strategyId=${ev.payload?.strategyId}`);
      return ev.payload?.strategyId ?? null;
    }
    return false;
  }, ONBOARD_TIMEOUT_MS);
  if (!profileId) fail('could not extract strategyProfileId from dedup event');
}

log(`strategyProfileId=${profileId}`);

// ── Шаг 4: research.run_cycle ───────────────────────────────────────────────
log('submitting research.run_cycle…');
let cycleTask;
try {
  cycleTask = await postTask({
    taskType: 'research.run_cycle',
    source: 'e2e',
    correlationId: `e2e-cycle-${Date.now()}`,
    payload: { strategyProfileId: profileId },
  });
} catch (err) {
  fail(`research.run_cycle submit: ${err.message}`);
}
const taskId2 = cycleTask.taskId;
log(`research.run_cycle taskId=${taskId2}`);

// ── Шаг 5: Ждём research.run_cycle.completed ────────────────────────────────
log('waiting for research.run_cycle.completed (up to 8 min)…');
const cycleResult = await pollEvents(taskId2, ev => {
  if (ev.type === 'research.run_cycle.completed') return 'DONE';
  if (ev.type === 'research.run_cycle.failed') return `FAILED:${ev.payload?.error ?? 'unknown'}`;
  return false;
}, RESEARCH_TIMEOUT_MS, RESEARCH_POLL_MS);

if (!cycleResult) fail(`research.run_cycle timed out after ${RESEARCH_TIMEOUT_MS / 1000}s`);
if (cycleResult.startsWith('FAILED:')) fail(cycleResult);

log(`PASS  (total ${elapsed()})`);
```

- [ ] **Step 2: Сделать скрипт исполняемым и проверить синтаксис Node.js**

```bash
chmod +x /home/alexxxnikolskiy/projects/trading-lab/scripts/e2e.mjs
node --input-type=module --check < /home/alexxxnikolskiy/projects/trading-lab/scripts/e2e.mjs
```

Expected: нет вывода (синтаксис OK)

- [ ] **Step 3: Commit**

```bash
git -C /home/alexxxnikolskiy/projects/trading-lab add scripts/e2e.mjs
git -C /home/alexxxnikolskiy/projects/trading-lab commit -m "feat(011): add e2e.mjs — full strategy.onboard → research.run_cycle.completed cycle"
```

---

## Task 3: Добавить цель `e2e` в Makefile

**Files:**
- Modify: `Makefile` (в `/home/alexxxnikolskiy/projects/trading-lab/`)

- [ ] **Step 1: Добавить `e2e` в .PHONY и добавить цель**

Найти в `Makefile` строку:
```makefile
.PHONY: demo local vps down smoke config
```

Заменить на:
```makefile
.PHONY: demo local vps down smoke e2e config
```

- [ ] **Step 2: Добавить цель `e2e` после цели `smoke`**

Найти в `Makefile` блок:
```makefile
# Usage: make smoke MODE=demo
smoke:
	./scripts/smoke.sh $(MODE)
```

Заменить на:
```makefile
# Usage: make smoke MODE=demo
smoke:
	./scripts/smoke.sh $(MODE)

# Usage: make e2e [MODE=demo]   — requires running demo stack (make demo)
e2e:
	docker compose -f docker-compose.yml -f docker-compose.$(or $(MODE),demo).yml \
	  --env-file .env.$(or $(MODE),demo) exec -T ingress \
	  node --input-type=module < scripts/e2e.mjs
```

- [ ] **Step 3: Проверить синтаксис Makefile**

```bash
make -C /home/alexxxnikolskiy/projects/trading-lab -n e2e 2>&1 | head -5
```

Expected: строка с `docker compose ... exec -T ingress node --input-type=module`

- [ ] **Step 4: Commit**

```bash
git -C /home/alexxxnikolskiy/projects/trading-lab add Makefile
git -C /home/alexxxnikolskiy/projects/trading-lab commit -m "feat(011): add e2e Makefile target"
```

---

## Task 4: Обновить README.md — раздел "Запуск и демонстрация"

**Files:**
- Modify: `README.md` (в `/home/alexxxnikolskiy/projects/trading-lab/`)

- [ ] **Step 1: Обновить преамбулу раздела**

Найти в `README.md`:
```markdown
### Вариант A — Docker Compose (рекомендуется, одна команда)

Поднимает весь стенд: бэкенд trading-lab (ingress + worker + read API), Postgres (pgvector), Redis,
миграции и **дашборд [trading-office](https://github.com/alexnikolskiy/trading-office)**.

Требования: **Docker + Compose v2 (≥ 2.17)**, рядом склонированный `trading-office`
(по умолчанию `../trading-office` — нужен как build-контекст для образов дашборда),
`curl` (для smoke-проверки).

```bash
cp .env.demo.example .env.demo
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build
# короче:  make demo
```
```

Заменить на:
```markdown
### Вариант A — Docker Compose (рекомендуется, одна команда)

Поднимает весь стенд: **mock-платформа** (`trading-mock-platform`), **бэктестер**
(`trading-backtester`), бэкенд trading-lab (ingress + worker + read API), Postgres (pgvector),
Redis, миграции и **дашборд [trading-office](https://github.com/alexnikolskiy/trading-office)**.

Требования: **Docker + Compose v2 (≥ 2.17)**, рядом склонированные `trading-office`,
`trading-mock-platform`, `trading-backtester` (пути задаются в `.env.demo`), `curl` (для smoke).

```bash
cp .env.demo.example .env.demo
# Открыть .env.demo, указать TRADING_MOCK_PLATFORM_PATH и TRADING_BACKTESTER_PATH
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build
# короче:  make demo
```
```

- [ ] **Step 2: Обновить таблицу сервисов**

Найти в `README.md`:
```markdown
Что поднимается (режим **demo**: self-contained, fake-агенты, без ключей):

| Сервис | Роль | Доступ |
|--------|------|--------|
| postgres / redis | БД (pgvector) и очередь | только внутри Docker-сети |
| migrate | одноразовая миграция схемы | — |
| ingress / worker | бэкенд агента (ingress + read API + worker) | только внутри сети |
| office-server | бэкенд дашборда (проксирует lab) | http://localhost:8787 |
| office-web | UI дашборда | http://localhost:8080 |
```

Заменить на:
```markdown
Что поднимается (режим **demo**: self-contained, fake-агенты, без ключей):

| Сервис | Роль | Доступ |
|--------|------|--------|
| mock-platform | read-only мок ops-данных (снапшот) | только внутри Docker-сети |
| backtester | мок-бэктестер для гипотез | только внутри Docker-сети |
| postgres / redis | БД (pgvector) и очередь | только внутри Docker-сети |
| migrate | одноразовая миграция схемы | — |
| ingress / worker | бэкенд агента (ingress + read API + worker) | только внутри сети |
| office-server | бэкенд дашборда (проксирует lab) | http://localhost:8787 |
| office-web | UI дашборда | http://localhost:8080 |
```

- [ ] **Step 3: Обновить команды проверки**

Найти в `README.md`:
```markdown
Проверка работоспособности и остановка:
```bash
make smoke MODE=demo     # ожидается:  [smoke:demo] PASS
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo down   # + -v чтобы снести том БД
```
```

Заменить на:
```markdown
Проверка работоспособности и остановка:
```bash
make smoke MODE=demo   # 7 проверок, ожидается:  [smoke:demo] PASS
make e2e               # полный цикл: strategy.onboard → research.run_cycle.completed (~5–10 мин)
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo down   # + -v чтобы снести том БД
```
```

- [ ] **Step 4: Добавить переменные окружения .env.demo после описания режимов**

Найти в `README.md`:
```markdown
**Другие режимы** (та же команда, другой overlay):
- **`make local`** — то же, что demo, плюс опциональный реальный read-only источник платформы по
  URL и реальный LLM (если задать ключ); см. `docs/docker-local.md`.
- **`make vps`** — production-like: detached, restart-политики, привязка к `${BIND_ADDR}`;
  см. `docs/docker-vps.md`.
- **`make config`** — валидирует все три overlay'я без запуска.
```

Заменить на:
```markdown
**Другие режимы** (та же команда, другой overlay):
- **`make local`** — то же, что demo, плюс опциональный реальный read-only источник платформы по
  URL и реальный LLM (если задать ключ); см. `docs/docker-local.md`.
- **`make vps`** — production-like: detached, restart-политики, привязка к `${BIND_ADDR}`;
  см. `docs/docker-vps.md`.
- **`make config`** — валидирует все три overlay'я без запуска.

#### Переменные окружения `.env.demo` (ключевые)

| Переменная | Пример | Описание |
|---|---|---|
| `TRADING_MOCK_PLATFORM_PATH` | `../trading-mock-platform` | Путь к склонированному trading-mock-platform |
| `TRADING_BACKTESTER_PATH` | `../trading-backtester` | Путь к склонированному trading-backtester |
| `MOCK_OPS_TOKEN` | `demo-ops-token` | Bearer-токен для запросов к mock-platform |
| `MOCK_OPS_TOKENS` | `sha256:abc…` | SHA256-хеш токена (проверяется mock-platform) |
| `MOCK_SNAPSHOT_REF` | `fixtures/2026-06-16-synthetic` | Имя снапшота с тестовыми данными |
| `BACKTESTER_AUTH_TOKEN` | `demo-backtester-token` | Bearer-токен для backtester |
| `TRADING_LAB_TASK_TOKEN` | `demo-task-token` | Bearer-токен для POST /tasks (e2e) |
| `TRADING_LAB_READ_TOKEN` | `demo-read-token` | Bearer-токен для GET /v1/* (e2e + smoke) |
```

- [ ] **Step 5: Commit**

```bash
git -C /home/alexxxnikolskiy/projects/trading-lab add README.md
git -C /home/alexxxnikolskiy/projects/trading-lab commit -m "docs(011): update README demo section with unified stack, e2e command, env table"
```

---

## Task 5: Создать PR и завершить

**Files:** нет новых файлов

- [ ] **Step 1: Push ветки**

```bash
git -C /home/alexxxnikolskiy/projects/trading-lab push -u origin feat/011-unified-demo-stack
```

- [ ] **Step 2: Создать PR**

```bash
gh pr create \
  --repo alexnikolskiy/trading-lab \
  --title "feat(011): unified demo stack — smoke + e2e + docs" \
  --body "$(cat <<'EOF'
## Phase 011 — Unified Demo Stack

### Changes
- `scripts/smoke.sh` — demo mode: adds health checks for mock-platform + backtester via ingress container
- `scripts/e2e.mjs` — new: full end-to-end test: strategy.onboard → research.run_cycle.completed
- `Makefile` — adds \`e2e\` target
- `README.md` — updated "Запуск и демонстрация": extended service table, e2e command, .env.demo variables

### Done when
- \`make smoke MODE=demo\` → 7 checks, all green
- \`make e2e\` → EXIT 0 within 15 min on demo data
- \`pnpm check\` passes

Spec: trading-mock-platform/docs/superpowers/specs/2026-06-18-phase-011-unified-demo-stack-design.md
EOF
)"
```

- [ ] **Step 3: Обновить roadmap — отметить Phase 011 как DONE**

Найти в `trading-mock-platform/docs/roadmaps/2026-06-18-full-mock-demo-stack-roadmap.md` строку с `## Phase 011`:

```markdown
## Phase 011 — Unified Demo Stack
```

Заменить на:

```markdown
## Phase 011 — Unified Demo Stack ✅ DONE
```

- [ ] **Step 4: Commit roadmap в trading-mock-platform**

```bash
git -C /home/alexxxnikolskiy/projects/trading-mock-platform add docs/roadmaps/2026-06-18-full-mock-demo-stack-roadmap.md
git -C /home/alexxxnikolskiy/projects/trading-mock-platform commit -m "docs: mark Phase 011 as DONE"
git -C /home/alexxxnikolskiy/projects/trading-mock-platform push
```

---

## Self-review

**Spec coverage:**
- ✅ smoke.sh: demo checks for mock-platform + backtester (Task 1)
- ✅ e2e.mjs: полный цикл strategy.onboard → research.run_cycle.completed (Task 2)
- ✅ Makefile: цель e2e (Task 3)
- ✅ README: таблица сервисов, env vars, команды e2e (Task 4)
- ✅ PR + roadmap обновление (Task 5)

**Placeholder scan:** нет TBD, нет TODO в коде. Все шаги содержат точные команды и код.

**Type consistency:** `taskId` (string) используется одинаково в Tasks 2 и других. `profileId` (string UUID) — одно имя везде.
