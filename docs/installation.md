# Installation and clients

[Documentation home](../README.md) · [Authentication](authentication.md) · [Troubleshooting](troubleshooting.md)

## Requirements

- npm installations: Node.js 22 or later and npm. CI tests Node.js 22 and 24.
- Docker: a Linux amd64 runtime, or an environment capable of emulating it.
- Access to GitLab and a token with `read_api` or `api`, or a server configured for [OAuth sign-in](authentication.md#oauth-for-remote-users).
- An MCP client supporting stdio or Streamable HTTP. Client support for OAuth, prompts, and structured results varies.

Use the scoped package **`@ttpears/gitlab-mcp-server`**. Its installed executable is `gitlab-mcp-server` (also available as `gitlab-mcp`).

## Claude Code

Set a token in the shell that launches Claude Code. For read-only access:

```bash
export GITLAB_URL=https://gitlab.com
read -r -s -p 'GitLab read_api token: ' GITLAB_READ_TOKEN
export GITLAB_READ_TOKEN
claude mcp add --transport stdio gitlab -- npx -y @ttpears/gitlab-mcp-server@4.0.0
```

The `read` command uses Bash and avoids placing the token itself in shell history. Start Claude Code from that shell so its child process inherits the environment. Do not have `GITLAB_TOKEN` set at the same time. Reconnect after changing credentials.

For project-scoped configuration, place the `mcpServers` object from the [README quick start](../README.md#start-locally) in `.mcp.json`. Prefer your client's environment/secret substitution mechanism over committing a literal token. Client substitution syntax varies; the server itself does not expand `${VARIABLE}` strings inside JSON.

## Claude Desktop

### Desktop extension bundle

Download `gitlab-mcp-community-4.0.0.mcpb` from the [4.0.0 release](https://github.com/ttpears/gitlab-mcp/releases/tag/v4.0.0) and install it through Claude Desktop's extension interface. Enter your GitLab base URL and PAT when prompted. The bundle marks the token as sensitive for the client's secure storage.

The bundle passes the PAT as `GITLAB_TOKEN`; an upstream `read_api` token still cannot write. To enforce the server's separate read-only fallback policy, use manual configuration with `GITLAB_READ_TOKEN`.

### Manual configuration

Merge [claude_desktop_config.example.json](../claude_desktop_config.example.json) into your configuration and replace the placeholder locally. Common paths:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Restart Claude Desktop after editing. If it cannot find `npx`, use its absolute executable path or install Node.js so the desktop application can find it.

## VS Code

VS Code uses a `servers` object in `.vscode/mcp.json`, rather than Claude's `mcpServers` object. This example prompts for the PAT:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "gitlab-pat",
      "description": "GitLab read_api token",
      "password": true
    }
  ],
  "servers": {
    "gitlab": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ttpears/gitlab-mcp-server@4.0.0"],
      "env": {
        "GITLAB_URL": "https://gitlab.com",
        "GITLAB_READ_TOKEN": "${input:gitlab-pat}"
      }
    }
  }
}
```

## Other local clients and Inspector

Use [mcp.json](../mcp.json) as a generic stdio configuration. It is a client configuration example, not a package registry manifest. [.clauderc.example](../.clauderc.example) contains the same definition for clients expecting that filename; use the actual path required by your client.

To avoid downloading the package at each cold start:

```bash
npm install -g @ttpears/gitlab-mcp-server@4.0.0
```

Then use `"command": "gitlab-mcp-server"` with no arguments. Environment settings stay the same.

To inspect the server interactively, export the GitLab environment settings first, then run:

```bash
npx @modelcontextprotocol/inspector npx -y @ttpears/gitlab-mcp-server@4.0.0
```

The [Inspector configuration example](../mcp-inspector.example.json) also works with Inspector's `--config` and `--server gitlab` options. Inspector opens its own local UI; the MCP server continues to use stdio.

## LibreChat

Use **Streamable HTTP** at `http://gitlab-mcp:8008/` when both applications share a Docker network. `/mcp` is equivalent. `/sse` is not a supported legacy SSE endpoint.

1. Add [docker-compose.override.yml](../docker-compose.override.yml) alongside LibreChat's Compose file. It assumes an existing `librechat` network; adapt it to your deployment.
2. Set `GITLAB_URL` in the `.env` file used by `env_file`. For strict per-user access, leave both fallback tokens unset. For service-account reads, set only `GITLAB_READ_TOKEN` and ensure all LibreChat users may see that account's data.
3. Merge [librechat.example.yml](../librechat.example.yml) into the `mcpServers` section of the configuration mounted by your deployment (often `librechat.yaml`). Its `customUserVars` collects a PAT and its `headers` forwards it on **every** request. Both are necessary.
4. Apply Compose and restart LibreChat's API service so it reloads its YAML:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d gitlab-mcp
docker compose -f docker-compose.yml -f docker-compose.override.yml restart api
```

The example requires a PAT. To allow token-free reads through a service account, make `GITLAB_PAT.required` false and configure `GITLAB_READ_TOKEN` on the server. Writes still need a user PAT.

For remote LibreChat, use an HTTPS URL reachable by its backend. `localhost` inside a container refers to that container. See [deployment](deployment.md) for networking and proxies. For OAuth-capable clients, use [GitLab sign-in](authentication.md#oauth-for-remote-users) instead of the PAT header example.

## Confirm the installation

1. Verify the client lists the server's tools.
2. Call `get_current_user` with `{}` and confirm the expected identity.
3. Call `search_projects` with `{"searchTerm":"known-project","first":5}`.
4. For HTTP, verify initialization and subsequent requests carry the same bearer credential.

`/health` alone does not validate GitLab access, scopes, Redis readiness, or any tool. See [troubleshooting](troubleshooting.md) if the connection succeeds but tool calls fail.
