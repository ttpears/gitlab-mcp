# Troubleshooting

[Documentation home](../README.md) · [Configuration](configuration.md) · [Operations](deployment.md)

## Installation and startup

| Symptom | Check and action |
| --- | --- |
| Package or command not found | The npm package is `@ttpears/gitlab-mcp-server`; the installed command is `gitlab-mcp-server`. Check Node.js 22+ and the client's executable search path |
| Server waits silently or HTTP port never opens | Stdio is the default. Set both `MCP_TRANSPORT=http` and `GITLAB_MCP_PORT=8008`. `PORT` is ignored |
| `.env` changes have no effect | The server does not load dotenv. Inject variables with Compose `env_file`, Docker `--env-file`, or a process manager, then restart |
| Startup reports mutually exclusive tokens | Remove either `GITLAB_TOKEN` or `GITLAB_READ_TOKEN` |
| Removed-variable warnings | Delete `GITLAB_AUTH_MODE` and `GITLAB_SHARED_ACCESS_TOKEN`; choose a supported fallback |
| GraphQL introspection warns at startup | Check network, GitLab URL, PAT and scopes. The server can start and try introspection later with user credentials; this warning is not proof the client transport failed |
| Container cannot reach GitLab | Check container DNS, outbound HTTPS, and certificate trust. A self-managed instance with a private CA needs that CA trusted by Node; do not disable TLS verification |

## HTTP connection failures

| Status/symptom | Meaning and recovery |
| --- | --- |
| 401 with OAuth enabled | Missing, expired, or invalid broker bearer. Complete OAuth; do not send a GitLab PAT to the broker-protected endpoint |
| 403 for browser Origin | Add the exact trusted origin to `MCP_ALLOWED_ORIGINS`, or correct `MCP_SERVER_URL`. Do not include a URL path |
| 404 for an MCP session | Session expired, process restarted, wrong replica, or bearer changed/missing. Clear the session ID and initialize with current credentials |
| 400 without a session | Send a proper MCP initialize request through a client; a normal tool call cannot create a session |
| 413 | Request body exceeds its size limit; reduce arguments/body size |
| 429 | Session, rate, or in-flight limit reached. Honor `Retry-After`, reduce concurrency, and close unused sessions |
| Streaming stalls through proxy | Disable proxy buffering/caching, preserve MCP headers, and allow long-lived HTTP responses |
| Every user hits a shared rate limit | Verify `TRUST_PROXY` against actual proxy topology; without it, users may share the proxy's IP |
| `/sse` not found | Use Streamable HTTP at `/` or `/mcp` |
| Host can reach service but LibreChat cannot | `localhost` inside LibreChat is LibreChat itself. Use the shared Docker service name/network or a reachable HTTPS endpoint |

`/health` is liveness only. A green container health check can coexist with invalid GitLab credentials or a failing Redis store.

## Tool calls and data

| Symptom | Check and action |
| --- | --- |
| No credentials / writes rejected | Follow [credential precedence](authentication.md#credential-precedence). A read fallback cannot authorize writes; check PAT scope and GitLab role |
| LibreChat collects a PAT but calls fail | Configure `headers.Authorization: "Bearer {{GITLAB_PAT}}"` as well as `customUserVars`, and send the same credential on every request |
| Custom GraphQL/REST fails with a fallback | Supply user credentials, or deliberately opt into `GITLAB_ALLOW_SHARED_ESCAPE_HATCH=true` for a personal setup |
| URL override appears ignored | `GITLAB_PIN_HOST=true` intentionally pins requests to `GITLAB_URL` |
| Project not found for a group path | Use `resolve_path` and `get_group_projects`, then pass the complete project namespace |
| Unknown GraphQL field or mutation | Inspect `get_type_fields` / `get_available_queries`; check instance version, enabled features and permissions |
| Empty issue filter results | Check username/label spelling, visibility, state and project scope. Use structured filters in `search_issues`; text is optional |
| Global MR text search fails | Use a project-scoped text search, or username/author/assignee discovery |
| Too few results or misleading totals | `fetchAll` is bounded by `first`. Follow each connection's cursor to completion; fetched counts are not global totals |
| Queue overflow / queue wait timeout | Reduce parallel tool calls or tune bounded queue/concurrency settings after checking capacity |
| Response exceeds byte limit | Narrow fields, page size, context, or file selection. Avoid unbounded custom queries |
| Write timed out | Inspect GitLab before retrying; the operation may have succeeded and writes are not automatically replayed |

## OAuth and Redis

- **Redirect mismatch:** register exactly `<MCP_SERVER_URL><GITLAB_OAUTH_CALLBACK_PATH>` in GitLab; ensure proxy routing preserves the callback and all OAuth routes.
- **Login works but access denied:** check allowed-group membership, granted scopes, and the separate MCP-client consent screen. Empty allowed groups means any authenticated GitLab user.
- **Refresh fails:** group checks and upstream failures fail closed. Sign in again. After successful refresh, initialize a new MCP session with the new bearer.
- **Login lost on restart:** in-memory state is ephemeral. Configure encrypted Redis for persistence; HTTP sessions still require reinitialization.
- **Redis startup rejects configuration:** use a 64-hex-character encryption key and TLS, or the documented loopback/trusted-private-network exception. Check Redis credentials, ACL, reachability, and consistent key/prefix across replicas.
- **Old clients stopped after v4 upgrade:** the old namespace is intentionally unread. Follow [migration steps](upgrading.md#redis-oauth-migration-from-v3), reconnect/re-register, and sign in again.
- **Replicas intermittently lose sessions:** configure sticky routing; Redis does not share HTTP sessions.

## Reporting a problem

Include the package/image version, Node.js version or container platform, client/version, transport, GitLab version/tier where known, relevant non-secret settings, tool name, redacted arguments, exact status/error, and minimal reproduction steps. State whether a proxy or multiple replicas are involved.

Remove PATs, Authorization headers, cookies, OAuth codes/client secrets, Redis passwords, encryption keys, and private repository content. Replace private hostnames and project paths consistently if necessary. Never attach a complete `.env` file. Report vulnerabilities through a private channel as described in [security reporting](authentication.md#reporting-a-security-issue).
