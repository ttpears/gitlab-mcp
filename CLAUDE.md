# Repository guidance

Read [CONTRIBUTING.md](CONTRIBUTING.md) for commands, architecture, implementation conventions, tests, documentation maintenance, and release automation. Read [authentication](docs/authentication.md) before changing credentials, OAuth, or storage, and [operations](docs/deployment.md) before changing transport/session behavior.

## Working rules

- `main` is protected; use PRs. Do not publish npm or create releases manually during routine work. Version bumps merged to main drive automated releases.
- Preserve credential precedence, read-only fallback enforcement, host pinning, bounded resource use, and read-only retries. Never automatically replay an ambiguous write.
- HTTP sessions bind to their initialization bearer. A changed/missing bearer requires fresh initialization; OAuth refresh rotates that bearer.
- OAuth one-time state must use atomic `take`; preserve consent, encrypted storage, and family revocation during refresh races.
- The tool registry in `src/tools.ts` is authoritative. Regenerate its documentation with `npm run docs:generate` after changing it.
- Validate with `npm run typecheck`, relevant tests, `npm run check:docs`, and `npm run check:release`. CI runs Node.js 22/24 and real Redis tests; use `REDIS_TEST_URL` locally to include those tests.
- Update `[Unreleased]` in the changelog for user-facing behavior, env, tool, or breaking changes. Documentation-only, CI-only, and pure refactoring changes need no changelog entry or version bump.
- Keep secrets out of source, examples, stdout, and shared diagnostic output. Stdio stdout carries MCP protocol messages.
