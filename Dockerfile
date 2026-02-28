FROM node:20-slim AS base

# Install git (needed for update checker) and build essentials (needed for better-sqlite3)
RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

# Production
FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y git curl unzip && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

WORKDIR /app

COPY --from=base /app/.next/standalone ./
COPY --from=base /app/.next/static ./.next/static
COPY --from=base /app/public ./public
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./

# Data directory (mount as volume for persistence)
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3456
ENV HOSTNAME=0.0.0.0

EXPOSE 3456

CMD ["node", "server.js"]
