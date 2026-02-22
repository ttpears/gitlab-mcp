# GitLab MCP Server

[![npm version](https://img.shields.io/npm/v/@ttpears/gitlab-mcp-server)](https://www.npmjs.com/package/@ttpears/gitlab-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Model Context Protocol (MCP) server for GitLab with GraphQL schema discovery, self-hosted instance support, and multi-client compatibility.

```bash
npx @ttpears/gitlab-mcp-server
```

## Quick Start

### 1. Create a GitLab Token

Go to GitLab → **User Settings** → **Access Tokens** → create a token with `read_api` (read-only) or `api` (full access) scope.

### 2. Choose Your Client

- [Claude Code](#claude-code) — stdio transport, single-user
- [LibreChat (Docker)](#librechat-docker) — streamable HTTP, multi-user with per-user auth

---

## Claude Code

Add to your Claude Code settings (`.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@ttpears/gitlab-mcp-server"],
      "env": {
        "GITLAB_URL": "https://gitlab.com",
        "GITLAB_SHARED_ACCESS_TOKEN": "glpat-your-token-here"
      }
    }
  }
}
```

Restart Claude Code to load the server.

---

## LibreChat (Docker)

Runs as a sidecar container using [streamable HTTP transport](https://www.librechat.ai/docs/features/mcp) for multi-user deployments with per-user credential isolation.

### 1. Add environment variables to your LibreChat `.env`:

```bash
GITLAB_URL=https://gitlab.com
GITLAB_AUTH_MODE=hybrid
GITLAB_SHARED_ACCESS_TOKEN=glpat-your-shared-token
GITLAB_MCP_PORT=8008
MCP_TRANSPORT=http
```

### 2. Add the service to `docker-compose.override.yml`:

```yaml
services:
  gitlab-mcp:
    build:
      context: .
      dockerfile: Dockerfile.mcp-gitlab
    env_file:
      - .env
    ports:
      - "8008:8008"
    networks:
      - librechat
    restart: unless-stopped
```

Copy the Dockerfile from this repo into your LibreChat directory as `Dockerfile.mcp-gitlab`. It clones and builds from this repository automatically — no source files needed.

### 3. Configure in `librechat.yml`:

```yaml
mcpServers:
  gitlab:
    type: streamable-http
    url: "http://gitlab-mcp:8008/"
    headers:
      Authorization: "Bearer {{GITLAB_PAT}}"
      X-GitLab-Url: "{{GITLAB_URL_OVERRIDE}}"
    customUserVars:
      GITLAB_PAT:
        title: "GitLab Personal Access Token"
        description: "PAT with api scope"
      GITLAB_URL_OVERRIDE:
        title: "GitLab URL (optional)"
        description: "e.g., https://gitlab.yourdomain.com"
```

### 4. Restart LibreChat:

```bash
docker compose down && docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

---

## Available Tools

### Search & Discovery
| Tool | Description |
|------|-------------|
| `search_gitlab` | Global search across projects, issues, and merge requests |
| `search_projects` | Find repositories by name or description |
| `search_issues` | Search issues globally or within a project (filter by assignee, author, labels, state) |
| `search_merge_requests` | Find merge requests by username or within a project |
| `search_users` | Find team members and contributors |
| `search_groups` | Discover groups and organizations |
| `browse_repository` | Explore directory structure and files |
| `get_file_content` | Read file contents for code analysis |

### Read Operations
| Tool | Description |
|------|-------------|
| `get_project` | Detailed project information |
| `get_issues` | List project issues with pagination |
| `get_merge_requests` | List project merge requests with pagination |
| `get_user_issues` | Get all issues assigned to a user |
| `get_user_merge_requests` | Get MRs authored by or assigned to a user |
| `resolve_path` | Resolve a path to a project or group |
| `get_available_queries` | Discover available GraphQL operations |
| `execute_custom_query` | Run custom GraphQL queries |

### Write Operations (requires user authentication)
| Tool | Description |
|------|-------------|
| `create_issue` | Create new issues |
| `create_merge_request` | Create new merge requests |
| `update_issue` | Update title, description, assignees, labels, due date |
| `update_merge_request` | Update title, description, assignees, reviewers, labels |

---

## Configuration

### Authentication Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **hybrid** (default) | Shared token for reads + per-user tokens for writes | Multi-user deployments |
| **shared** | Single token for all operations | Single-user / trusted environments |
| **per-user** | All operations require user authentication | High-security environments |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GITLAB_URL` | GitLab instance URL | `https://gitlab.com` |
| `GITLAB_AUTH_MODE` | Authentication mode (`hybrid`, `shared`, `per-user`) | `hybrid` |
| `GITLAB_SHARED_ACCESS_TOKEN` | Shared token for read operations | — |
| `GITLAB_MAX_PAGE_SIZE` | Maximum items per page (1-100) | `50` |
| `GITLAB_TIMEOUT` | Request timeout in milliseconds | `30000` |
| `GITLAB_MCP_PORT` | HTTP server port (LibreChat mode) | `8008` |
| `MCP_TRANSPORT` | Transport mode (`http` for LibreChat) | stdio |

---

## Troubleshooting

**Connection issues with LibreChat:**
- Verify `type: streamable-http` in `librechat.yml` (not `sse`)
- URL should be `http://gitlab-mcp:8008/` (the Docker service name, not localhost)
- Ensure both containers share the same Docker network
- Check logs: `docker logs gitlab-mcp`

**Authentication errors:**
- Verify token has `read_api` or `api` scope and hasn't expired
- For LibreChat: check the user provided a valid PAT in the credentials UI

**Schema introspection failed:**
- Requires GitLab 12.0+ with GraphQL API enabled
- Verify `GITLAB_URL` is reachable from the container

**Debug logging:**
```bash
NODE_ENV=development GITLAB_URL=https://your-gitlab.com npm start
```

**Health check (HTTP mode):**
```bash
curl http://localhost:8008/health
```

---

## Testing

```bash
# Test with MCP Inspector
npx @modelcontextprotocol/inspector npx @ttpears/gitlab-mcp-server
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## License

MIT
