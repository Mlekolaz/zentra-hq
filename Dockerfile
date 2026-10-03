# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# Optional corporate CA is used only during installation, never copied into the image.
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm install --global pnpm@11.25.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    pnpm install --prod --frozen-lockfile && pnpm store prune

ENV NODE_ENV=production
USER node
# Exec-form Node is PID 1. No pnpm/shell intermediary swallows SIGTERM.
# Worker service overrides CMD with: node --import tsx apps/worker/src/main.ts
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
