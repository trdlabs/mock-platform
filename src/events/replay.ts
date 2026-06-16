import type { SnapshotBundle, ReplayFrame } from '../contract/snapshot/bundle.js';
import { handleRuns } from '../ops/handlers/runs.js';
import { handleRuntimeHealth } from '../ops/handlers/health.js';

/** Mirrors trading-platform OperationsSubscriptionService LiveUpdate. */
export interface LiveUpdate {
  readonly resource: 'runs' | 'runtime-health';
  readonly payload: unknown;
  readonly asOf: number;
}
export interface ReplayStep {
  readonly resource: ReplayFrame['resource'];
  readonly delayMs: number;    // time to wait BEFORE emitting this step (already speed-scaled)
  readonly update: LiveUpdate;
}

function projectionFor(bundle: SnapshotBundle, resource: ReplayFrame['resource'], asOf: number): LiveUpdate {
  if (resource === 'runs') return { resource, payload: handleRuns(bundle, {}, asOf), asOf };
  return { resource, payload: handleRuntimeHealth(bundle), asOf };
}

/** Pure, deterministic: the ordered steps for one pass through the snapshot's replay frames. */
export function buildReplaySequence(bundle: SnapshotBundle, speed: number): readonly ReplayStep[] {
  const frames = [...bundle.replay.frames].sort((a, b) => a.offsetMs - b.offsetMs);
  let prevOffset = 0;
  return frames.map((frame) => {
    const delayMs = Math.max(0, frame.offsetMs - prevOffset) / speed;
    prevOffset = frame.offsetMs;
    return { resource: frame.resource, delayMs, update: projectionFor(bundle, frame.resource, frame.offsetMs) };
  });
}
