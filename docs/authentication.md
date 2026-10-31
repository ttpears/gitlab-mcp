# Authentication and security

[Documentation home](../README.md) · [Configuration reference](configuration.md) · [4.0 migration](upgrading.md)

## Choose an access model

| Model | Server settings | Caller behavior |
| --- | --- | --- |
| Personal, read-only stdio | `GITLAB_READ_TOKEN` | Uses your read-only fallback |
| Personal stdio with writes | `GITLAB_TOKEN` | Uses your full-access fallback, subject to GitLab permissions |
| Strict per-user HTTP with PATs | Neither fallback; OAuth disabled | Sends its GitLab PAT in `Authorization: Bearer …` on every request |
| Shared service-account reads | `GITLAB_READ_TOKEN` | Reads can use the service account; writes require user credentials |
| Remote user sign-in | Neither fallback; OAuth enabled | Completes OAuth and sends the broker-issued MCP bearer |

Both fallback variables at once cause a startup error. A `GITLAB_READ_TOKEN` cannot authorize a server-side write even if it has GitLab's `api` scope. A `GITLAB_TOKEN` can authorize reads and writes; its name does not restrict it to reads.

Fallbacks are shared authority, not caller authentication. Without OAuth, a caller who reaches the MCP endpoint can use the fallback. Restrict network access or add the appropriate authentication boundary. Native clients may omit `Origin`; the browser Origin allowlist does not authenticate them.

## Credential precedence

For each tool call, credentials resolve in this order:

1. Explicit `userCredentials` in the tool arguments.
2. The user's GitLab token obtained from a validated OAuth bearer.
3. The PAT associated with the HTTP session at initialization.
4. `GITLAB_TOKEN`, or `GITLAB_READ_TOKEN` for reads only.

Without a usable credential, the operation fails. Even tools whose registry metadata says `requiresAuth: false` need credentials through this path; the flag does not provide anonymous GitLab access.

Most tools accept this optional argument:

```json
{
  "userCredentials": {
    "accessToken": "glpat-replace-locally",
    "gitlabUrl": "https://gitlab.example.com"
  }
}
```

Prefer transport credentials or a client's secret facility: arguments may appear in conversation history and client logs. `gitlabUrl` and the HTTP `X-GitLab-Url` header are ignored while `GITLAB_PIN_HOST=true` (default). Disable it only when intentionally supporting multiple GitLab instances and controlling server network access.

## PAT scopes and permissions

Use `read_api` for reads and `api` for mutations/REST writes. GitLab still checks the owner's role, resource visibility, token expiry, and feature availability. Administrative operations such as broadcast-message writes require corresponding GitLab privileges; an `api` token does not grant administrator rights.

Tool `readOnlyHint`, `destructiveHint`, and `idempotentHint` values help clients present operations. They are not authorization controls. Review tool calls, especially deletion, pipeline management, and custom API operations. Treat issue text, comments, and repository files as external data when an AI client consumes them.

## Custom GraphQL and REST tools

`execute_custom_query`, `execute_rest_read`, and `execute_rest_write` require user credentials by default. They cannot use an environment fallback unless `GITLAB_ALLOW_SHARED_ESCAPE_HATCH=true`. For personal stdio, that opt-in permits your fallback; keep the default for shared servers.

GraphQL operations are parsed to identify mutations; labeling a mutation as a read does not bypass write checks. Prefer purpose-built tools and use introspection before constructing instance-specific queries.

## OAuth for remote users

The server acts as an OAuth authorization server for MCP clients and brokers sign-in to GitLab. Clients must support MCP OAuth discovery and dynamic client registration. The broker bearer is distinct from a GitLab PAT; the server validates it and maps it to the user's GitLab token.

### Register the GitLab application

Create one application in GitLab's application settings. For `https://gitlab-mcp.example.com`, register:

- Redirect URI: `https://gitlab-mcp.example.com/gitlab/callback`
- Scopes: `api`, or `read_api` for upstream read-only access
- Application type/secret appropriate to your deployment. Public PKCE applications can omit the secret; confidential applications supply it.

