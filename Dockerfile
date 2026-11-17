# Matiz Chat - Multi-stage Docker build
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ sqlite-dev

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache sqlite-libs tini

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy source code
COPY server.js ./
COPY db.js ./
COPY public ./public

# Create data directory for SQLite
RUN mkdir -p data && chown -R nodejs:nodejs data

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/matiz.db

# Use tini for proper signal handling
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]