FROM node:20-bookworm-slim

# Slide conversion tools; only needed if Phase 6 was built
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress poppler-utils fonts-liberation fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

# better-sqlite3 12 publishes no Node 20 binary, so npm ci compiles it.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# The LiveKit room connection is a native binary. The slim image has no CA store, so that TLS handshake fails after the worker has already registered.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

CMD ["node", "dist/api.js"]
