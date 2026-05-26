FROM node:20-slim AS base
WORKDIR /app

# Ensure TLS works (OAuth, Google APIs, etc.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-slim AS production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS="--use-openssl-ca"
COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/index.js"]

# Dev stage (used by docker-compose)
FROM base AS development
EXPOSE 3000
CMD ["npx", "tsx", "watch", "src/index.ts"]
