# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN npm install --global pnpm@11.25.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

ENV NODE_ENV=production
ENV DATABASE_CA_CERT_PATH=/app/packages/database/certs/supabase-root-2021.crt
USER node
# Exec-form Node is PID 1. No pnpm/shell intermediary swallows SIGTERM.
# Worker service overrides CMD with: node --import tsx apps/worker/src/main.ts
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
