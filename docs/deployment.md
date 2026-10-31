# Deployment and operations

[Documentation home](../README.md) · [Configuration](configuration.md) · [Authentication](authentication.md)

## Transport and endpoints

| Transport | Select with | Endpoints |
| --- | --- | --- |
| stdio | Default | stdin/stdout; logs on stderr |
| Streamable HTTP | `MCP_TRANSPORT=http` and `GITLAB_MCP_PORT=8008` | `/` and `/mcp`; liveness at `/health` |

Set both HTTP variables explicitly. A missing port causes the entrypoint to fall back to stdio; `PORT` is ignored. Streamable HTTP can carry SSE responses, but this server does not offer a legacy `/sse` transport endpoint.

## Docker

The published image runs as non-root UID 1001, includes Node.js 24 and an init process, and defaults to HTTP on port 8008. Published release images currently target Linux amd64. Pin a release tag; see the [README](../README.md#choose-a-setup) for the current image version.

For strict per-user PAT access on the local machine:

```bash
docker run -d --name gitlab-mcp \
  --restart unless-stopped \
  -p 127.0.0.1:8008:8008 \
  -e GITLAB_URL=https://gitlab.com \
  ghcr.io/ttpears/gitlab-mcp:4.0.0
curl --fail http://localhost:8008/health
docker logs --tail 50 gitlab-mcp
```

Send your PAT through the client, not the server environment. For a shared read account or OAuth, put the appropriate settings in a locally protected environment file and add `--env-file /path/to/gitlab-mcp.env`. The process does not load `.env` on its own. Do not bake secrets into the image.

To run with npm instead:

```bash
MCP_TRANSPORT=http GITLAB_MCP_PORT=8008 NODE_ENV=production \
  npx -y @ttpears/gitlab-mcp-server@4.0.0
```

The HTTP listener binds through Express without a configurable loopback-only host. Apply host firewall or proxy/container network controls when running outside Docker.

For LibreChat, use the [Compose fragment](../docker-compose.override.yml) and [client guide](installation.md#librechat). No host port is needed when both services share a Docker network.

## Reverse proxy

Terminate HTTPS at your proxy and forward to the private MCP service. Preserve `Authorization`, `Mcp-Session-Id`, `MCP-Protocol-Version`, `Accept`, and `Content-Type`. Preserve the session/protocol response headers as well. Disable response buffering for streaming traffic and allow long-lived responses.

An Nginx example for a service reachable as `gitlab-mcp:8008`:

```nginx
# Inside the HTTPS server block for gitlab-mcp.example.com.
location / {
    proxy_pass http://gitlab-mcp:8008;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
}
```

Set `MCP_SERVER_URL=https://gitlab-mcp.example.com` for the public origin. For OAuth, forward **all paths**, including `/.well-known/…`, `/register`, `/authorize`, `/token`, `/revoke`, `/oauth/consent`, and the GitLab callback; proxying only `/mcp` is insufficient.

Configure `TRUST_PROXY` to the real trusted hops/subnets. `TRUST_PROXY=1` is appropriate only if there is exactly one trusted proxy on every route and clients cannot reach the backend directly. An overly broad value lets callers forge their apparent address; no trust behind a proxy makes users share the proxy IP's rate allowance.

For a browser client on a separate origin, add that exact origin to `MCP_ALLOWED_ORIGINS`. Do not add redirect paths or assume CORS provides access control. Native clients can connect without `Origin`.

## Sessions, restarts, and replicas

The server creates an HTTP session during MCP initialization. Each session belongs to the bearer credential used to initialize it; every request must carry the same credential. Unknown, expired, restarted, or credential-mismatched sessions return **HTTP 404**. Clear the old session ID and initialize again. PAT rotation and OAuth refresh both require a new session.

Sessions expire after ten idle minutes, with cleanup every two minutes. Session limits include pending initialization reservations. Calls without a bearer share the anonymous session identity even when they supply credentials in tool arguments.

HTTP sessions live in one process. For multiple replicas, use sticky routing. Redis can share OAuth state but cannot recover an MCP session on another replica. During a rolling restart, clients must tolerate a 404 and reinitialize. Keep issuer URL, OAuth settings, Redis prefix, and encryption key consistent across replicas.

On shutdown, send SIGTERM and allow time for cleanup. With Docker:

```bash
docker stop --time 30 gitlab-mcp
```

## Capacity and reliability

Defaults bound sessions, HTTP request rate/concurrency, upstream requests, waiting work, and response size. See the [configuration tables](configuration.md) before tuning. Request accounting is process-local; multiple replicas increase aggregate capacity and do not create a distributed rate limit.

- HTTP saturation returns **429** with `Retry-After`. Back off instead of opening more sessions.
- Upstream queue overflow or queue-wait expiry returns an MCP tool error. Reduce fan-out or tune capacity after observing GitLab and server load.
- Upstream responses larger than 16 MiB after decompression fail explicitly. Fetch smaller pages, narrower context, or smaller files.
- Reads retry transient network/timeout/status failures, up to four total attempts. GitLab `Retry-After` is honored on 429.
- Mutations and REST writes are attempted once. If a response is lost, inspect GitLab before manually retrying to avoid duplicate issues, notes, or actions.
- MCP cancellation propagates through queue wait, active upstream requests, and retry backoff.

Client/proxy timeouts should account for queue wait, upstream request time, retries, and analytics fan-out. A longer timeout does not remove page/event/project caps. Group analytics scans projects sequentially and reports bounded coverage.

## Health and diagnostics

`GET /health` reports process liveness, server/protocol version, session count, and timestamp. The image's health check uses this endpoint. A successful response does **not** prove GitLab connectivity, token validity, Redis readiness, or that a particular tool works.

Use `get_current_user` followed by a small project lookup for an authenticated functional check. For OAuth, test sign-in, client consent, refresh, revocation, and reconnection after restart against your actual GitLab instance.

Keep `NODE_ENV=production` for normal hosting. Use `development` temporarily for diagnostics and redact logs before sharing them. This repository's mock/schema and Redis tests do not substitute for testing your self-managed GitLab version, license, proxy, and client combination.
