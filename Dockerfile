# The somememos server and web app, for Railway (docs/deploy.md) or any
# container host. Node 22, git for the brains' repositories, the whole
# workspace built, then `node apps/web/build` (SvelteKit's adapter-node).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/build ./apps/web/build
COPY --from=build /app/scripts/docker-start.sh ./scripts/docker-start.sh
# A sync request may carry up to 32 MiB (core's sync.SYNC_LIMITS); adapter-node's default limit is 512K.
ENV NODE_ENV=production \
    PORT=3000 \
    SOMEMEMOS_DATA_DIR=/data \
    BODY_SIZE_LIMIT=34M
EXPOSE 3000
# Starts as root only to hand the mounted volume (owned by root on most hosts)
# to the unprivileged `node` user, then runs the server as that user
# (scripts/docker-start.sh). The app's own files stay owned by root, so the
# server cannot change them.
CMD ["/app/scripts/docker-start.sh"]
