FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @z/web build

FROM base
ENV NODE_ENV=production Z_DATA_DIR=/data PORT=8787 Z_HOST=0.0.0.0
COPY --from=build /app /app
VOLUME /data
EXPOSE 8787
CMD ["pnpm", "--filter", "@z/server", "start"]
