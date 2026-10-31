# Upgrading to 4.0

[Documentation home](../README.md) · [Changelog](../CHANGELOG.md) · [Operations](deployment.md)

Version 4.0 adds breaking runtime, OAuth-state, and capacity changes. Plan a client reconnection window. Documentation-only changes do not require a package version bump.

## Upgrade checklist

1. Use **Node.js 22 or later** for npm installations. Update your package/client pin to `@ttpears/gitlab-mcp-server@4.0.0` or your container image to `ghcr.io/ttpears/gitlab-mcp:4.0.0`. The container includes Node.js 24 and targets Linux amd64.
2. Review fallback credentials. `GITLAB_TOKEN` permits reads and writes; `GITLAB_READ_TOKEN` permits reads only. Set at most one. Remove `GITLAB_AUTH_MODE` and `GITLAB_SHARED_ACCESS_TOKEN`; they have been ignored since 1.14.0.
3. Review [capacity settings](configuration.md). HTTP sessions, request rate/concurrency, upstream queue size/wait, and response sizes now have finite defaults. Handle HTTP 429 with backoff and `Retry-After`.
4. For OAuth with Redis, perform the state migration below before starting v4. For in-memory OAuth, expect all users to sign in again after restart.
5. Restart the server, reconnect MCP clients, and verify `get_current_user` and a project lookup. OAuth clients must complete GitLab sign-in and the separate MCP-client consent screen.

## Redis OAuth migration from v3

v4 intentionally does not read the old plaintext OAuth namespace. Changing the running version alone leaves old plaintext records present until their TTLs expire.

1. Identify the issuer's old namespace from the v3 deployment's actual `REDIS_KEY_PREFIX` and `MCP_SERVER_URL` host. Record the exact scope before deleting anything.
2. Stop **all v3 replicas** so they cannot write more old state.
3. Remove only that issuer's old OAuth records using your Redis administration tooling. Do not use `FLUSHDB` or `FLUSHALL` on shared Redis. Do not delete other issuers' records.
4. Generate `OAUTH_STORAGE_ENCRYPTION_KEY` with `openssl rand -hex 32`; store the resulting 64 hexadecimal characters securely. Supply the same key to all replicas for that issuer.
5. Use `rediss://` for TLS. Non-TLS loopback is supported; beyond loopback, `REDIS_ALLOW_INSECURE=true` is an explicit opt-in for a trusted private network.
6. Start v4 with consistent issuer/prefix/key settings. New records use `<base-prefix>:<issuer-host>:v4:`. Users must reconnect, register the MCP client again where required, and sign in.

Use a dedicated Redis ACL and a memory quota with `noeviction`. Losing OAuth state forces sign-in again. Rotating the encryption key later requires a **fresh `REDIS_KEY_PREFIX`**, coordinated replicas, and client reconnection; old encrypted records cannot be read with a new key.

## Client-visible changes

- After GitLab login, the user must approve the specific MCP client and its exact redirect URI. Prior GitLab consent does not replace this step.
- OAuth codes and refresh tokens are single-use. Token families expire after 30 days. Group restrictions are rechecked at refresh; a failed refresh requires sign-in again.
- Keep the same bearer on every HTTP request in a session. PAT rotation, OAuth refresh, process restarts, and expired sessions require fresh initialization after HTTP 404.
- Reads can retry transient failures; writes are not automatically replayed. Verify the GitLab result before manually retrying a write after a timeout.
- Upstream responses exceeding the configured byte cap fail explicitly. Reduce page size or narrow the query/context when necessary.
- Stable object results on ten tools have declared output schemas; clients should still inspect `isError` and handle instance-specific extra fields.

## Rollback considerations

Keep the previous deployment configuration available, but do not run v3 and v4 replicas together under one issuer during this state migration. A rollback cannot consume v4 encrypted state with the old server. It requires a deliberate authentication reset and exposes the old version's behavior again. Prefer correcting a v4 configuration issue where possible. Never restore removed plaintext credentials merely to preserve sign-in sessions.
