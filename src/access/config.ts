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

export function loadMockConfig(env: Record<string, string | undefined>): MockConfig {
  const bind = env.MOCK_OPS_BIND ?? '127.0.0.1';
  const port = Number(env.MOCK_OPS_PORT ?? '8839');
  const tokenAllowlist = (env.MOCK_OPS_TOKENS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (!LOOPBACK.has(bind) && tokenAllowlist.length === 0) {
    throw new Error(
      `non-loopback bind '${bind}' requires MOCK_OPS_TOKENS (sha256-hex allowlist) — refusing to start anonymously`,
    );
  }
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid MOCK_OPS_PORT '${env.MOCK_OPS_PORT}'`);

  const replayMode = (env.MOCK_REPLAY_MODE ?? 'loop');
  if (replayMode !== 'once' && replayMode !== 'loop') throw new Error(`invalid MOCK_REPLAY_MODE '${replayMode}'`);
  const replaySpeed = Number(env.MOCK_REPLAY_SPEED ?? '1');
  if (!(replaySpeed > 0)) throw new Error(`invalid MOCK_REPLAY_SPEED '${env.MOCK_REPLAY_SPEED}' (must be > 0)`);

  return {
    port, bind, tokenAllowlist,
    snapshotDir: env.MOCK_SNAPSHOT_DIR ?? './data/snapshots',
    snapshotRef: env.MOCK_SNAPSHOT_REF ?? 'fixtures/2026-06-16-synthetic',
    replayMode, replaySpeed,
  };
}
