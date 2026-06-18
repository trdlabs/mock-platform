# Phase 010 — Wire `trading-lab` to the Mock-Backed Backtester: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a single `docker compose` command that starts the full research demo stack (mock-platform + backtester + lab + office) with graceful capability failure handling when datasets are unavailable.

**Architecture:** Dockerfile added to `trading-backtester` (single-stage tsx-based; the app has no tsc emit step — it uses tsx directly). New `docker-compose.research-demo.yml` overlay in `trading-lab` adds mock-platform + backtester services and overrides env vars for ingress/worker/office-server. Guard in `hypothesis-build.handler.ts` catches empty `listDatasets()` response before any platform calls.

**Tech Stack:** Docker multi-file compose (overlay), pnpm workspaces, tsx runtime, Fastify (backtester), Hono (mock-platform), Vitest (trading-lab tests).

**Repos touched:**
- `trading-backtester/` → `Dockerfile`
- `trading-lab/` → `docker-compose.research-demo.yml`, `.env.research-demo`, `src/orchestrator/handlers/hypothesis-build.handler.ts`, `src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts`
- `trading-mock-platform/` → roadmap update

---

## Task 1: Create `trading-backtester/Dockerfile`

**Files:**
- Create: `trading-backtester/Dockerfile`

**Context:** The backtester is a pnpm monorepo (`apps/backtester`, `packages/client`, `packages/research-contracts`). The app has no tsc emit — it uses `tsx` directly. `@trading-backtester/client` is built with `tsup` and produces `packages/client/dist/`. `@trading/research-contracts` is source-only (no build step). The service needs `apps/backtester/sandbox-harness/` and `apps/backtester/migrations/` at runtime. `BACKTESTER_HOST=0.0.0.0` is required for Docker (default is `127.0.0.1` which is unreachable from other containers).

- [ ] **Step 1: Verify dist output after pnpm build**

In `trading-backtester/`:
```bash
pnpm --filter @trading-backtester/client build
ls packages/client/dist/
# Expected: index.js  index.d.ts  wire.js  errors.js  client.js  types.js (or similar tsup output)
```

- [ ] **Step 2: Create the Dockerfile**

Create `trading-backtester/Dockerfile`:
```dockerfile
# trading-backtester Dockerfile
# Single-stage: the service app runs with tsx (no tsc emit step).
# @trading-backtester/client is built with tsup → dist/ for consumers.
FROM node:22-slim
WORKDIR /app
RUN corepack enable

# Install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/client/package.json packages/client/
COPY packages/research-contracts/package.json packages/research-contracts/
COPY apps/backtester/package.json apps/backtester/
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts

# Copy source (tsx reads it at runtime)
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/backtester/src apps/backtester/src/
COPY apps/backtester/tsconfig.json apps/backtester/
# sandbox-harness is required at runtime (strategy execution)
COPY apps/backtester/sandbox-harness apps/backtester/sandbox-harness/
# migrations are applied via the pg client on first start
COPY apps/backtester/migrations apps/backtester/migrations/
# fixtures for FixtureDataPort (used when BACKTESTER_DATA_SOURCE=fixture)
COPY apps/backtester/fixtures apps/backtester/fixtures/

# Build @trading-backtester/client so consumers (trading-lab) can use it from the image's dist
RUN pnpm --filter @trading-backtester/client build

ENV NODE_ENV=production
ENV BACKTESTER_HOST=0.0.0.0
ENV BACKTESTER_PORT=8080
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "apps/backtester/src/index.ts"]
```

- [ ] **Step 3: Verify build locally**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
docker build -t trading-backtester:test .
# Expected: Successfully built ...
docker run --rm -e BACKTESTER_HOST=0.0.0.0 -e BACKTESTER_PORT=8080 -e BACKTESTER_DATA_SOURCE=fixture \
  -p 8080:8080 trading-backtester:test &
