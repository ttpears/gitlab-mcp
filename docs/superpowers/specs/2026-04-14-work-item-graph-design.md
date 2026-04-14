# Work Item Graph Tool — Design

## Goal

Add a new MCP tool, `get_work_item_graph`, that walks GitLab work item relationships outward from a single root and returns a flat node/edge graph ready to render in Mermaid, D3, Cytoscape, or any other graph visualizer. The point is to let a caller see related issues across work item types (epic ↔ issue ↔ task) in one call without orchestrating their own BFS.

## Tool surface

Registered in `src/tools.ts` alongside the existing work item tools.

```
name: get_work_item_graph

input: {
  id: string                  # work item id (numeric) or full gid
  userCredentials?: ...       # standard per-request auth shape
}

output: {
  root: string                # gid of the requested item
  nodes: Node[]
  edges: Edge[]
  truncated: boolean          # true if the node cap or depth limit cut the walk short
  stats: {
    visited: number           # nodes successfully fetched
    requests: number          # GraphQL calls issued
    skipped: number           # neighbors returned as null (permission denied, deleted, etc.)
  }
}

Node = {
  id: string                  # gid
  iid: string
  title: string
  type: string                # work item type name (Issue, Epic, Task, ...)
  state: string
  webUrl: string
  namespace: { fullPath: string }
  depth: number               # 0 for the root, 1 or 2 for neighbors
}

Edge = {
  source: string              # gid
  target: string              # gid
  kind: 'relates_to' | 'blocks' | 'is_blocked_by' | 'parent' | 'child'
}
```

Limits are constants in the handler, not parameters:

- `MAX_DEPTH = 2`
- `MAX_NODES = 50`

These match the conservative defaults chosen during brainstorming. Bumping them later is a one-line change once we have real usage data.

## Walk algorithm

New method on `GitLabGraphQLClient`:

```
async getWorkItemGraph(rootId, userConfig): Promise<GraphResult>
```

BFS, breadth-first so depth-1 neighbors are guaranteed before depth-2 fan-out exhausts the node budget:

```
queue = [(rootGid, 0)]
visited = {}                 # gid -> Node
edges = []                   # deduped by (source, target, kind)
requests = 0
skipped = 0

while queue not empty and len(visited) < MAX_NODES:
  (gid, d) = queue.popLeft()
  if gid in visited: continue

  raw = getWorkItem(gid, { includeLinkedItems: true }, userConfig)
  requests += 1
  if raw == null:
    skipped += 1
    continue

  visited[gid] = toNode(raw, depth=d)

  if d == MAX_DEPTH:
    continue                 # boundary node — included, edges not expanded

  for neighbor in extractEdges(raw):
    edges.push({ source: gid, target: neighbor.gid, kind: neighbor.kind })
    if neighbor.gid not in visited and len(visited) < MAX_NODES:
      queue.push((neighbor.gid, d + 1))

truncated = (len(visited) >= MAX_NODES) or queue not empty

# Drop edges whose target was never visited so the result is internally consistent.
edges = edges.filter(e => e.target in visited)
```

Notes:

- **Edge dedup**: same `(source, target, kind)` triple appears at most once.
- **Cycle safety**: `visited` check before re-fetching prevents infinite loops on `A → B → A`.
- **Cross-project**: no filtering. A neighbor in another namespace is a normal node; the caller can color or group by `namespace.fullPath`.
- **Dangling targets**: if a neighbor would have been visited but the node cap stopped it, the edge is dropped from the output. Internal consistency (every edge endpoint is in `nodes`) is more useful than a hint that something existed.

## `extractEdges`

Reads two widget types from the work item payload:

- `WorkItemWidgetLinkedItems` → emits `relates_to`, `blocks`, or `is_blocked_by` edges based on `linkType`.
- `WorkItemWidgetHierarchy` → emits a `parent` edge to `parent.id` (if present) and a `child` edge per node in `children.nodes`.