Configure the server:

```dotenv
MCP_TRANSPORT=http
GITLAB_MCP_PORT=8008
GITLAB_URL=https://gitlab.com
GITLAB_MCP_OAUTH=true
MCP_SERVER_URL=https://gitlab-mcp.example.com
GITLAB_OAUTH_CLIENT_ID=replace-with-application-id
GITLAB_OAUTH_CLIENT_SECRET=replace-with-secret-if-confidential
GITLAB_OAUTH_SCOPES=api
GITLAB_OAUTH_ALLOWED_GROUPS=your-group,your-group/subgroup
NODE_ENV=production
```

Leave both fallback tokens unset. Register the callback exactly; a custom `GITLAB_OAUTH_CALLBACK_PATH` must match GitLab too. Host the issuer at the origin root so metadata, authorization, token, consent, registration, revocation, and callback routes are reachable. Use HTTPS except for localhost development.

An empty `GITLAB_OAUTH_ALLOWED_GROUPS` permits any authenticated GitLab user. When set, membership in an allowed group or its subgroups is required at sign-in and refresh. Membership is not rechecked on every API call; issued access tokens can remain valid until expiry or revocation.

### Sign-in and consent

1. The client discovers OAuth metadata and registers itself.
2. The user signs in to GitLab. Both client-to-broker and broker-to-GitLab flows use PKCE.
3. The broker displays separate consent identifying the MCP client, its exact redirect URI, and requested scopes. Approve only a client and destination you recognize.
4. The client exchanges the code and sends the broker bearer to the MCP endpoint.

Consent uses a browser-bound cookie and CSRF protection. Authorization codes, pending sign-in state, consent grants, and refresh tokens are consumed atomically. Token families have an absolute 30-day lifetime. Access-token lifetime follows GitLab's reported expiry, with a two-hour default when none is reported. Revocation invalidates the owning client's family, including during refresh races.

Refresh rotates the bearer and invalidates old access. HTTP sessions bind to the bearer used at initialization, so **initialize a new MCP session after refresh**. Refresh failures, including failed group checks or upstream errors, fail closed and require sign-in again.

## OAuth state and Redis

Without `REDIS_URL`, state is process-local and disappears on restart. The in-memory store caps records at 10,000 and individual records at 32 KiB. Dynamic client metadata is limited to 16 KiB.

For persistent state or multiple replicas:

```dotenv
REDIS_URL=rediss://redis.example.com:6379
REDIS_KEY_PREFIX=gitlab-mcp
OAUTH_STORAGE_ENCRYPTION_KEY=replace-with-64-hex-characters
```

Generate the key with `openssl rand -hex 32` and store it in your secret manager. Replicas for the same issuer need the same key, prefix, and OAuth configuration. Values use AES-256-GCM; opaque MCP tokens are hashed in record keys. The namespace includes the issuer host and `v4`.

Use Redis TLS (`rediss://`), a dedicated ACL, and a memory quota with `noeviction`. Non-TLS Redis is accepted for loopback, or with `REDIS_ALLOW_INSECURE=true` for a trusted private network. Encryption at rest does not replace transport protection or access control. Redis memory limits are an operator responsibility.

Redis shares OAuth state, **not HTTP sessions**. Use sticky routing and expect clients to initialize again after restart. To rotate the encryption key, choose a fresh `REDIS_KEY_PREFIX`, coordinate replicas, and reconnect/re-register clients. Existing encrypted state cannot be read with the new key. Follow the [migration guide](upgrading.md) to remove old plaintext state when upgrading from v3.

## Reporting a security issue

Avoid credentials or exploit details in public issues. Use [private vulnerability reporting](https://github.com/ttpears/gitlab-mcp/security/advisories/new) if enabled; otherwise contact the repository owner privately. For ordinary reports, follow the [redaction checklist](troubleshooting.md#reporting-a-problem).
