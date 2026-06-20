# fetch-snapshot

Standalone VPS → mock-platform snapshot ingestion tool.

It is intentionally **not** part of the `trading-mock-platform` package. The read-only
mock surface forbids `pg` and exchange/db SDKs in its dependency graph
(`pnpm verify:no-forbidden-deps` scans the repo's `pnpm-lock.yaml`). This tool needs
`pg` + `hyparquet` to read the private VPS Postgres and Parquet files, so it carries its
own isolated dependency tree here and never contributes to the root lockfile.

## Install (isolated — does not touch the root pnpm-lock.yaml)

```sh
cd tools/fetch-snapshot
pnpm install --ignore-workspace
```

`--ignore-workspace` is required so pnpm treats this dir as a standalone project instead
of folding `pg`/`hyparquet` into the workspace root lockfile.

## Run

From the repo root, after installing above:

```sh
pnpm fetch:snapshot -- --help
```

or from inside this dir (the script is named `start` to avoid colliding with
pnpm's built-in `pnpm fetch` command):

```sh
cd tools/fetch-snapshot && pnpm start -- --help
```

See the header comment in `fetch-snapshot.ts` for the full flag reference.
