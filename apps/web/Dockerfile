# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY apps/web ./apps/web
COPY tests/fixtures/meetmap/classification.v1.json tests/fixtures/meetmap/venue-selection.ja.jsonl tests/fixtures/meetmap/venue-selection.u16.graph.json ./tests/fixtures/meetmap/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
