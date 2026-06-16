/** All contract/version coordinates a snapshot is bound to. Validated at startup (fail-closed). */
export interface SnapshotVersions {
  readonly snapshotSchemaVersion: string;
  readonly opsReadContractVersion: string;
  readonly researchReadContractVersion: string;
  readonly analysisContractVersion: string;
  readonly exporterVersion: string;
  readonly sourcePlatformCommit: string;
  readonly redactionPolicyVersion: string;
}
export interface SnapshotManifest {
  readonly ref: string;
  readonly createdAtMs: number;
  readonly versions: SnapshotVersions;
  readonly bundleRef: string;       // relative path to bundle.json
  readonly checksumsRef: string;    // relative path to checksums.json
}
