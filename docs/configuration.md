# Environment variable reference

[Documentation home](../README.md) · [Deployment](deployment.md) · [Authentication](authentication.md)

The server reads its process environment. It does **not** load `.env` automatically. Docker's `--env-file`, Compose's service `env_file`, or your process manager must inject it. Copy [.env.example](../.env.example) as a template and review its HTTP settings before use.

Restart after changing settings. Numeric configuration is validated at startup. Core Boolean settings accept `true/1/yes/on` and `false/0/no/off`, case-insensitively; use `true` or `false` for clarity. `MCP_TRANSPORT` must be the exact string `http` to select HTTP.

## GitLab and credentials

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITLAB_URL` | `https://gitlab.com` | GitLab instance base URL |
| `GITLAB_TOKEN` | Unset | Full-access read/write fallback; mutually exclusive with `GITLAB_READ_TOKEN` |
| `GITLAB_READ_TOKEN` | Unset | Read-only fallback; mutually exclusive with `GITLAB_TOKEN` |
| `GITLAB_PIN_HOST` | `true` | Ignore per-call/header GitLab URL overrides |
| `GITLAB_ALLOW_SHARED_ESCAPE_HATCH` | `false` | Allow custom GraphQL/REST tools to use environment fallback credentials |
| `GITLAB_MAX_PAGE_SIZE` | `50` | Upstream GraphQL page-size cap, from 1 to 100; individual tool limits still apply |
| `GITLAB_TIMEOUT` | `30000` | Upstream timeout in milliseconds, at least 1000; covers response-body reads |
| `GITLAB_MAX_CONCURRENCY` | `16` | Upstream concurrency cap; `0` explicitly disables it |
| `GITLAB_MAX_QUEUED_REQUESTS` | `128` | Maximum waiting requests; `0` permits no waiting |
| `GITLAB_MAX_QUEUE_WAIT_MS` | `15000` | Maximum queue wait in milliseconds, at least 100 |
| `GITLAB_MAX_RESPONSE_BYTES` | `16777216` | Maximum upstream response, including decompressed bytes; at least 1024 |
| `GITLAB_ANALYTICS_MAX_PROJECTS` | `500` | Default group-analytics project cap; calls can supply `maxProjects` |

The upstream timeout starts after a request acquires a concurrency slot. Queue wait has its own limit. Read retries can take longer than one timeout; configure client/proxy timeouts accordingly. Writes are not automatically retried.

## Transport and HTTP limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_TRANSPORT` | stdio | Set `http` for Streamable HTTP |
| `GITLAB_MCP_PORT` | Unset in npm; `8008` in Docker | Listening port; set a valid nonzero port with HTTP mode. `PORT` is ignored |
| `MCP_SERVER_URL` | Unset | Public issuer URL; required for OAuth, also adds its origin to the allowed Origin set |
| `MCP_ALLOWED_ORIGINS` | Unset | Extra comma-separated browser origins, e.g. `https://client.example.com`; no URL paths |
| `TRUST_PROXY` | Unset/untrusted | Express trust-proxy setting: hop count, Boolean, or IP/subnet list matching your proxy topology |
| `MCP_MAX_SESSIONS` | `1000` | Global session cap including pending reservations; at least 1 |
| `MCP_MAX_SESSIONS_PER_IDENTITY` | `10` | Sessions per bearer identity; callers without a bearer share an identity; at least 1 |
| `MCP_REQUESTS_PER_MINUTE` | `240` | Requests per credential; per-IP allowance is five times this; at least 1 |
| `MCP_MAX_INFLIGHT_PER_IDENTITY` | `8` | Simultaneous requests per credential; per-IP allowance is five times this; at least 1 |
| `MCP_MAX_INFLIGHT_REQUESTS` | `256` | Global simultaneous HTTP requests; at least 1 |

Missing `Origin` is supported for native clients. Default browser origins are `http://localhost:<port>`, `http://127.0.0.1:<port>`, and the origin of `MCP_SERVER_URL` if set. These checks supplement authentication.

HTTP limits apply before body parsing. A bodyless `GET /health` is exempt. OAuth consent has extra limits, and the MCP SDK supplies its own authorization endpoint limits. JSON bodies are capped at 100 KiB; URL-encoded consent forms at 8 KiB. Idle sessions expire after ten minutes and are checked every two minutes. Body-size and idle-time settings are not environment-configurable.

## OAuth and persistent state

These settings apply when OAuth is enabled in HTTP mode. See [OAuth setup](authentication.md#oauth-for-remote-users).

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITLAB_MCP_OAUTH` | Disabled | Enable the broker with `true` |
| `MCP_SERVER_URL` | Required for OAuth | Public HTTPS issuer; localhost/127.0.0.1 may use HTTP |
| `GITLAB_OAUTH_CLIENT_ID` | Required for OAuth | GitLab application ID |
| `GITLAB_OAUTH_CLIENT_SECRET` | Unset | Confidential application's secret; omit for public PKCE applications |
| `GITLAB_OAUTH_SCOPES` | `api` | Space-separated GitLab scopes; match the registered application |
| `GITLAB_OAUTH_CALLBACK_PATH` | `/gitlab/callback` | Path starting with `/`; register the exact URL in GitLab |
| `GITLAB_OAUTH_ALLOWED_GROUPS` | Empty | Comma/space-separated group paths, including subgroups; empty allows any authenticated GitLab user |
| `REDIS_URL` | Unset | Persistent OAuth state; otherwise in-memory |
| `REDIS_KEY_PREFIX` | `gitlab-mcp` | Base prefix; issuer host and `:v4:` are appended |
| `OAUTH_STORAGE_ENCRYPTION_KEY` | Required with Redis | Exactly 64 hexadecimal characters (32 bytes); shared across replicas |
| `REDIS_ALLOW_INSECURE` | `false` | Permit non-TLS Redis beyond loopback on an explicitly trusted private network |

## Diagnostics and removed settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | Unset | Set `production` for hosting; `development` enables extra diagnostics |
| `REDIS_TEST_URL` | Unset | Test-suite Redis URL, **not** the runtime OAuth store |

`GITLAB_AUTH_MODE` and `GITLAB_SHARED_ACCESS_TOKEN` were removed in 1.14.0. They warn and are ignored. Choose the appropriate fallback explicitly; see [upgrading](upgrading.md). `PORT` does not select HTTP.