Mention edges (parsing `#123` / `&45` from note bodies) are intentionally excluded. Linked items and hierarchy are the *intentional* relationship signals — a user explicitly clicked "link" or set a parent. Note mentions are incidental and noisy, and re-implementing parsing that GitLab already does server-side would produce false positives without adding real signal. Revisit only if real usage demonstrates a gap.

## Widget query expansion

`getWorkItem` in `src/gitlab-client.ts` gains an opts parameter:

```
async getWorkItem(
  id: string,
  opts: { includeLinkedItems?: boolean } = {},
  userConfig?: UserConfig
): Promise<any>
```

When `includeLinkedItems` is true, the GraphQL query adds:

```graphql
... on WorkItemWidgetLinkedItems {
  linkedItems {
    nodes {
      linkType
      workItem {
        id iid title state webUrl
        workItemType { name }
        namespace { fullPath }
      }
    }
  }
}
```

The existing `WorkItemWidgetHierarchy` fragment is extended so `parent` and `children.nodes` each include `namespace { fullPath }` (needed for cross-project node rendering).

The existing `get_work_item` tool calls `getWorkItem(id, {}, userConfig)` and is unchanged in behavior. The new graph walk calls `getWorkItem(id, { includeLinkedItems: true }, userConfig)`.

Defaulting `includeLinkedItems` to false keeps the existing tool's payload size unchanged. We can flip the default later if linked items turn out to be universally useful.

## Auth

Read-only tool. No write semantics, so it behaves like the other read tools:

- `shared` mode: uses the shared token.
- `hybrid` mode: uses the shared token unless the caller supplies `userCredentials`.
- `per-user` mode: requires `userCredentials`, same as every other tool in that mode.

No special-casing in the handler — it just forwards `userCredentials` to `getWorkItemGraph`, which forwards to `getWorkItem`, which is where the auth-mode logic already lives.

## Error handling

- **Invalid root id** → the underlying `getWorkItem` call returns null or errors. Propagate as-is; no special wrapping.
- **Permission denied on a neighbor** (token cannot read a linked item in another project) → GraphQL returns `null` for that node. The walk catches it, increments `stats.skipped`, and continues. The graph the caller gets back is honest about being incomplete.
- **Network/transport failure mid-walk** → propagate the error rather than returning a partial graph silently. Half-built graphs with no failure signal are worse than a clean error.
- **Empty graph** (root has no relationships) → `{ root, nodes: [rootNode], edges: [], truncated: false, stats: {visited: 1, requests: 1, skipped: 0} }`. Not an error.

## Testing

Jest unit tests, following the patterns already in the repo. The graph walker is tested by mocking `GitLabGraphQLClient.query`, not against a live GitLab.

Cases:

- **Single node, no edges** → root only, no edges, not truncated.
- **Linear chain A → B → C** at depth 2 → three nodes, two edges, not truncated.
- **Diamond** (A → B, A → C, B → D, C → D) → D appears once, all four edges present.
- **Cycle** A → B → A → terminates, both nodes visited once.
- **Cross-project neighbor** → included as a node with its own `namespace.fullPath`.
- **Permission-denied neighbor** (mock returns `null`) → skipped, `stats.skipped == 1`, walk continues.
- **60-node fan-out at depth 1** → truncated at 50, `truncated == true`, no dangling edges in output.
- **Depth-2 boundary** → a node at depth 2 is in `nodes` but its outbound edges are not expanded.
- **Edge dedup** → if the same `(source, target, kind)` triple is reachable via two paths, only one edge in output.

Tool-layer tests in `tools.ts`:

- Input validation rejects missing `id`.
- Accepts both `"123"` and `"gid://gitlab/WorkItem/123"`.

No integration test against real GitLab — consistent with how existing tools are covered in this repo.

## Out of scope (deliberately)

- Mention-based edges (see `extractEdges` rationale above).
- Configurable depth or node cap. Constants for v1; promote to parameters only if real usage shows the defaults are wrong.
- Tree / nested output shape. Flat `{nodes, edges}` is what visualizers want; nesting can be reconstructed client-side if anyone needs it.
- Server-side rendering (Mermaid string output, SVG, etc.). The tool returns data; rendering is the caller's job.
