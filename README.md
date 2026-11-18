# git-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kubay06/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kubay06/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process. It serves
git smart HTTP (protocol v2 upload-pack, v0 receive-pack), the REST v3 API,
GraphQL v4, and a Model Context Protocol endpoint, all from its own
in-memory store — no git binary, no database, no network, no dependencies
beyond the Node standard library.

Built for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01):
"Build a GitHub-compatible git forge".

## What it does

- **Git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2:
  `ls-refs` with peel/symrefs/unborn/ref-prefix, `fetch` with
  want/have/shallow/deepen/thin-pack, sideband framing) and
  `git-receive-pack` (v0, report-status in sideband, per-ref
  fast-forward enforcement: a non-fast-forward ref is refused with
  `ng <ref> non-fast-forward` while the fast-forward refs in the same
  push still apply). Packfiles are built by hand: plain zlib objects,
  correct SHA-1 trailer, no deltas on the wire out.
- **REST v3** (`/api/v3`) — repositories (create/read/patch/delete,
  pagination with `Link` headers), branches, commits, git refs, contents
  (create/update/delete with sha checks, directories), labels, issues
  (create/list/get/patch/comments, label validation with 422), and pull
  requests (create/list/get/files/merge — squash merge lands the head
  tree on the base branch; conflicted merges answer 405).
- **GraphQL v4** (`/api/graphql`) — `viewer`, `repository` (with
  `issue`, `issues` with states/orderBy/cursor pagination,
  `pullRequests`, `pullRequest` with `files`), `node(id:)` Relay ids,
  `__type` introspection for `Issue`, `PullRequest`, `Repository` and
  `SearchType`, batched operations, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` (SQUASH) and `addComment`
  mutations. Unknown fields answer HTTP 200 with an `errors` array;
  an unknown repository answers `data.repository = null` with no errors.
- **MCP** (`/mcp`) — Streamable HTTP, modern revision 2026-07-28
  (`server/discover`) with a legacy `initialize` handshake fallback.
  Tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, plus `list_repos` and
  `get_issue`. The tools act on the same store as REST, with the same
  ids, so an object created over MCP reads back over REST unchanged.

## How it is built

- One process, one store: everything lives in RAM in `src/store.ts`
  (git objects, refs, issues, pull requests). A single monotonic
  counter drives every timestamp and ordering key, so a live run and
  its replay produce the same object ids.
- `src/git.ts` owns pkt-line framing, packfile encode/decode and the
  fetch planner (have/shallow/deepen honoured exactly, so incremental
  and shallow fetches only deliver what the client does not hold).
- `src/app.ts` owns the HTTP server and the REST + git routes.
  `src/graphql.ts` and `src/mcp.ts` own their two surfaces.
- `main.ts` owns the trial lifecycle only: bind an ephemeral port,
  register it with the env, poll `/done`, exit 0.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22 or later, no install step, no dependencies. The server needs
`MAKEFUN_ENV_URL` (the trial env) and `MAKEFUN_SHOP_TOKEN` (the bearer
token it accepts) in the trial; locally it also answers with any bearer
token when `MAKEFUN_SHOP_TOKEN` is unset. `MAKEFUN_FORGE_LOGIN`
overrides the viewer login (default `adaiversen`, the scenario viewer).

## Local conformance

Against the kit's own suite (`sdk/run.ts --perf`):

- **120/120 checks** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15.
- **Feature 600, agent 200, perf 186 — total 986/1000** on a local
  run (push 43, clone 44, read 49, write 50; `perf_p50_us` ~242k
  against the house reference's ~806k).

## License

MIT. See [LICENSE](LICENSE).

---

Built with [make.fun](https://make.fun/r/18a0yax6) — referral code `18a0yax6`.
