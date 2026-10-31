# Workflows, results, and pagination

[Documentation home](../README.md) · [Tool reference](reference/tools.md) · [Troubleshooting](troubleshooting.md)

The examples below show the tool **name** followed by its **arguments**, not an HTTP API payload. Use an MCP client or Inspector to call them. They assume credentials are already configured through the transport or environment.

## Find a project and inspect code

1. `search_projects` — `{"searchTerm":"payments","first":5}`
2. `resolve_path` — `{"fullPath":"engineering/payments"}` to distinguish a project from a group.
3. `get_project` — `{"fullPath":"engineering/payments"}`
4. `browse_repository` — `{"projectPath":"engineering/payments","path":"","ref":"main"}`
5. `get_file_content` — `{"projectPath":"engineering/payments","filePath":"README.md","ref":"main"}`

Use the actual default branch/ref returned by your project rather than assuming `main`. Tools taking `fullPath` or `projectPath` expect the complete namespace path, not a GitLab web URL. A group path is not a project path; use `get_group_projects` for group discovery.

## Find your issues

Call `get_current_user` with `{}` to obtain the username, then:

```text
search_issues
```

```json
{
  "assigneeUsernames": ["alice"],
  "state": "opened",
  "labelNames": ["bug"],
  "first": 20
}
```

`searchTerm` is optional for structured issue filtering. Add `projectPath` to restrict the search. `search_gitlab` searches projects and issues; use `search_issues` for assignee, author, and label filters.

## Review a merge request

For `https://gitlab.example.com/engineering/payments/-/merge_requests/42`, use project path `engineering/payments` and IID **`"42"`**:

1. `get_merge_request_context` — `{"projectPath":"engineering/payments","iid":"42"}`
2. `get_merge_request_diffs` — `{"projectPath":"engineering/payments","iid":"42"}`
3. `get_merge_request_pipelines` — `{"projectPath":"engineering/payments","iid":"42"}`
4. `get_pipeline_jobs` using the pipeline identifier returned by the preceding call; check the reference for its exact input shape.

Use `search_merge_requests` with `projectPath` and text, or with `searchTerm: "author:alice"` / `"assignee:alice"` for username-based discovery. This server does not provide global MR text search. An empty MR search term is rejected.

An IID is the number shown in a project's issue/MR URL. It differs from a global GraphQL ID such as `gid://gitlab/Issue/12345` or a numeric REST ID. Pass the identifier specified by each tool; do not exchange these forms blindly.

## Create or update work

With credentials permitted to write:

```text
create_issue
```

```json
{
  "projectPath": "engineering/payments",
  "title": "Document webhook retry behavior",
  "description": "Describe retry intervals and duplicate-delivery handling."
}
```

Read the result before performing follow-up changes. `update_issue`, `update_merge_request`, and note tools accept different identifiers and fields; see the [reference](reference/tools.md). Reviewers apply to merge requests, not issues. If a write times out, check whether GitLab applied it before retrying.

## Paginate without losing results

Many GraphQL list/search tools expose `first`, `after`, and sometimes `fetchAll`. Consult each tool's schema: not every list has the same interface, and REST event feeds use their documented pagination parameters.

A typical single-page result contains:

```json
{
  "nodes": [],
  "pageInfo": {
    "hasNextPage": true,
    "endCursor": "opaque-cursor-from-gitlab"
  }
}
```

The empty `nodes` above is illustrative; use the real result. To continue `get_issues`:

```json
{
  "projectPath": "engineering/payments",
  "first": 50,
  "after": "opaque-cursor-from-gitlab"
}
```

Keep the same filters and sort, collect `nodes`, and repeat with the newest `endCursor` until `hasNextPage` is false. Cursors are opaque and belong to that connection/query. Missing or non-advancing cursors produce errors rather than pretending the scan completed.

`fetchAll: true` performs a **bounded** loop. For example, `{"first":100,"fetchAll":true}` fetches at most 100 items, not the whole instance. It honors `after` and returns `nodes`, `totalFetched`, `hasMore`, and `pageInfo`. Check `hasMore` and continue when needed. Most search/list defaults are `first:20`; individual schemas impose their own maxima. Upstream pages are also capped by `GITLAB_MAX_PAGE_SIZE` (default 50).

`search_gitlab` has separate project and issue connections and applies `first` per category. Its `totalResults` counts fetched items, not all matches. Use `search_projects` and `search_issues` to continue those connections independently.

Issues and MRs default to `UPDATED_DESC`; projects default to `latest_activity_desc`. Choose an explicit sort when needed. Live data may change between pages, so paginated scans are not transactional snapshots. Never present a bounded page or fetched subtotal as an exhaustive count.

## Activity and analytics

```text
analytics_group_summary
```

```json
{
  "group": "engineering",
  "since": "2026-10-01",
  "until": "2026-10-31",
  "includeSubgroups": true,
  "maxEvents": 2000,
  "maxProjects": 500
}
```

Use explicit ISO datetimes when exact boundaries matter. `analytics_user_summary` takes `user` and `since`; `analytics_review_bottlenecks` analyzes review delays. Inspect returned truncation/coverage metadata and warnings before drawing conclusions. Event/project caps, permissions, GitLab event retention, and event availability can limit coverage. Event summaries are not complete audit trails or measurements of an individual's performance.

## Achievements

Six tools list, create, update, delete, award, and revoke group achievements. Availability depends on your GitLab release and enabled features: achievements began behind a flag in 15.10, were enabled by default in 19.2, and became generally available in 19.3. Check your installed version's GitLab documentation. Writes require the appropriate group role (typically Maintainer or Owner).

Use returned achievement/award IDs for later operations. Recipient previews are bounded, repeated awards can need disambiguation, and acceptance can affect what appears on a profile. Avatar multipart uploads are not implemented by these tools.

## Result contracts and errors

- Successful results include JSON text in `content`. Object results also include `structuredContent`; arrays and primitives do not. Empty/204 results are represented as text `null`.
- Ten tools currently declare output schemas. Those outputs are validated before returning; this does not imply every tool has a declared output schema. The generated reference marks each one.
- Invalid arguments and GitLab execution failures return a tool result with `isError: true` and a text message. Inspect that flag even if the HTTP request succeeded.
- Unknown tool names are MCP protocol errors. HTTP authentication, Origin, session, body-size, and capacity failures can occur before a tool runs.

Instance-specific GraphQL types vary. Use `get_available_queries` and `get_type_fields` before writing a custom query. Introspection and schema-aware updates improve compatibility; they do not guarantee every feature exists on every GitLab version or tier.

## Workflow prompts

Clients that expose MCP prompts can request these templates. Every argument is optional; prompts provide instructions for the client to carry out, rather than running tools by themselves.

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `explore-project` | `projectPath` | Inspect a project's structure and context |
| `find-my-work` | None | Find the current user's work |
| `review-merge-request` | `projectPath`, `mrIid` | Review an MR, changes, and related context |
| `team-activity` | `groupPath`, `days` | Summarize group activity; default look-back 14 days |
| `user-activity` | `username`, `days` | Summarize user activity; default look-back 14 days |
| `triage-issues` | `projectPath`, `label` | Triage a project's issues |
| `project-health` | `projectPath` | Explore project health signals |
| `search-gitlab` | `query` | Search and explore GitLab |
