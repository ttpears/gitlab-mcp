# GitLab MCP Server — runtime image
# Built from the repo's source. Push: ghcr.io/ttpears/gitlab-mcp.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
RUN apk add --no-cache dumb-init wget
WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

RUN addgroup -g 1001 -S mcpuser && adduser -S mcpuser -u 1001
USER mcpuser

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    GITLAB_MCP_PORT=8008

EXPOSE 8008

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8008/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
