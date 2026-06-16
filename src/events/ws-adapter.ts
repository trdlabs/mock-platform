import type { WSContext } from 'hono/ws';
import type { SnapshotBundle } from '../contract/snapshot/bundle.js';
import { buildReplaySequence } from './replay.js';

export interface ReplayOptions { mode: 'once' | 'loop'; speed: number; }

/** Streams the deterministic replay sequence to one websocket. Read-only: inbound is ignored. */
export function startReplay(ws: WSContext, bundle: SnapshotBundle, opts: ReplayOptions): () => void {
  let cancelled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const runPass = async (): Promise<void> => {
    const steps = buildReplaySequence(bundle, opts.speed);
    for (const step of steps) {
      if (cancelled) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { timers.delete(t); resolve(); }, step.delayMs);
        timers.add(t);
      });
      if (cancelled) return;
      ws.send(JSON.stringify(step.update));
    }
    if (!cancelled && opts.mode === 'loop') await runPass();
  };

  void runPass();
  return () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
