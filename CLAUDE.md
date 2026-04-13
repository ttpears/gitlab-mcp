# CLAUDE.md

## Release flow

Releases are fully automated from `package.json` version bumps on `main`:

1. Bump `version` in `package.json` and merge to `main`.
2. `.github/workflows/ci.yml` builds, then the `tag` job creates and pushes `vX.Y.Z` (skipped if the tag already exists).
3. `.github/workflows/release.yml` fires on tag push and runs `npm publish --provenance` plus `gh release create --generate-notes`.

Do not run `gh release create` or `npm publish` manually — bump the version, merge, and let CI handle both. If a release ever needs hand-holding, check `gh run list` for the failing workflow rather than reproducing steps locally.