sleep 3 && curl -s http://localhost:8080/capabilities | head -c 100
# Expected: JSON with contractVersion
kill %1 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
git checkout -b feat/phase-010-dockerfile
git add Dockerfile
git commit -m "feat: add Dockerfile for research-demo stack (Phase 010)"
```

---

## Task 2: `research_platform.datasets_unavailable` guard in `hypothesis-build.handler.ts`

**Files:**
- Modify: `trading-lab/src/orchestrator/handlers/hypothesis-build.handler.ts` (around line 106 — right before `runPlatformBacktest`)
- Modify: `trading-lab/src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts`

**Context:** The handler already does a `missing_platform_run_config` check before `runPlatformBacktest`. We add a `datasets_unavailable` guard _after_ that check but _before_ `runPlatformBacktest`. `services.researchPlatform` is the `ResearchPlatformPort`. `event()` and `errMsg()` are imported from `./backtest-support.ts`. `markBuildFailed` signature: `markBuildFailed(buildId: string, issues: ValidationIssue[])`. `ValidationIssue` type: `{ code: string; severity: 'error'|'warning'; path: string; message: string }`.

- [ ] **Step 1: Write the failing test**

In `trading-lab/src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts`, after the existing tests (around end of file), add:

```typescript
it('research_platform: listDatasets returns [] → datasets_unavailable event + build_failed, no submit', async () => {
  let submitted = false;
  const stub: ResearchPlatformPort = {
    ...new MockResearchPlatformAdapter(),
    listDatasets: async () => ({ datasets: [] }),
    submitOverlayRun: async () => { submitted = true; throw new Error('should not be called'); },
  } as unknown as ResearchPlatformPort;

  const s = await seeded({ researchPlatform: stub, backtestBackend: 'research_platform' });
  await hypothesisBuildHandler(
    task({ hypothesisId: 'h1', backtestBackend: 'research_platform', platformRun: PLATFORM_RUN }),
    s,
  );

  expect(submitted).toBe(false);
  const runs = await s.backtests.listByHypothesis('h1');
  expect(runs).toHaveLength(0);

  const builds = await s.builds.listByHypothesis('h1');
  expect(builds[0]?.status).toBe('failed');
  expect(builds[0]?.issues?.some((i: ValidationIssue) => i.code === 'datasets_unavailable')).toBe(true);

  const events = await types(s);
  expect(events).toContain('research_platform.datasets_unavailable');
  expect(events).toContain('build_failed');
});
```

Note: `ValidationIssue` must be imported; check existing imports in the test file. `types(s)` is the helper that collects event types — use the same pattern as other tests in the file.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm test src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts 2>&1 | tail -20
# Expected: FAIL — test passes through to submitOverlayRun (no datasets guard yet)
```

- [ ] **Step 3: Add the datasets guard to `hypothesis-build.handler.ts`**

Locate the `research_platform` branch (around line 106 in the file). Change from:
```typescript
  if (backend === 'research_platform') {
    const resumeToken = sha256(stableStringify({ v: 1, hypothesisId: hypothesis.id, paramsHash, bundleHash: bundle.bundleHash }));
    await runPlatformBacktest({
```

To:
```typescript
  if (backend === 'research_platform') {
    const { datasets } = await services.researchPlatform.listDatasets();
    if (datasets.length === 0) {
      const issues: ValidationIssue[] = [{ code: 'datasets_unavailable', severity: 'error', path: '', message: 'No datasets available from research platform' }];
      await services.builds.markBuildFailed(buildId, issues);
      await services.events.append(event(task.id, 'research_platform.datasets_unavailable', { buildId, reason: 'no datasets returned — research platform may be misconfigured or data source unavailable' }));
      await services.events.append(event(task.id, 'build_failed', { buildId, codes: ['datasets_unavailable'] }));
      return;
    }
    const resumeToken = sha256(stableStringify({ v: 1, hypothesisId: hypothesis.id, paramsHash, bundleHash: bundle.bundleHash }));
    await runPlatformBacktest({
```

`ValidationIssue` is already imported at the top of the file. Verify with `grep "import.*ValidationIssue" src/orchestrator/handlers/hypothesis-build.handler.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm test src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts 2>&1 | tail -20
# Expected: all tests PASS
```

- [ ] **Step 5: Run full test suite and typecheck**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck 2>&1 | tail -10
# Expected: no errors

