# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.17.0] - 2026-05-21

### Changed
- MCPB (Claude Desktop) bundle now allows write access. The single PAT
  field is mapped to `GITLAB_TOKEN`, so users can supply a `read_api`-scoped
  token for read-only access or an `api`-scoped token to enable writes
  (`create_issue`, `create_merge_request`, etc.). Bundle display name
  changed from "GitLab (community, read-only)" to "GitLab (community)" and
  the manifest `user_config` field was renamed `gitlab_read_token` →
  `gitlab_token`. Existing installs will prompt to re-enter the PAT on
  upgrade because of the renamed config key.

## [1.16.0] - 2026-05-21

### Added
- Todo management tools: `list_my_todos`, `mark_todo_done`, `mark_all_todos_done`, `restore_todo`. Wraps GitLab's GraphQL `currentUser.todos` query and `todoMarkDone` / `todosMarkAllDone` / `todoRestore` mutations. Schema-introspection fallback drops unsupported filters on older self-hosted GitLab and surfaces a `_warning` field in the response.

## [1.15.2] - 2026-05-07

### Added

- MCPB (Claude Desktop / MCP Bundle) build. `npm run build:mcpb`
  produces `gitlab-mcp-community-${VERSION}.mcpb` — a self-contained
  zip with `manifest.json` + pruned `node_modules/`. The Release
  workflow now attaches the bundle to each GitHub Release alongside
  the existing npm and GHCR artifacts, so users can install via
  one-click drag-and-drop into Claude Desktop. The bundle ships as
  **read-only** (`GITLAB_READ_TOKEN` only) and is labeled
  "GitLab (community, read-only)" to disambiguate from GitLab Inc.'s
  first-party MCP server. Users who need write access should install
  via npm or GHCR.

## [1.15.1] - 2026-05-07

### Fixed

- Write tools (`create_merge_request`, `create_issue`, `update_issue`,
  `delete_issue`, `update_merge_request`, `manage_pipeline`, `create_note`,
  `delete_note`, `update_note`, `create_broadcast_message`,
  `update_broadcast_message`, `delete_broadcast_message`, and the
  `requiresWrite` branch of `execute_custom_query`) no longer reject the
  request when no per-call `userCredentials` are supplied. They now fall
  back to `GITLAB_TOKEN` exactly as documented — a handler-level guard
  was short-circuiting the four-step token resolution in `getClient()`,
  so writes failed with "User authentication is required…" even when a
  full-access env token was configured. Reads were unaffected. Per-call
  user credentials and HTTP `Authorization: Bearer` flows continue to
  work unchanged. Fixes #32.

## [1.15.0] - 2026-04-27

### Added

- `analytics_group_summary` tool: aggregated activity summary for an entire
  group (optionally including subgroups) over a time window. Returns
  per-action totals plus breakdowns by project, by contributor, and by day.
  Group-scoped sibling of `analytics_user_summary`.
- `get_issue_context` tool: bundles issue body, notes, related/closing merge
  requests, and linked issues into a single call. Replaces 4–5 fan-out tool
  calls per investigation.
- `get_merge_request_context` tool: bundles MR body, notes, commits, pipelines,
  reviewers, and closes-issues into a single call.
- `search_notes` tool: full-text search across issue and merge request
  comments via REST `/search?scope=notes`. NOTE: self-hosted GitLab requires
  Advanced Search (Elasticsearch) enabled for this scope.
- README badges for CI status, monthly npm downloads, and GHCR container image.

### Removed

- Smithery.ai integration. The `smithery.yaml` config still referenced
  `GITLAB_AUTH_MODE=hybrid`, which 1.14.0 removed as a breaking change, so
  Smithery deployments were already broken. Drops the `@smithery/sdk` dev
  dependency, the `createMcpServer` default export, the `configSchema` export,
  the `/.well-known/mcp-config` HTTP endpoint, and the 17 MB committed
  `.smithery/index.cjs` build artifact.

## [1.14.1] - 2026-04-27

### Fixed

- `delete_issue` now uses the REST API (`DELETE /projects/:id/issues/:iid`)
  instead of a GraphQL mutation. GitLab's GraphQL schema does not expose a
  `destroyIssue` mutation, so the 1.14.0 implementation failed with
  `DestroyIssueInput isn't a defined input type` against any GitLab instance.

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

[Unreleased]: https://github.com/ttpears/gitlab-mcp/compare/v1.15.0...HEAD
[1.15.0]: https://github.com/ttpears/gitlab-mcp/releases/tag/v1.15.0
[1.14.1]: https://github.com/ttpears/gitlab-mcp/releases/tag/v1.14.1
[1.14.0]: https://github.com/ttpears/gitlab-mcp/releases/tag/v1.14.0
