# Build stage — install dev deps and type check
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

RUN bunx tsc --noEmit && bun test

# Production stage
FROM oven/bun:1-slim AS production

# Declared because unified-cicd passes it as a build-arg; unused (no private deps)
ARG NPM_TOKEN

# curl is required for the sudobility_dockerized healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No runtime dependencies — Bun runs the TypeScript source directly
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
