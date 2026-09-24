# Production Multi-Stage Dockerfile for Ollalink Translate Relay Server
# Minimal, secure, zero-vulnerability Node.js 20 Alpine container

# --- Stage 1: Build & Dependencies ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Stage 2: Production Runtime ---
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

# Security: run as non-root user
USER node

# Copy dependencies and application code
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src/ ./src/

# Expose HTTP & WebSocket port
EXPOSE 8787

# Liveness probe
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8787}/api/health || exit 1

# Start relay server
CMD ["node", "src/bootstrap.js"]
