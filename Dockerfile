FROM node:22-slim AS base
# Fetch the pnpm version pinned in package.json's packageManager once, into this layer, so the
# runtime image starts without downloading anything.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @z/web build

FROM base
ENV NODE_ENV=production Z_DATA_DIR=/data PORT=8787 Z_HOST=0.0.0.0
COPY --from=build /app /app
VOLUME /data
EXPOSE 8787
WORKDIR /app/apps/server
# Node directly (not through pnpm) so it is PID 1 and gets SIGTERM from `docker stop`.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/main.ts"]