pnpm test 2>&1 | tail -10
# Expected: all tests PASS
```

- [ ] **Step 6: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git checkout -b feat/phase-010-lab-wiring
git add src/orchestrator/handlers/hypothesis-build.handler.ts \
        src/orchestrator/handlers/hypothesis-build.platform.handler.test.ts
git commit -m "feat: guard research_platform path on empty listDatasets (datasets_unavailable event)"
```

---

## Task 3: `docker-compose.research-demo.yml` in `trading-lab`

**Files:**
- Create: `trading-lab/docker-compose.research-demo.yml`

**Context:** This is a Docker Compose overlay. Run with:
```bash
docker compose -f docker-compose.yml -f docker-compose.research-demo.yml --env-file .env.research-demo up --build
```
The base `docker-compose.yml` defines networks `[trading]` and services `postgres, redis, migrate, ingress, worker, office-server, office-web`. The overlay adds new services and overrides environment variables. `MOCK_OPS_TOKEN` is the raw bearer token; `MOCK_OPS_TOKENS` is its sha256-hex for the mock-platform allowlist.

`trading-backtester` needs no authentication (internal service). The backtester's mock-platform access also uses the token via `BACKTESTER_MOCK_PLATFORM_URL` — but wait, the mock-platform requires a bearer token. Check: does `MockPlatformDataPort` send a token? Look at its constructor options in `apps/backtester/src/data/mock-platform-data-port.ts`.

Before writing the file, verify token requirement:
```bash
grep -n "token\|Token\|auth\|Authorization" \
  /home/alexxxnikolskiy/projects/trading-backtester/apps/backtester/src/data/mock-platform-data-port.ts | head -10
```
If `MockPlatformDataPort` has an `opsToken` option, add `BACKTESTER_MOCK_PLATFORM_TOKEN: "${MOCK_OPS_TOKEN}"` to the backtester service env and pass it via config. If not, the mock-platform must be configured without token enforcement for internal services (use a separate token or disable auth for the historical surface — check how `MOCK_OPS_TOKENS` applies to `/historical/*` routes).

- [ ] **Step 1: Check MockPlatformDataPort token option**

```bash
grep -n "token\|Token\|auth" \
  /home/alexxxnikolskiy/projects/trading-backtester/apps/backtester/src/data/mock-platform-data-port.ts | head -10
grep -n "MOCK_OPS_TOKENS\|tokens\|historical\|auth" \
  /home/alexxxnikolskiy/projects/trading-mock-platform/src/access/index.ts 2>/dev/null | head -10
```

- [ ] **Step 2: Create `docker-compose.research-demo.yml`**

