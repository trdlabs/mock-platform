import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { AnalysisSnapshot } from '../../contract/analysis/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readAnalysis } from '../../snapshot/readers/analysis.js';
import { decodeId } from '../ids.js';

export function handleAnalysis(bundle: SnapshotBundle, runIdRaw: string): AnalysisSnapshot | OpsError {
  let runId: string;
  try { runId = decodeId('run', runIdRaw); }
  catch { return { category: 'validation_error', code: 'invalid_run_id', message: 'invalid run id' }; }
  const a = readAnalysis(bundle, runId);
  if (!a) return { category: 'not_found', code: 'run_not_found', message: 'run not found' };
  return a; // capability-aware omission is already encoded in the snapshot; never fabricate here
}
