/** In the mock, snapshot ids are ALREADY opaque (exporter encoded them). We only validate shape;
 *  we never decode to anything internal — there is no internal id space in the mock. */
export function decodeId(kind: 'run' | 'trade', raw: string): string {
  if (!raw || typeof raw !== 'string') throw new Error(`invalid ${kind} id`);
  return raw;
}