```yaml
# Research Demo overlay — adds trading-mock-platform + trading-backtester to the base stack.
# Run: docker compose -f docker-compose.yml -f docker-compose.research-demo.yml \
#        --env-file .env.research-demo up --build
#
# Env vars required in .env.research-demo:
#   MOCK_OPS_TOKEN      — raw bearer token (used by lab, office, backtester)
#   MOCK_OPS_TOKENS     — sha256-hex of MOCK_OPS_TOKEN (verified by mock-platform)
#   TRADING_LAB_*_TOKEN — lab service tokens (can stay as dev-* defaults)

services:
  trading-mock-platform:
    build:
      context: ${TRADING_MOCK_PLATFORM_PATH:-../trading-mock-platform}
    image: trading-mock-platform:research-demo
    environment:
      MOCK_OPS_BIND: "0.0.0.0"
      MOCK_OPS_PORT: "8839"
      MOCK_OPS_TOKENS: "${MOCK_OPS_TOKENS:?set MOCK_OPS_TOKENS=sha256-hex of your demo token}"
      MOCK_SNAPSHOT_REF: "fixtures/2026-06-16-synthetic"
      MOCK_REPLAY_MODE: "loop"
      MOCK_REPLAY_SPEED: "1"
    ports:
      - "127.0.0.1:${MOCK_PLATFORM_PORT:-8839}:8839"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8839/ops/discover').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    networks:
      - trading

  trading-backtester:
    build:
      context: ${TRADING_BACKTESTER_PATH:-../trading-backtester}
    image: trading-backtester:research-demo
    environment:
      BACKTESTER_HOST: "0.0.0.0"
      BACKTESTER_PORT: "8080"
      BACKTESTER_DATA_SOURCE: "mock"
      BACKTESTER_MOCK_PLATFORM_URL: "http://trading-mock-platform:8839"
      BACKTESTER_MOCK_PLATFORM_TOKEN: "${MOCK_OPS_TOKEN}"
    depends_on:
      trading-mock-platform:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8080/capabilities').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    expose:
      - "8080"
    networks:
      - trading

  ingress:
    environment:
      TRADING_PLATFORM_INTEGRATION: "backtester"
      BACKTESTER_API_URL: "http://trading-backtester:8080"
      BACKTEST_BACKEND: "research_platform"
      LAB_BOT_RESULTS_INTEGRATION: "http"
      LAB_OPS_READ_URL: "http://trading-mock-platform:8839"
      LAB_OPS_READ_TOKEN: "${MOCK_OPS_TOKEN}"
    depends_on:
      trading-backtester:
        condition: service_healthy

  worker:
    environment:
      TRADING_PLATFORM_INTEGRATION: "backtester"
      BACKTESTER_API_URL: "http://trading-backtester:8080"
      BACKTEST_BACKEND: "research_platform"
      LAB_BOT_RESULTS_INTEGRATION: "http"
      LAB_OPS_READ_URL: "http://trading-mock-platform:8839"
      LAB_OPS_READ_TOKEN: "${MOCK_OPS_TOKEN}"
    depends_on:
      trading-backtester:
        condition: service_healthy

  office-server:
    environment:
      OFFICE_PLATFORM_ENABLED: "true"
      TRADING_PLATFORM_READ_URL: "http://trading-mock-platform:8839"
      TRADING_PLATFORM_READ_TOKEN: "${MOCK_OPS_TOKEN}"
    depends_on:
      trading-mock-platform:
        condition: service_healthy

  office-web:
    restart: "no"
```

- [ ] **Step 3: Validate compose syntax**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
docker compose -f docker-compose.yml -f docker-compose.research-demo.yml config --quiet 2>&1
# Expected: exits 0 (valid YAML / no schema errors)
```

- [ ] **Step 4: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add docker-compose.research-demo.yml
git commit -m "feat: add research-demo compose overlay (mock-platform + backtester services)"
```

---

## Task 4: `.env.research-demo` in `trading-lab`

**Files:**
- Create: `trading-lab/.env.research-demo`

**Context:** Committed to repo (no real secrets). Users substitute `MOCK_OPS_TOKENS`/`MOCK_OPS_TOKEN` before first run. All other vars have working demo defaults.

To generate token pair:
```bash
TOKEN=$(openssl rand -hex 16)
HASH=$(echo -n "$TOKEN" | sha256sum | cut -d' ' -f1)
echo "MOCK_OPS_TOKEN=$TOKEN"
echo "MOCK_OPS_TOKENS=$HASH"
```

- [ ] **Step 1: Create `.env.research-demo`**

```bash
# Research Demo stack — full research loop without private platform dependencies.
# Run: docker compose -f docker-compose.yml -f docker-compose.research-demo.yml \
#        --env-file .env.research-demo up --build
#
# ============================================================
# REQUIRED: generate a token pair before first run:
#   TOKEN=$(openssl rand -hex 16)
#   HASH=$(echo -n "$TOKEN" | sha256sum | cut -d' ' -f1)
#   Set MOCK_OPS_TOKEN=$TOKEN and MOCK_OPS_TOKENS=$HASH below.
# ============================================================
MOCK_OPS_TOKEN=replace-me-with-raw-token
MOCK_OPS_TOKENS=replace-me-with-sha256-hex-of-token

# Paths to sibling repos (override if your layout differs)
TRADING_MOCK_PLATFORM_PATH=../trading-mock-platform
TRADING_BACKTESTER_PATH=../trading-backtester

# Lab service-to-service tokens (dev defaults — override in production)
TRADING_LAB_READ_TOKEN=dev-read-token
TRADING_LAB_CHAT_TOKEN=dev-chat-token
TRADING_LAB_TASK_TOKEN=dev-task-token
TRADING_LAB_CALLBACK_TOKEN=dev-callback-token

# Office ports (host-bound)
OFFICE_WEB_PORT=8080
OFFICE_SERVER_PORT=8787
MOCK_PLATFORM_PORT=8839

# LLM keys — optional, leave blank for fake-adapter (key-free) demo
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

- [ ] **Step 2: Add `.env.research-demo` to git (it has no secrets — only placeholder values)**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add .env.research-demo
git commit -m "feat: add .env.research-demo for full research-demo stack"
```

