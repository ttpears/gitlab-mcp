# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — TypeScript compile to `dist/` (tsc, ESM).
- `npm run dev` — Run the server directly from `src/` via `tsx` (stdio transport by default).
- `npm start` — Run the compiled server from `dist/index.js`.
- `npm test` — Jest. Run a single test with `npx jest <path>` or `npx jest -t "<name>"`.
- Local smoke test over HTTP: `MCP_TRANSPORT=http GITLAB_MCP_PORT=8008 GITLAB_SHARED_ACCESS_TOKEN=glpat-... npm run dev`, then point an MCP client at `http://localhost:8008/` (health check: `curl http://localhost:8008/health`).
- Interactive tool testing: `npx @modelcontextprotocol/inspector npx @ttpears/gitlab-mcp-server`.
- Debug logging: set `NODE_ENV=development` — startup prints the resolved config to stderr; production suppresses it.

## Architecture

Four source files, ~4.7k lines total — keep the layering in mind before adding code:

- `src/config.ts` — `loadConfig()` reads env (`GITLAB_URL`, `GITLAB_SHARED_ACCESS_TOKEN`, `GITLAB_AUTH_MODE`, `GITLAB_MAX_PAGE_SIZE`, `GITLAB_TIMEOUT`) into a zod-validated `Config`. `validateUserConfig()` parses per-request `userCredentials`. Auth modes: `shared` (one token for everything), `per-user` (every call must supply a user token), `hybrid` (default — shared token for reads, user token required for writes).
- `src/gitlab-client.ts` — `GitLabGraphQLClient` wraps `graphql-request` and is the only place that talks to GitLab. Every method accepts optional `userCredentials`; it picks the right token per the auth mode. Also hosts `fetchAllPages()` — the cursor-loop helper every `fetchAll` tool uses — and schema-introspection helpers.
- `src/tools.ts` — Declarative tool registry: each entry is `{ name, description, inputSchema: zod, handler(args, client) }`. Handlers are thin — they validate input, call the client, and shape the response. This is where pagination defaults and sort enums live for each tool.
- `src/index.ts` — `GitLabMCPServer` owns both transports. Stdio mode uses a single `Server` instance. HTTP mode (`MCP_TRANSPORT=http`) runs Express and maintains a `httpSessions` map keyed by session id, each with its own `Server` + `StreamableHTTPServerTransport` + per-session `userConfig`. The HTTP entry point accepts both `/` and `/mcp` (the latter exists for container setups). LibreChat sends credentials via `Authorization: Bearer <PAT>` and optional `X-GitLab-Url` headers — these are lifted into the session's `userConfig`. Idle sessions are reaped by `sessionCleanupInterval`.

Key flow to understand for any tool change: `index.ts` routes the MCP call → looks up the tool in `tools.ts` → handler calls `gitlab-client.ts` → client picks shared vs user token based on auth mode and the presence of `userCredentials` in the args.

## Project conventions (from `.cursorrules`)

- **Auth**: hybrid is default. Read tools may fall back to the shared token; write tools must throw if no user token is provided. Never silently write with the shared token.
- **Pagination**: every list/search tool takes `first`, `after`, and `fetchAll`. Defaults: `first=20`, cap at `config.maxPageSize`. `fetchAll=true` routes through `fetchAllPages()` and returns `{ nodes, totalFetched, hasMore, pageInfo }`. `search_gitlab` paginates projects and issues independently.
- **Sort**: issues, MRs, and projects default to `UPDATED_DESC` for recency bias.
- **State filters**: `all` → undefined; other values → uppercased GraphQL enum.
- **GraphQL compatibility**: avoid fields that don't exist on self-hosted GitLab (e.g. `Project.defaultBranch`) — rely on introspection (`get_type_fields`) when in doubt. Reviewers apply to MRs only, not issues.
- **Input hygiene**: trim search terms; reject empty strings for tools that require them. Null-guard group paths sent to project-only tools so errors are clear.
- **Update tools** (`update_issue`, `update_merge_request`) are schema-aware and fall back to granular mutations when the combined mutation isn't supported.

When adding a new tool, mirror an existing one of the same shape (list/search/update/discovery) — the patterns are consistent and the tool registry is the source of truth.

## Release flow

Releases are fully automated from `package.json` version bumps on `main`:

1. Bump `version` in `package.json`, mirror it in `.claude-plugin/plugin.json`, **and** sync `package-lock.json` (`npm install --package-lock-only`), then merge to `main`. Forgetting the lockfile won't fail CI but leaves it drifted. The plugin manifest version is what Claude Code's plugin cache keys on — if it drifts from the npm version, installs via the marketplace point at a different release than users think.
2. `.github/workflows/ci.yml` builds, then the `tag` job creates and pushes `vX.Y.Z` (skipped if the tag already exists).
3. `.github/workflows/release.yml` fires on tag push and runs `npm publish --provenance` plus `gh release create --generate-notes`. Publish auth is via npm **trusted publishing** — the `id-token: write` permission lets the npm CLI exchange the GitHub Actions OIDC token for a short-lived registry token, so no `NPM_TOKEN` secret is needed. Setting `NODE_AUTH_TOKEN` to an empty or malformed value will break publish, so leave the env off entirely.

The `tag` job checks out and pushes using `secrets.RELEASE_PAT` (a fine-grained PAT with **Contents: Read and write** on this repo, stored as a **repository** secret — environment secrets won't be visible to the job). This is required — tags pushed with the default `GITHUB_TOKEN` do not trigger downstream workflows, so `release.yml` would never fire. If the tag job fails with `403 denied to ttpears`, the PAT is missing the Contents:write grant or doesn't list this repo under its scoped repositories.

Do not run `gh release create` or `npm publish` manually — bump the version, merge, and let CI handle both. If a release needs hand-holding, check `gh run list` for the failing workflow rather than reproducing steps locally.

`main` is protected: changes ship via PR, not direct push.
