# Contributing

[Documentation home](README.md) · [Configuration](docs/configuration.md) · [Tool reference](docs/reference/tools.md)

## Local development

Use Node.js 22 or 24 and npm. Clone the repository, then:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check:docs
npm run check:release
```

`npm run dev` starts the TypeScript server with `tsx`; `npm start` runs `dist/index.js`. Both default to stdio. To inspect it locally, export a GitLab credential and use MCP Inspector. Do not write logs to stdout in stdio mode; it carries MCP messages.

### Redis integration tests

Without `REDIS_TEST_URL`, the real Redis cases are skipped. CI always supplies Redis and tests Node.js 22 and 24. To include these cases locally:

```bash
docker run -d --rm --name gitlab-mcp-test-redis \
  -p 127.0.0.1:6379:6379 redis:7-alpine
REDIS_TEST_URL=redis://127.0.0.1:6379 npm test
docker stop gitlab-mcp-test-redis
```

Use a disposable Redis instance; tests create/delete their own test state. `REDIS_TEST_URL` is separate from runtime `REDIS_URL`. The Redis cases cover encryption, atomic consumption, and cross-replica revocation. Tests also cover mock GitLab HTTP behavior, pagination, schema compatibility, sessions, cancellation, resource limits, and OAuth consent. They do not prove compatibility with every live GitLab installation.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/index.ts` | MCP handlers/prompts, stdio/HTTP transport, session lifecycle, HTTP/OAuth routing and Origin checks |
| `src/tools.ts` | Declarative registry: tool names, Zod inputs/outputs, annotations, thin handlers |
| `src/gitlab-client.ts` | GitLab GraphQL/REST operations, credential selection, schema discovery, pagination and bounded concurrency |
| `src/http.ts` | Complete-body deadlines, byte limits, retry delay helpers and cancellation |
| `src/security.ts` | Bounded HTTP rate and concurrency accounting |
| `src/oauth.ts` | GitLab OAuth broker, explicit client consent, refresh/revocation and group checks; also makes upstream GitLab requests |
| `src/oauth-store.ts` | In-memory/Redis stores, atomic `take`, encrypted values and namespacing |
| `src/analytics.ts` | Time windows, event collection, aggregation and coverage metadata |
| `scripts/` | Release consistency, MCPB packaging and documentation generation/checks |

A call enters `index.ts`, validates against the registry, resolves request credentials, invokes a handler/client operation, and returns JSON text plus structured content for objects. Declared output schemas are validated before returning. See [authentication](docs/authentication.md#credential-precedence) for the full precedence order.

## Implementation conventions

- Keep tool handlers thin; put upstream behavior in the client or the relevant OAuth/HTTP module.
- Credentials from a call, OAuth, or HTTP session precede environment fallbacks. Never silently write with `GITLAB_READ_TOKEN`. Preserve host pinning and escape-hatch restrictions.
- Use instance introspection for optional GraphQL fields/mutations. Update tools may need granular-mutation fallbacks. Reviewers belong to MRs, not issues.
- Preserve bounded pagination. `fetchAll` honors `after` and caps total items at `first`; reject missing/non-advancing cursors. Do not infer exhaustive totals from fetched pages.
- Retry reads only. Never replay an ambiguous mutation/REST write. Propagate MCP cancellation through queueing, response reads, and retry backoff.
- Preserve finite session, HTTP, queue, and body limits. Bind every HTTP session request to its initialization bearer; rotation requires reinitialization.
- One-time OAuth state must use atomic `take` in both backends. Preserve family-wide revocation during refresh races, refresh-time group checks, browser-bound consent, encrypted Redis records, and hashed token keys.
- Add meaningful output schemas for stable object results while preserving useful additional fields. Test behavioral changes, including error and compatibility cases.

## Documentation changes

Edit the relevant guide and examples when changing tools, environment variables, authentication, or transport behavior. The tool reference is generated from the same registry and JSON Schema conversion used for MCP discovery:

```bash
npm run docs:generate
npm run check:docs
```

`docs:generate` builds the project and regenerates `docs/reference/tools.md`. Do not edit that file by hand. `check:docs` rebuilds, detects reference drift, validates local Markdown links/anchors and JSON examples, and checks client example commands/environment names. CI runs it on both supported Node.js versions. Runtime refinements can impose constraints beyond JSON Schema; document those in the workflow guides.

Add an `[Unreleased]` changelog entry for user-facing behavior, environment, tool, or breaking changes. Documentation-only, CI-only, and pure refactoring PRs do not need one. Keep documentation/examples included in the npm package so relative README links work after installation.

## Pull requests and releases

`main` is protected. Submit a PR with a concrete description and relevant validation. CI installs from the lockfile, checks release/docs consistency, audits dependencies, builds/typechecks, runs tests with real Redis on Node.js 22/24, and builds the MCPB bundle on Node.js 24. Same-repository PRs also get an amd64 preview image tagged `branch-<branch-slug>`; that is not a release.

For a release:

1. Set matching versions in `package.json`, `package-lock.json` (including its root package), and `.claude-plugin/plugin.json`.
2. Date the version's changelog entry and start a fresh `[Unreleased]` section.
3. Update pinned release versions in installation examples and guides. Run `npm run docs:generate`, `npm run check:docs`, and `npm run check:release`.
4. Merge the PR after CI. The main-branch tag job creates `vX.Y.Z` if absent; the tag triggers the release workflow.

Release automation publishes npm with provenance using trusted publishing/OIDC, creates the GitHub Release with the MCPB asset, and publishes the versioned GHCR image. Do not run `npm publish` or create a release manually as part of routine release work. The tag job requires repository secret `RELEASE_PAT` with Contents write permission: a tag pushed with the default `GITHUB_TOKEN` cannot trigger the downstream release workflow. npm publishing should not receive an empty or malformed `NODE_AUTH_TOKEN` override.

`check:release` fails on version/lockfile/plugin drift and verifies immutable Action/container base pins. If release automation fails, inspect the failing workflow/job before changing credentials or retrying publication.
