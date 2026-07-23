import { parseEnv, type Env } from '../env.js';

// Литералы дефолтов переехали в src/env.ts (единая схема env-catalog); реэкспорт сохраняет
// исторический импорт-путь для entrypoint'ов и тестов.
export { DEFAULT_SNAPSHOT_DIR, DEFAULT_SNAPSHOT_REF } from '../env.js';

export interface MockConfig {
  readonly port: number;
  readonly bind: string;
  readonly tokenAllowlist: readonly string[]; // sha256-hex
  readonly snapshotDir: string;
  readonly snapshotRef: string;
  readonly replayMode: 'once' | 'loop';
  readonly replaySpeed: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Кросс-полевые правила поверх типизированного env (per-var валидация уже в src/env.ts). */
export function mockConfigFromEnv(env: Env): MockConfig {
  const bind = env.MOCK_OPS_BIND;
  const tokenAllowlist = env.MOCK_OPS_TOKENS;

  if (!LOOPBACK.has(bind) && tokenAllowlist.length === 0) {
    throw new Error(
      `non-loopback bind '${bind}' requires MOCK_OPS_TOKENS (sha256-hex allowlist) — refusing to start anonymously`,
    );
  }

  return {
    port: env.MOCK_OPS_PORT,
    bind,
    tokenAllowlist,
    snapshotDir: env.MOCK_SNAPSHOT_DIR,
    snapshotRef: env.MOCK_SNAPSHOT_REF,
    replayMode: env.MOCK_REPLAY_MODE,
    replaySpeed: env.MOCK_REPLAY_SPEED,
  };
}

/** Историческая сигнатура (сырой env-record): parseEnv + кросс-полевые правила. */
export function loadMockConfig(env: Record<string, string | undefined>): MockConfig {
  return mockConfigFromEnv(parseEnv(env));
}
