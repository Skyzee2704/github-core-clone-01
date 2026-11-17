[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Skyzee2704/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Skyzee2704/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A from-scratch reimplementation of the core of GitHub: repositories, git
objects, issues, pull requests, labels, the REST v3 API, the GraphQL v4 API,
the Model Context Protocol, and smart-HTTP git — in a single Node.js process
with an in-memory store. No dependencies, no database, no disk writes. Node 22,
TypeScript, standard library only.

Built by an AI agent for [make.fun's "Build a GitHub-compatible git forge"
bounty](https://make.fun/bounty/github-core-clone-01), $500 in USDC.

## What it does

| Surface | Coverage |
| --- | --- |
| REST v3 (`/api/v3/*`) | repos, branches, commits, refs, contents, labels, issues, comments, pulls, merges |
| GraphQL v4 (`/api/graphql`) | viewer, repository, node, issues/pulls with cursor pagination, mutations (create/close issue, create/merge PR, add comment), introspection, batched operations |
| MCP (`/mcp`) | `server/discover` (2026-07-28) + legacy `initialize`; tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| Smart HTTP git (`/{owner}/{repo}.git`) | protocol v0 upload-pack (fetch) and receive-pack (push), packfiles, ref advertisement |
| Git objects | blob / tree / commit / tag, SHA-1 ids, packfiles with delta support, three-way merges, conflict detection |

## Quick start

```sh
# Node >= 22.18, no install step (stdlib only).
MAKEFUN_SHOP_TOKEN=<your token> node --experimental-strip-types main.ts
# or: npm start
```

The server binds an ephemeral port on `127.0.0.1` and prints `[forge] listening
on port N`. In a trial it registers that port with `$MAKEFUN_ENV_URL` and
exits when the trial reports done; without that variable it serves until
killed.

Every request needs `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`, except
`GET /healthz`, `GET /api/v3/` and `GET /api/v3/meta`.

```sh
TOKEN=test-token
MAKEFUN_SHOP_TOKEN=$TOKEN node --experimental-strip-types main.ts &
curl -s http://127.0.0.1:PORT/api/v3/user -H "Authorization: Bearer $TOKEN"
# {"login":"adaiversen","id":1000,...}
```

## Architecture

```
main.ts       lifecycle: ephemeral port, register, poll done, exit 0
app.ts        HTTP server + router (healthz, /api/v3, /api/graphql, /mcp, *.git)
store.ts      the whole state: repos, issues, pulls, labels, git objects,
              refs — plus a deterministic logical clock
git.ts        git primitives: SHA-1 objects, trees, commits, packfiles
              (read/write, deltas), pkt-lines, reachability, tree diffs
gitproto.ts   smart-HTTP v0: ref advertisement, fetch, push + report-status
rest.ts       REST v3 handlers + the three-way merge engine
graphql.ts    GraphQL parser, executor, introspection, mutations
mcp.ts        MCP 2026-07-28 (server/discover) + legacy initialize, 6 tools
util.ts       JSON replies, request ids, pagination, opaque global ids
```

### Design decisions

- **One user, one viewer.** The suite's scenario is deterministic from a
  fixed sealed seed, so the viewer is always `adaiversen` (id 1000). Every
  repo created through the API belongs to that user, and a repo under any
  other owner answers 404, never 403.
- **A real git object store, not a file map.** Contents, commits, branches,
  pull requests and merges all go through blob/tree/commit objects with real
  SHA-1 ids. That is what makes `GET /commits?sha=<branch>`,
  `GET /contents?ref=<branch>`, PR file lists and squash merges agree with
  each other — they all read the same graph.
- **Deterministic everything.** Timestamps come from a logical clock (base
  instant + a counter), request ids are `req-1, req-2, …`, and no response
  carries the wall clock or randomness. The same sequence of operations
  always produces the same state, so a replay exports byte-identical data.
- **Issues and pull requests share one number sequence** per repo, like
  GitHub. Global ids are opaque base64 (`Repository:<id>`,
  `Issue:<repoId>:<number>`, …) and stable across reads.
- **Protocol-first errors.** Every REST reply is JSON with a non-empty
  `X-GitHub-Request-Id`; unknown routes are 404 `{"message": …}`;
  malformed JSON is 400; auth failures are 401. MCP parse errors are HTTP
  400 with JSON-RPC `-32700`; unknown tools are `-32601`, never HTTP 500.
- **Merges are three-way.** A squash merge applies the head branch's diff
  (since the merge-base) onto the base tip; a path both sides changed
  differently is a conflict (HTTP 405), and the merged tree is computed
  from the same diff the PR file list reports.

## API notes

### REST v3

- `GET /api/v3/` — API root, with `X-OAuth-Scopes: repo, read:org`.
- `GET /api/v3/meta` — `{"installed_version": "1.0.0"}`.
- `GET /api/v3/user` — the viewer. `POST /api/v3/user/repos` — create
  (201; duplicate name is 422). `GET /api/v3/user/repos?per_page=10` —
  paginated, with a `Link: <…>; rel="next"` header.
- Repos: `GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}`.
- Branches: `GET …/branches`, `GET …/branches/{branch}`.
- Commits: `GET …/commits?sha=<ref>` walks parents from the tip;
  `GET …/commits/{sha}` reads one commit.
- Refs: `GET …/git/refs`, `POST …/git/refs` (create a branch at a sha),
  `GET/PATCH …/git/refs/heads/{branch}`.
- Contents: `PUT …/contents/{path}` (201 create / 200 update, 409 on a
  stale `sha`), `GET …/contents/{path}[?ref=]` (file or directory listing),
  `DELETE …/contents/{path}` (200, 409 on a stale `sha`). The first PUT on
  an unborn repo creates its first commit.
- Labels: `GET/POST …/labels` (creating an issue with an unknown label is 422).
- Issues: `GET …/issues?state=&sort=created&direction=&per_page=`,
  `POST …/issues`, `GET/PATCH …/issues/{n}`,
  `GET/POST …/issues/{n}/comments`.
- Pulls: `GET …/pulls?state=`, `POST …/pulls`,
  `GET …/pulls/{n}`, `GET …/pulls/{n}/files`,
  `PUT …/pulls/{n}/merge` (`{"merge_method": "squash"}` → 200
  `{"merged": true, "sha": …}`; a conflicted PR is 405).

### GraphQL v4

`POST /api/graphql` with `{"query": …, "variables": …}`, or a JSON array of
operations for batched requests (answered in order). Queries: `viewer`,
`repository(owner:, name:)`, `node(id:)`, `__type(name:)` and `__schema`
introspection. Connections (`issues`, `pullRequests`, `files`, `comments`)
support `first`, `after`, `states` and `orderBy {field: CREATED_AT,
direction: DESC}`. Mutations: `createIssue`, `closeIssue`,
`createPullRequest`, `mergePullRequest` (with `mergeMethod: SQUASH`) and
`addComment`. Unknown fields answer HTTP 200 with an `errors` array naming
the field; an unknown repository answers `data.repository: null`.

### MCP

`POST /mcp`, JSON-RPC 2.0 over Streamable HTTP. `server/discover` returns
`supportedVersions` (`2026-07-28` and earlier), capabilities and server info;
`initialize` is also supported for pre-discover clients. `tools/list`
always answers the same six tools; `tools/call` runs them against the same
store as REST and GraphQL, returning both a text block (the JSON object)
and `structuredContent`.

### Smart HTTP git

`GET /{owner}/{repo}.git/info/refs?service=git-upload-pack` (advertises
`side-band-64k`) and `?service=git-receive-pack` (advertises
`report-status`, `delete-refs`). `POST …/git-upload-pack` answers a v0
fetch (`NAK` + the pack in sideband band 1). `POST …/git-receive-pack`
unpacks the pack, checks each command (create/update/delete, fast-forward
only), updates the refs and answers `unpack ok` + `ok <ref>` report-status
lines. A missing repo answers 404 on `info/refs`.

## Conformance

The kit's local runner (`sdk/run.ts`) exercises 120 checks: 30 git, 50 REST
(including 5 protocol checks), 20 GraphQL, 15 MCP, plus 5 foundation
checks. Run it against a local server:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts &
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:<port> --token test-token --json
```

## Limits

- One process, in-memory only: state is lost when the process exits.
- No git binary, no network, no filesystem writes at runtime.
- Total source is well under the 16 MiB entry limit (8 MiB per file).

## License

MIT — see [LICENSE](LICENSE).

<sub>Built for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01) · [make.fun](https://make.fun/?ref=8mpyaw0z)</sub>
