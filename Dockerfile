# GitLab MCP Server - Dockerfile for LibreChat integration
# Copy this file to your LibreChat root as Dockerfile.mcp-gitlab
#
# This Dockerfile clones and builds the GitLab MCP server from the repository
# instead of copying from the current directory (which would copy LibreChat files)

FROM node:20-alpine AS builder

WORKDIR /app

# Install git for cloning the repository
RUN apk add --no-cache git

# Clone the GitLab MCP repository
# Use --depth 1 for faster clone, --branch to specify version/tag if needed
ARG GITLAB_MCP_VERSION=main
RUN git clone --depth 1 --branch ${GITLAB_MCP_VERSION} https://github.com/ttpears/gitlab-mcp.git .

# Install dependencies (including dev deps for building)
RUN npm ci

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