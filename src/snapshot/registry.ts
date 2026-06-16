import { join } from 'node:path';
import { loadSnapshot, type LoadedSnapshot } from './loader.js';

/** Resolve a snapshot ref under the snapshot root and load it once (eager, in-memory). */
export function openSnapshot(rootDir: string, ref: string): LoadedSnapshot {
  return loadSnapshot(join(rootDir, ref));
}