---

## Task 5: Wire `BACKTESTER_MOCK_PLATFORM_TOKEN` in backtester config + MockPlatformDataPort

**Context:** After checking in Task 3 Step 1 whether `MockPlatformDataPort` already supports a token. If it does NOT, the mock-platform will reject requests from the backtester (token required when `MOCK_OPS_TOKENS` is set). This task adds the token support.

**Files:**
- Modify (if needed): `trading-backtester/apps/backtester/src/config.ts`
- Modify (if needed): `trading-backtester/apps/backtester/src/data/mock-platform-data-port.ts`
- Modify (if needed): `trading-backtester/apps/backtester/src/app.ts`

- [ ] **Step 1: Check if token is already supported**

```bash
grep -n "token\|Token\|auth\|Authorization\|Bearer" \
  /home/alexxxnikolskiy/projects/trading-backtester/apps/backtester/src/data/mock-platform-data-port.ts
```

If `opsToken` or similar is already in `MockPlatformDataPortOptions` → skip this task.

- [ ] **Step 2: If not supported — add `opsToken` to `MockPlatformDataPortOptions`**

In `mock-platform-data-port.ts`, extend the options interface:
```typescript
export interface MockPlatformDataPortOptions {
  readonly baseUrl: string;
  readonly pageLimit?: number;
  readonly opsToken?: string;          // ← add
}
```

In the fetch calls within `MockPlatformReader`, add the Authorization header:
```typescript
// In fetchJson (or wherever fetch is called):
const headers: Record<string, string> = {};
if (this.token) {
  headers['Authorization'] = `Bearer ${this.token}`;
}
const res = await this.fetchImpl(url, { headers });
```

Pass `token` from `MockPlatformDataPortOptions` down to `MockPlatformReader` via its constructor.

- [ ] **Step 3: Add `BACKTESTER_MOCK_PLATFORM_TOKEN` to config.ts**

In `apps/backtester/src/config.ts`, in `AppConfig`:
```typescript
readonly mockPlatformToken?: string;
```

In `loadConfig`:
```typescript
...(env.BACKTESTER_MOCK_PLATFORM_TOKEN ? { mockPlatformToken: env.BACKTESTER_MOCK_PLATFORM_TOKEN } : {}),
```

- [ ] **Step 4: Wire in app.ts**

In `apps/backtester/src/app.ts`, in the `mock` branch of `buildApp`:
```typescript
: config.dataSource === 'mock' && config.mockPlatformUrl
? new MockPlatformDataPort({
    baseUrl:   config.mockPlatformUrl,
    pageLimit: config.dataApiPageLimit,
    ...(config.mockPlatformToken ? { opsToken: config.mockPlatformToken } : {}),
  })
```

- [ ] **Step 5: Run tests + typecheck**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
pnpm typecheck 2>&1 | tail -5
pnpm test 2>&1 | tail -10
# Expected: all pass
```

- [ ] **Step 6: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
git add apps/backtester/src/data/mock-platform-data-port.ts \
        apps/backtester/src/config.ts \
        apps/backtester/src/app.ts
git commit -m "feat: add opsToken support to MockPlatformDataPort for authenticated mock-platform access"
```

---

## Task 6: Smoke test and roadmap update

**Files:**
- Modify: `trading-mock-platform/docs/roadmaps/2026-06-18-full-mock-demo-stack-roadmap.md`

- [ ] **Step 1: Run compose smoke test (optional — requires Docker)**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab

# Generate token pair
TOKEN=$(openssl rand -hex 16)
HASH=$(echo -n "$TOKEN" | sha256sum | cut -d' ' -f1)

