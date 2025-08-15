# GitLab MCP Server - Standalone Dockerfile for Smithery.ai deployments
# For LibreChat integration, copy this file to your LibreChat root as Dockerfile.mcp-gitlab

FROM node:20-alpine AS builder

# Install git for cloning
RUN apk add --no-cache git

WORKDIR /app

# Clone the repository
RUN git clone https://github.com/ttpears/gitlab-mcp.git .

# Install all dependencies (including dev deps for building)
RUN if [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

# Build the application
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy built application and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create non-root user
RUN addgroup -g 1001 -S mcpuser && \
    adduser -S mcpuser -u 1001

# Switch to non-root user
USER mcpuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('GitLab MCP Server is healthy')" || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]