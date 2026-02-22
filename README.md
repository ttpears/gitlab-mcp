# GitLab MCP Server

[![npm version](https://img.shields.io/npm/v/@ttpears/gitlab-mcp-server)](https://www.npmjs.com/package/@ttpears/gitlab-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A community MCP server for GitLab — works with **any GitLab tier** (Free, Premium, Ultimate), no GitLab Duo required.

```bash
npx @ttpears/gitlab-mcp-server
```

## How This Differs from GitLab's Official MCP Server

GitLab ships an [official MCP server](https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/) (Beta) that requires **Premium/Ultimate** and **GitLab Duo** with beta features enabled. This community server is an alternative for teams that don't have those requirements or need different capabilities.

| | This server | GitLab official |
|---|---|---|
| **GitLab tier** | Free, Premium, Ultimate | Premium / Ultimate only |
| **GitLab Duo required** | No | Yes |
| **Auth** | Personal Access Token | OAuth 2.0 Dynamic Client Registration |
| **Transport** | stdio + streamable HTTP | stdio (via `mcp-remote`) + HTTP |
| **Multi-client** | Claude Code, LibreChat, any MCP client | Claude Desktop, Claude Code, Cursor, VS Code |
| **Multi-user auth modes** | hybrid / shared / per-user | OAuth per-user |
| **GraphQL schema discovery** | Yes — introspect & run custom queries | No |
| **Repository browsing & file reading** | Yes | No |
| **User / group search** | Yes | No |
| **Update issues & MRs** | Yes | No (create only) |
| **CI/CD pipeline management** | Yes | Yes |
| **MR diffs & commits** | Yes | Yes |
| **Work item notes** | Yes | Yes |
| **Semantic code search** | No | Yes (requires additional setup) |
| **Label search** | Yes | Yes |
| **Milestone tracking** | Yes | No |
| **Iteration/sprint tracking** | Yes | No |
| **Time tracking & timelogs** | Yes | No |
| **MR reviewer & approval status** | Yes | No |
| **Project statistics dashboard** | Yes | No |
| **Group member listing** | Yes | No |

**Choose this server** if you're on GitLab Free/Community Edition, need GraphQL flexibility, want repo browsing, or run LibreChat multi-user deployments.

**Choose the official server** if you have GitLab Premium/Ultimate with Duo, need semantic code search, or prefer OAuth over PATs.

---

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
| `search_labels` | Search labels in a project or group |
| `list_group_members` | List group members with access levels |
| `browse_repository` | Explore directory structure and files |
| `get_file_content` | Read file contents for code analysis |

### Read Operations
| Tool | Description |
|------|-------------|
| `get_project` | Detailed project information |
| `get_issues` | List project issues with pagination |
| `get_merge_requests` | List project merge requests with pagination |
| `get_merge_request_pipelines` | Get CI/CD pipelines for a merge request |
| `get_pipeline_jobs` | Get jobs for a specific pipeline |
| `get_merge_request_diffs` | Get diff statistics for a merge request |
| `get_merge_request_commits` | Get commits for a merge request |
| `get_notes` | Get notes/comments on an issue or merge request |
| `list_milestones` | List milestones with progress statistics |
| `list_iterations` | List iterations/sprints (Premium/Ultimate) |
| `get_time_tracking` | Get time estimate, spent, and timelogs |
| `get_merge_request_reviewers` | Get MR approval and reviewer status |
| `get_project_statistics` | Aggregate project stats dashboard |
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
| `create_note` | Add a comment/note to an issue or merge request |
| `manage_pipeline` | Retry or cancel a CI/CD pipeline |
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
