FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
# --ignore-scripts is safe for the build stage: esbuild (a dev dep) needs no post-install
# script to be usable as a bundler; tsc (the actual build tool) does not need it at all.
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
COPY --from=build /app/dist ./dist
# bake the synthetic fixture for default/demo; real snapshots are mounted at runtime
COPY data/snapshots/fixtures ./data/snapshots/fixtures
ENV MOCK_OPS_BIND=0.0.0.0 MOCK_OPS_PORT=8839
EXPOSE 8839
# NOTE: with a non-loopback bind, MOCK_OPS_TOKENS is REQUIRED (fail-closed) — set it in compose/run.
CMD ["node", "dist/src/bin/start-mock-ops.js"]
