import { gzipSync, gunzipSync } from 'node:zlib';

/** GitHub file limit is 100 MB; gzip large VPS bundles instead of symbol-trimming. */
export const BUNDLE_GZIP_THRESHOLD_BYTES = 90 * 1024 * 1024;

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
