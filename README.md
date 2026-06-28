# GitLab MCP Server

[![npm version](https://img.shields.io/npm/v/@ttpears/gitlab-mcp-server)](https://www.npmjs.com/package/@ttpears/gitlab-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@ttpears/gitlab-mcp-server)](https://www.npmjs.com/package/@ttpears/gitlab-mcp-server)
[![CI](https://github.com/ttpears/gitlab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ttpears/gitlab-mcp/actions/workflows/ci.yml)
[![Container](https://img.shields.io/badge/ghcr.io-ttpears%2Fgitlab--mcp-2496ED?logo=docker&logoColor=white)](https://github.com/ttpears/gitlab-mcp/pkgs/container/gitlab-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<img src="assets/logo.svg" width="80" align="right" alt="gitlab-mcp"/>

A community MCP server for GitLab — works with **any GitLab tier** (Free, Premium, Ultimate), no GitLab Duo required. PAT-based auth. Streamable HTTP and stdio transports.

```bash
npx @ttpears/gitlab-mcp-server
```

---

## Choose your deployment

| You're running | Go to |
|---|---|
| Claude Code or another IDE/AI tool, just for you | [Solo IDE](#solo-ide) |
| LibreChat for a team with a service-account read token | [LibreChat — service-account reads](#librechat--service-account-reads) |
| LibreChat where every operation should use the calling user's token | [LibreChat — strict per-user](#librechat--strict-per-user) |

---

## Solo IDE

### Claude Code (recommended)

```bash
claude mcp add gitlab \
  --env GITLAB_URL=https://gitlab.com \
  --env GITLAB_TOKEN=glpat-your-pat \
  -- npx -y @ttpears/gitlab-mcp-server
```

`--scope` controls where the configuration lives:

- `--scope local` (default) — only this user, only this project
- `--scope user` — shared across all of your projects
- `--scope project` — written to `.mcp.json` in the project root, intended for team check-in

For team check-in, use a `${VAR}` placeholder so the PAT itself stays out of git:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@ttpears/gitlab-mcp-server"],
      "env": {
        "GITLAB_URL": "https://gitlab.com",
        "GITLAB_TOKEN": "${GITLAB_TOKEN}"
      }
    }
  }
}
```

Each contributor exports `GITLAB_TOKEN` in their shell; Claude Code expands it on launch.

### Cold start

If launching via `npx` adds noticeable latency, install once:

```bash
npm install -g @ttpears/gitlab-mcp-server
```

…and replace `npx -y @ttpears/gitlab-mcp-server` with `gitlab-mcp-server` in your config.

### Claude Desktop

**Option A — MCPB one-click install:** download
`gitlab-mcp-community-${VERSION}.mcpb` from the
[latest GitHub Release](https://github.com/ttpears/gitlab-mcp/releases/latest)
and drag it onto the Claude Desktop window. Fill in your GitLab URL and a
Personal Access Token when prompted; the token is stored in your OS keychain.
Use a `read_api`-scoped PAT for read-only access, or an `api`-scoped PAT to
also allow writes (create_issue, create_merge_request, etc.).

**Option B — manual config:** add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@ttpears/gitlab-mcp-server"],
      "env": {
        "GITLAB_URL": "https://gitlab.com",
        "GITLAB_TOKEN": "glpat-your-pat"
      }
    }
  }
}
```

---

## LibreChat — service-account reads

A read-only service token covers reads (so anyone in the workspace can ask
questions). Each user supplies their own PAT for writes through LibreChat's
`customUserVars`.

LibreChat's documented extension point is `docker-compose.override.yml` — the
fragments below assume you're adding `gitlab-mcp` there alongside LibreChat's
own `api`, `mongodb`, etc.

### `.env`

```env
GITLAB_URL=https://gitlab.example.com
GITLAB_READ_TOKEN=glpat-readonly-service-token   # read_api scope only
```

Use `https://gitlab.com` for SaaS GitLab; use your own host for self-hosted.

### `docker-compose.override.yml`

```yaml
services:
  gitlab-mcp:
    image: ghcr.io/ttpears/gitlab-mcp:1.14.0
    env_file:
      - .env
    networks:
      - librechat
    restart: unless-stopped
```

`env_file` reads `GITLAB_URL` and `GITLAB_READ_TOKEN` from `.env`. No port
mapping needed — LibreChat's `api` container reaches `gitlab-mcp` over the
shared `librechat` network. Add `ports: ["8008:8008"]` only if you need to
hit it from the host (e.g. for `curl http://localhost:8008/health`).

Then:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d gitlab-mcp api
```

`api` is restarted alongside so it re-reads `librechat.yaml`.

### `librechat.yaml`

```yaml
mcpServers:
  gitlab:
    type: streamable-http
    url: http://gitlab-mcp:8008/
    startup: false                # don't connect until the user supplies their PAT
    initTimeout: 30000
    timeout: 120000
    headers:
      Authorization: "Bearer {{GITLAB_PAT}}"
      X-GitLab-Url: "{{GITLAB_URL_OVERRIDE}}"   # only honored when GITLAB_PIN_HOST=false (default pins to GITLAB_URL)
    customUserVars:
      GITLAB_PAT:
        title: "GitLab Personal Access Token"
        description: "Your GitLab PAT with api scope. Used for issues, MRs, and comments you create or edit."
      GITLAB_URL_OVERRIDE:
        title: "GitLab URL (optional)"
        description: "Leave blank to use the workspace default. Override only if your account is on a different GitLab instance."
```

`initTimeout` / `timeout` are forgiving defaults for slower internal networks
and large schemas — drop them if SaaS GitLab feels snappy.

> Server-side env vars use `${VAR}`. Per-user vars use `{{VAR}}`. They are not interchangeable.

---

## LibreChat — strict per-user

Every call must carry a user PAT. No service-account fallback. Reads as well
as writes are gated on the user's token.

### Add MCP Server (UI path — recommended)

1. Host gitlab-mcp somewhere LibreChat can reach. For a quick standalone host:

   ```bash
   docker run -d --restart unless-stopped \
     -p 8008:8008 \
     -e GITLAB_URL=https://gitlab.example.com \
     --name gitlab-mcp \
     ghcr.io/ttpears/gitlab-mcp:1.14.0
   ```

   Or, when running alongside LibreChat in the same compose project, drop it
   into `docker-compose.override.yml` (no token env vars):

   ```yaml
   services:
     gitlab-mcp:
       image: ghcr.io/ttpears/gitlab-mcp:1.14.0
       environment:
         GITLAB_URL: https://gitlab.example.com
       networks:
         - librechat
       restart: unless-stopped
   ```

2. In LibreChat → **MCP Servers** → **Add MCP Server**:
   - **URL:** `https://your-host/` (or `http://gitlab-mcp:8008/` if same network)
   - **Authentication:** API Key → check **User provides key** → header format **Bearer**
   - **Save**

3. Each user fills in their PAT through the MCP Tool Select Dialog when configuring an agent.

### `librechat.yaml` equivalent

```yaml
mcpServers:
  gitlab:
    type: streamable-http
    url: http://gitlab-mcp:8008/
    startup: false
    initTimeout: 30000
    timeout: 120000
    headers:
      Authorization: "Bearer {{GITLAB_PAT}}"
    customUserVars:
      GITLAB_PAT:
        title: "GitLab Personal Access Token"
        description: "Your GitLab PAT with api scope."
```

The container needs no env-configured token at all in this mode — every
request is rejected unless `Authorization: Bearer …` is present.

---

## Hosting for a remote LibreChat

The server speaks plain HTTP. For LibreChat-as-a-service or any cross-network
deployment, terminate TLS at a reverse proxy. Common patterns:

- **Caddy** — auto-TLS via Let's Encrypt:

  ```caddyfile
  mcp.example.com {
    reverse_proxy gitlab-mcp:8008
  }
  ```

- **Traefik** — Docker labels on the `gitlab-mcp` service.
- **Cloudflare Tunnel** — no public IP needed; expose `gitlab-mcp:8008` through the tunnel.

The `Authorization` and `Mcp-Session-Id` headers must pass through unchanged. Most defaults handle this fine.

---

## OAuth for remote users

For a publicly hosted instance where each user signs in with **their own GitLab
identity** — and modern MCP clients (Claude.ai, Claude Code) connect with **no
manual token setup** — enable brokered OAuth 2.1. The server then acts as its own
OAuth Authorization Server in front of GitLab:

- advertises Protected Resource Metadata (RFC 9728) and Authorization Server
  Metadata (RFC 8414) at the standard `.well-known` endpoints,
- supports Dynamic Client Registration (RFC 7591), so clients self-register,
- runs authorization-code + PKCE against both the MCP client **and** GitLab
  (dual-PKCE) behind **one** fixed GitLab callback,
- gates the MCP endpoints with bearer validation — unauthenticated requests get
  `401` + `WWW-Authenticate` pointing at the resource metadata (the discovery trigger),
- mints its own opaque tokens and keeps each user's GitLab token server-side
  (no token passthrough).

**Setup**

1. Register **one** GitLab application (instance/group/user → **Applications**):
   - Redirect URI: `https://<your-host>/gitlab/callback`
   - Scopes: `api` (read + write) or `read_api`
   - Confidential: yes (recommended) → you get a client secret; or mark it public for PKCE-only.
2. Run the server (HTTP mode) with **no** `GITLAB_TOKEN` — identity comes from each user's OAuth login:

   ```bash
   MCP_TRANSPORT=http GITLAB_MCP_PORT=8008 \
   GITLAB_URL=https://gitlab.example.com \
   GITLAB_MCP_OAUTH=true \
   MCP_SERVER_URL=https://gitlab-mcp.example.com \
   GITLAB_OAUTH_CLIENT_ID=<application id> \
   GITLAB_OAUTH_CLIENT_SECRET=<application secret> \
   GITLAB_OAUTH_SCOPES=api \
   npx -y @ttpears/gitlab-mcp-server
   ```

3. Point an MCP client at `https://gitlab-mcp.example.com/` — it discovers the
   metadata, registers, and walks the user through GitLab sign-in automatically.

`MCP_SERVER_URL` must be HTTPS (terminate TLS at your reverse proxy) and must
match the host the GitLab redirect URI is registered under. Token/registration
state is in-memory, so run a single instance (or add a shared store) per issuer.

---

## How this differs from GitLab's official MCP server

GitLab ships an [official MCP server](https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/) (Beta) that requires **Premium/Ultimate** and **GitLab Duo**.

| | This server | GitLab official |
|---|---|---|
| **GitLab tier** | Free, Premium, Ultimate | Premium / Ultimate only |
| **GitLab Duo required** | No | Yes |
| **Auth** | PAT, or brokered OAuth 2.1 + Dynamic Client Registration | OAuth 2.0 Dynamic Client Registration |
| **Transport** | stdio + streamable HTTP | stdio + HTTP |
| **Multi-user** | Per-call PAT, OAuth per-user, or service-account fallback | OAuth per-user |
| **GraphQL schema discovery** | Yes — introspect & run custom queries | No |
| **Repository browsing & file reading** | Yes | No |
| **Update issues / MRs / notes** | Yes | No (create only) |
| **Delete issues / notes** | Yes | No |
| **CI/CD pipeline management** | Yes | Yes |
| **MR diffs & commits** | Yes | Yes |
| **Time tracking & timelogs** | Yes | No |
| **MR reviewer & approval status** | Yes | No |
| **Iteration / milestone tracking** | Yes | No |
| **Project statistics dashboard** | Yes | No |
| **Group member listing** | Yes | No |
| **Semantic code search** | No | Yes (requires additional setup) |

**Choose this server** for Free/CE, GraphQL flexibility, LibreChat multi-user,
or brokered OAuth without GitLab Duo. **Choose the official server** for
Premium+Duo with semantic code search.

---

## Tools

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
| `get_work_item` | Fetch a work item (issue, task, epic, incident, OKR) by ID with full widget data |
| `list_work_items` | List work items in a group or project, filtered by type and state |
| `list_broadcast_messages` | List instance-wide broadcast messages |
| `get_broadcast_message` | Get a specific broadcast message by ID |
| `list_my_todos` | Authenticated user's to-do inbox — notifications about issues, MRs, mentions, reviews requested |
| `list_my_events` | Authenticated user's activity feed — pushes, MRs, comments, approvals |
| `list_user_events` | Another user's public activity feed by username or ID |
| `list_project_events` | Activity events for a specific project |
| `resolve_path` | Resolve a path to a project or group |
| `get_available_queries` | Discover available GraphQL operations |
| `execute_custom_query` | Run custom GraphQL queries |

### Write Operations (require user authentication)
| Tool | Description |
|------|-------------|
| `create_issue` | Create new issues |
| `create_merge_request` | Create new merge requests |
| `create_note` | Add a comment/note to an issue or merge request |
| `update_issue` | Update title, description, assignees, labels, due date |
| `update_merge_request` | Update title, description, assignees, reviewers, labels |
| `update_note` | Edit the body of an existing comment |
| `delete_issue` | Delete an issue (issue author or maintainer required) |
| `delete_note` | Delete a comment (note author or maintainer required) |
| `manage_pipeline` | Retry or cancel a CI/CD pipeline |
| `create_broadcast_message` | Create a broadcast message (instance admin) |
| `update_broadcast_message` | Update a broadcast message (instance admin) |
| `delete_broadcast_message` | Delete a broadcast message (instance admin) |
| `mark_todo_done` | Mark a single to-do item as done |
| `mark_all_todos_done` | Mark all pending to-do items as done for the authenticated user |
| `restore_todo` | Restore a previously-done to-do item back to pending |

---

## Configuration

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `GITLAB_URL` | GitLab instance URL | `https://gitlab.com` |
| `GITLAB_TOKEN` | Full-access fallback token (reads + writes) | — |
| `GITLAB_READ_TOKEN` | Read-only fallback token (writes always rejected) | — |
| `GITLAB_PIN_HOST` | Force every request to `GITLAB_URL`, ignoring per-call/header `gitlabUrl` (SSRF guard). Set `false` to serve multiple instances | `true` |
| `GITLAB_ALLOW_SHARED_ESCAPE_HATCH` | Allow `execute_custom_query` / `execute_rest_read` / `execute_rest_write` to run on the shared token (otherwise they require per-call credentials) | `false` |
| `GITLAB_MAX_PAGE_SIZE` | Maximum items per page (1–100) | `50` |
| `GITLAB_TIMEOUT` | Request timeout in milliseconds | `30000` |
| `GITLAB_MCP_PORT` | HTTP server port | `8008` |
| `MCP_TRANSPORT` | Transport mode (`http` for LibreChat) | `stdio` |
| `TRUST_PROXY` | Express `trust proxy` when behind a reverse proxy (hop count like `1`, boolean, or IP/subnet list). Needed for correct per-IP OAuth rate limiting behind traefik/nginx | unset |
| `GITLAB_MCP_OAUTH` | Enable brokered OAuth 2.1 (HTTP mode) — see [OAuth for remote users](#oauth-for-remote-users) | `false` |
| `MCP_SERVER_URL` | Public HTTPS URL of this server (OAuth issuer/resource id) — required when OAuth is on | — |
| `GITLAB_OAUTH_CLIENT_ID` | GitLab application id — required when OAuth is on | — |
| `GITLAB_OAUTH_CLIENT_SECRET` | GitLab application secret (omit for a public/PKCE-only app) | — |
| `GITLAB_OAUTH_SCOPES` | Space-separated GitLab scopes to request | `api` |
| `GITLAB_OAUTH_CALLBACK_PATH` | Path of the fixed GitLab redirect URI | `/gitlab/callback` |
| `GITLAB_OAUTH_ALLOWED_GROUPS` | Restrict the connector to members of these GitLab groups (comma/space separated full-paths; subgroups included). Empty = any authenticated user | unset |
| `REDIS_URL` | Back OAuth broker state with Redis (survives redeploys, enables >1 replica). Unset = in-memory | unset |
| `REDIS_KEY_PREFIX` | Base namespace for Redis keys (issuer host is appended) | `gitlab-mcp` |

`GITLAB_TOKEN` and `GITLAB_READ_TOKEN` are **mutually exclusive**; setting both is a startup error.

### Removed in 1.14.0

- `GITLAB_AUTH_MODE` — the three-way enum is gone. Pick your deployment shape by which env var you set; see [Choose your deployment](#choose-your-deployment).
- `GITLAB_SHARED_ACCESS_TOKEN` — rename to `GITLAB_TOKEN` (full access) or `GITLAB_READ_TOKEN` (read-only).

Old env vars trigger a deprecation warning at startup and are otherwise ignored.

---

## Troubleshooting

**"This operation requires authentication" / "Write operation requires a user token":**
- For LibreChat: check the user filled in their PAT in the MCP Tool Select Dialog (or in their `customUserVars`).
- For Claude Code: confirm `GITLAB_TOKEN` is set in the MCP server's `env` block.
- If you set `GITLAB_READ_TOKEN`, write operations against it are rejected by design — supply per-call user creds for writes.

**Connection issues with LibreChat:**
- `type: streamable-http` (not `sse`).
- URL is the Docker service name (`http://gitlab-mcp:8008/`), not localhost, when LibreChat and gitlab-mcp share a Docker network.
- `docker logs gitlab-mcp` shows session init and request lines.

**Schema introspection failed:**
- GitLab 12.0+ with GraphQL API enabled.
- Verify `GITLAB_URL` is reachable from the container.

**Debug logging:**

```bash
NODE_ENV=development GITLAB_TOKEN=glpat-... npm start
```

**Health check (HTTP mode):**

```bash
curl http://localhost:8008/health
```

---

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md). Releases before 1.14.0 are in
[GitHub releases](https://github.com/ttpears/gitlab-mcp/releases).

## License

[MIT](./LICENSE)
