# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.14.0] - 2026-04-27

### Removed

- **BREAKING:** `GITLAB_AUTH_MODE` environment variable. The three-way enum
  (`shared` / `per-user` / `hybrid`) is replaced by two role-named env vars.
- **BREAKING:** `GITLAB_SHARED_ACCESS_TOKEN` environment variable. Renamed
  to either `GITLAB_TOKEN` (full access) or `GITLAB_READ_TOKEN` (read-only)
  depending on intent.

### Added

- `GITLAB_TOKEN` env var: full-access fallback used for both reads and writes
  when no per-call user credentials are present.
- `GITLAB_READ_TOKEN` env var: read-only fallback. Writes are always rejected
  against this token; per-call user credentials are required for writes.
- `delete_issue` tool: destroy an issue by project path + IID.
- `delete_note` tool: destroy a comment on an issue or merge request.
- `update_note` tool: edit the body of an existing comment.
- Container image published to `ghcr.io/ttpears/gitlab-mcp` on every release tag,
  for `linux/amd64` and `linux/arm64`.
- Project logo at `assets/logo.svg`, surfaced via the plugin manifest and README.
- This `CHANGELOG.md`.

### Changed

- `serverInfo.name` bumped from `gitlab-mcp-server` to `GitLab` for nicer
  display in client UIs.
- README rewritten around three concrete deployment shapes: solo Claude Code,
  LibreChat with a read-only service account, and LibreChat strict per-user.
- `Dockerfile` now builds from the repo source instead of self-cloning at
  build time. Adds `EXPOSE 8008`, a real `/health` healthcheck, and runtime
  ENV defaults so `docker run -p 8008:8008 ghcr.io/ttpears/gitlab-mcp` works
  out of the box.

### Migration

| Before (≤1.13.x) | After (1.14.0) |
|---|---|
| `GITLAB_AUTH_MODE=hybrid` + `GITLAB_SHARED_ACCESS_TOKEN=…` | `GITLAB_READ_TOKEN=…` |
| `GITLAB_AUTH_MODE=shared` + `GITLAB_SHARED_ACCESS_TOKEN=…` | `GITLAB_TOKEN=…` |
| `GITLAB_AUTH_MODE=per-user` (no shared token) | (set neither env var) |

Setting both `GITLAB_TOKEN` and `GITLAB_READ_TOKEN` is now a startup error.

Old env vars trigger a deprecation warning at startup and are otherwise ignored.

---

## Older releases

For releases before 1.14.0 see the
[GitHub releases page](https://github.com/ttpears/gitlab-mcp/releases).

[Unreleased]: https://github.com/ttpears/gitlab-mcp/compare/v1.14.0...HEAD
[1.14.0]: https://github.com/ttpears/gitlab-mcp/releases/tag/v1.14.0