# Patch .env.research-demo (don't commit the real values)
sed -i "s/replace-me-with-raw-token/$TOKEN/" .env.research-demo
sed -i "s/replace-me-with-sha256-hex-of-token/$HASH/" .env.research-demo

docker compose \
  -f docker-compose.yml \
  -f docker-compose.research-demo.yml \
  --env-file .env.research-demo \
  up --build -d 2>&1 | tail -20

# Wait for services
sleep 30

# Verify
curl -s http://localhost:8839/ops/discover | grep -q "contractVersion" && echo "mock-platform OK"
curl -s http://localhost:8080/capabilities | grep -q "contractVersion" && echo "backtester OK"
curl -s http://localhost:8787/api/office/agents/statuses | grep -q "200\|statuses" && echo "office OK"

# Restore placeholder
sed -i "s/$TOKEN/replace-me-with-raw-token/" .env.research-demo
sed -i "s/$HASH/replace-me-with-sha256-hex-of-token/" .env.research-demo

docker compose \
  -f docker-compose.yml \
  -f docker-compose.research-demo.yml \
  --env-file .env.research-demo \
  down
```

- [ ] **Step 2: Update roadmap**

In `trading-mock-platform/docs/roadmaps/2026-06-18-full-mock-demo-stack-roadmap.md`, change:
```markdown
## Phase 010 — Wire `trading-lab` to the Mock-Backed Backtester
```
to:
```markdown
## Phase 010 — Wire `trading-lab` to the Mock-Backed Backtester ✅ DONE 2026-06-18
```

And in the status table at the bottom:
```markdown
3. Phase 010 — lab wiring to the mock-backed backtester ✅
```

- [ ] **Step 3: Commit roadmap update**

```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git add docs/roadmaps/2026-06-18-full-mock-demo-stack-roadmap.md
git commit -m "docs: mark Phase 010 done in roadmap"
```

---

## Task 7: Open PRs for both repos

- [ ] **Step 1: Push and open PR for `trading-backtester`**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
git push -u origin feat/phase-010-dockerfile
gh pr create \
  --title "feat: Phase 010 — Dockerfile + opsToken for research-demo stack" \
  --body "$(cat <<'EOF'
## Summary
- Adds `Dockerfile` (single-stage, tsx runtime) to containerize the backtester service
- Adds `opsToken` support to `MockPlatformDataPort` for authenticated mock-platform access
- Wires `BACKTESTER_MOCK_PLATFORM_TOKEN` through config and app.ts

## Test plan
- [ ] `docker build -t trading-backtester:test .` succeeds
- [ ] `docker run ... trading-backtester:test` — `/capabilities` returns 200
- [ ] `pnpm test` passes (all existing tests + config tests)
- [ ] `pnpm typecheck` passes
EOF
)"
```

- [ ] **Step 2: Push and open PR for `trading-lab`**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git push -u origin feat/phase-010-lab-wiring
gh pr create \
  --title "feat: Phase 010 — research-demo compose + datasets_unavailable guard" \
  --body "$(cat <<'EOF'
## Summary
- Adds `docker-compose.research-demo.yml` overlay: starts mock-platform + backtester + lab + office in one command
- Adds `.env.research-demo` with documented env vars for the full research demo stack
- Adds `datasets_unavailable` guard in `hypothesis-build.handler.ts` with test coverage

## Test plan
- [ ] `pnpm test` passes (new test: listDatasets=[] → datasets_unavailable event)
- [ ] `pnpm typecheck` passes
- [ ] `docker compose -f docker-compose.yml -f docker-compose.research-demo.yml --env-file .env.research-demo config --quiet` exits 0
EOF
)"
```

---

## Verification Checklist

After all tasks complete, verify:

- [ ] `trading-backtester/Dockerfile` exists and `docker build` succeeds
- [ ] `pnpm test` + `pnpm typecheck` pass in `trading-lab`
- [ ] `pnpm test` + `pnpm typecheck` pass in `trading-backtester`
- [ ] `docker compose ... config --quiet` exits 0 for the research-demo stack
- [ ] Roadmap Phase 010 marked `✅ DONE`
