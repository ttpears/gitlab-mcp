# GitLab MCP Server

[![npm version](https://img.shields.io/npm/v/@ttpears/gitlab-mcp-server)](https://www.npmjs.com/package/@ttpears/gitlab-mcp-server)
[![CI](https://github.com/ttpears/gitlab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ttpears/gitlab-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A community [Model Context Protocol](https://modelcontextprotocol.io/) server that lets AI clients search GitLab, read repositories, review merge requests, manage issues, and summarize team activity. Supports GitLab.com and self-managed GitLab through **stdio** and **Streamable HTTP**.

This project is independent of GitLab Inc. It does not require GitLab Duo. Individual tools remain subject to your GitLab version, tier, enabled features, token scopes, and role.

## Start locally

Requires **Node.js 22 or later**. CI covers Node.js 22 and 24; the container uses Node.js 24.

1. Create a GitLab personal access token with `read_api` for reads or `api` for reads and writes. The token can only access resources its owner is allowed to use.
2. Add this server to your client's MCP configuration. Replace the token locally; keep the resulting file out of version control.

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@ttpears/gitlab-mcp-server@4.0.0"],
      "env": {
        "GITLAB_URL": "https://gitlab.com",
        "GITLAB_READ_TOKEN": "glpat-replace-locally"
      }
    }
  }
}
```

3. Restart or reconnect the client. Ask it to call `get_current_user`, then `search_projects` with `{"searchTerm":"your-project","first":5}`.

For writes, **replace** `GITLAB_READ_TOKEN` with `GITLAB_TOKEN` and use an `api`-scoped token. Setting both variables is a startup error. Stdio is the default; it communicates over stdin/stdout and does not open a listening port.

## Choose a setup

| Use case | Setup |
| --- | --- |
| Claude Code, Claude Desktop, VS Code, or another local client | [Client installation](docs/installation.md) |
| Claude Desktop bundle | Download `gitlab-mcp-community-4.0.0.mcpb` from the [4.0.0 release](https://github.com/ttpears/gitlab-mcp/releases/tag/v4.0.0) |
| LibreChat with each user's PAT | [LibreChat guide](docs/installation.md#librechat) and [YAML example](librechat.example.yml) |
| Shared remote server with GitLab sign-in | [OAuth setup](docs/authentication.md#oauth-for-remote-users) |
| Docker or a reverse proxy | [Deployment and operations](docs/deployment.md) |
| Existing installation | [Upgrade to 4.0](docs/upgrading.md) |

For a local HTTP smoke test without a shared token:

```bash
docker run --rm --name gitlab-mcp \
  -p 127.0.0.1:8008:8008 \
  -e GITLAB_URL=https://gitlab.com \
  ghcr.io/ttpears/gitlab-mcp:4.0.0
```

Connect an MCP client to `http://localhost:8008/` and send `Authorization: Bearer <your-GitLab-PAT>` on every request. `curl http://localhost:8008/health` checks liveness. The published image currently targets Linux **amd64**. Configure HTTPS and user authentication before remote use; see the deployment guide.

## What you can do

The server exposes **69 tools** and **8 workflow prompts**. The [tool reference](docs/reference/tools.md) lists every tool, its input parameters, defaults, and write classification.

| Task | Start with |
| --- | --- |
| Find projects, groups, users, issues, or merge requests | `search_projects`, `search_groups`, `search_users`, `search_issues`, `search_merge_requests` |
| Identify a path and inspect code | `resolve_path`, `browse_repository`, `get_file_content` |
| Review a change and its CI results | `get_merge_request_context`, `get_merge_request_diffs`, `get_merge_request_pipelines`, `get_pipeline_jobs` |
| Triage and update work | `get_issue_context`, `create_issue`, `update_issue`, `create_note`, `update_merge_request` |
| Work with planning and notifications | `list_milestones`, `list_iterations`, `list_work_items`, `list_my_todos` |
| Summarize activity and review delays | `analytics_user_summary`, `analytics_group_summary`, `analytics_review_bottlenecks` |
| Manage group achievements | `list_achievements`, `create_achievement`, `award_achievement` |
| Discover instance-specific API capabilities | `get_available_queries`, `get_type_fields` |

Try: “Find open bugs assigned to me,” “Review MR !42 in group/project,” or “Summarize this group's activity since Monday.” See [workflows and pagination](docs/usage.md) for exact tool-call examples and prompt names.

## Read before sharing a server

- `GITLAB_TOKEN` is a fallback for **reads and writes**. `GITLAB_READ_TOKEN` is a fallback for **reads only**. A shared fallback exposes that account's accessible data to callers using it.
- With neither fallback set, each operation needs user credentials through an HTTP PAT, OAuth, or `userCredentials`.
- Host pinning, finite resource limits, and restrictions on custom GraphQL/REST tools are enabled by default. Tool annotations are client hints; GitLab permissions and the server's credential checks enforce access.
- `fetchAll: true` fetches up to `first` items. For complete results, keep following each connection's `pageInfo.endCursor` while `hasNextPage` is true.

See [authentication and security](docs/authentication.md) for credential precedence, OAuth consent, encrypted Redis storage, and access boundaries.

## Documentation

- [Installation and client configuration](docs/installation.md)
- [Authentication and security](docs/authentication.md)
- [Deployment and operations](docs/deployment.md)
- [Workflows, results, and pagination](docs/usage.md)
- [Environment variable reference](docs/configuration.md)
- [Complete tool reference](docs/reference/tools.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Upgrading to 4.0](docs/upgrading.md)
- [Contributing and architecture](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md) · [Releases](https://github.com/ttpears/gitlab-mcp/releases) · [Issue tracker](https://github.com/ttpears/gitlab-mcp/issues)

Field notes: [Two session bugs that broke my GitLab MCP server](https://hackyourworld.com/gitlab-mcp-session-bugs-restart-404/).

Licensed under [MIT](LICENSE).
