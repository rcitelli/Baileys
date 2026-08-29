# syntax=docker/dockerfile:1

# ---- Stage 1: build the Baileys library (parent package) with Yarn 4 ----
FROM node:20-bookworm-slim AS baileys-build
WORKDIR /app
RUN corepack enable
# Build toolchain for any native dependency that compiles from source
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock .yarnrc.yml tsconfig.json tsconfig.build.json engine-requirements.js ./
COPY WAProto ./WAProto
COPY src ./src
COPY scripts ./scripts
RUN yarn install --immutable
RUN yarn build

# ---- Stage 2: install the server's own web dependencies with npm ----
FROM node:20-bookworm-slim AS server-deps
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- Stage 3: slim runtime image ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Baileys built output + its runtime node_modules (incl. native deps) resolve via walk-up
COPY --from=baileys-build /app/lib ./lib
COPY --from=baileys-build /app/node_modules ./node_modules
COPY --from=baileys-build /app/WAProto ./WAProto
COPY --from=baileys-build /app/package.json ./package.json

# Server code + its dependencies (express, tsx, qrcode, jose, ...)
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/tsconfig.json ./server/
COPY server/src ./server/src

WORKDIR /app/server
ENV DATA_DIR=/app/server/data
EXPOSE 3000
VOLUME ["/app/server/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
