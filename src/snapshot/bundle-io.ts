import { gzipSync, gunzipSync } from 'node:zlib';
import { constants as bufferConstants } from 'node:buffer';

/** GitHub file limit is 100 MB; gzip large VPS bundles instead of symbol-trimming. */
export const BUNDLE_GZIP_THRESHOLD_BYTES = 90 * 1024 * 1024;

/** `loadSnapshot` decodes a bundle into ONE JavaScript string before `JSON.parse`, so V8's max
 *  string length is a hard ceiling on any snapshot — on the DECODED form, which is why gzip does
 *  not raise it. Measured on the committed T2 fixture: 33.5 MiB of decoded bundle per symbol per
 *  42 days, so 512 MiB caps a 42-day fixture at ~15 symbols. */
export const BUNDLE_MAX_DECODED_BYTES = bufferConstants.MAX_STRING_LENGTH;

/** Fail with the two numbers and the remedy instead of letting V8 raise an opaque error deep
 *  inside `.toString('utf8')` — by then an oversized fixture has usually already been written.
 *  `limit` is a parameter because the ceiling belongs to the runtime that will LOAD the bundle
 *  (typically the mock's container), not to the process authoring it. */
export function assertBundleFitsInMemory(
  decodedByteLength: number,
  context: string,
  limit: number = BUNDLE_MAX_DECODED_BYTES,
): void {
  if (decodedByteLength <= limit) return;
  const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
  throw new Error(
    `snapshot bundle too large to load: ${context} decodes to ${decodedByteLength} bytes ` +
    `(${mib(decodedByteLength)} MiB), above the ${limit}-byte (${mib(limit)} MiB) ceiling. ` +
    'The loader turns the whole bundle into one JavaScript string, so gzip does not help — the ' +
    'limit is on the decoded form. Split the symbol set across several fixtures instead: a run ' +
    'selects one dataset at a time, so symbols do not have to share a bundle.',
  );
}

export const BUNDLE_JSON_REF = 'ops/bundle.json';
export const BUNDLE_GZIP_REF = 'ops/bundle.json.gz';

export function bundleRefForByteLength(byteLength: number, forceGzip = false): string {
  if (forceGzip || byteLength > BUNDLE_GZIP_THRESHOLD_BYTES) return BUNDLE_GZIP_REF;
  return BUNDLE_JSON_REF;
}

export function encodeBundleFileBytes(jsonBytes: Buffer, bundleRef: string): Buffer {
  return bundleRef.endsWith('.gz') ? gzipSync(jsonBytes) : jsonBytes;
}

export function decodeBundleFileBytes(fileBytes: Buffer, bundleRef: string): Buffer {
  return bundleRef.endsWith('.gz') ? gunzipSync(fileBytes) : fileBytes;
}
