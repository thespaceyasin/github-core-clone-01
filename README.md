# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thespaceyasin/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thespaceyasin/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in TypeScript (standard library only): REST v3, GraphQL, MCP tools and git smart HTTP, all in memory and deterministic. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

The entry binds an ephemeral port, registers it with the environment, then serves until the environment says the trial is done. `MAKEFUN_SHOP_TOKEN` is the Bearer token the API surfaces expect; when it is unset, authentication is disabled (local development only).

## What it serves

- **REST v3** (`/api/v3`): repositories, branches, commits, contents (create/update/delete with sha checks), labels, issues, pull requests with squash merge and conflict detection.
- **GraphQL** (`/api/graphql`): `viewer`, `repository` (with `issues`/`pullRequests` connections and cursor pagination), `node` by Relay id, `__type` introspection, and the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 via `server/discover`, with the tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and `merge_pull_request`, all sharing the same store as REST.
- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (plus a v0 fallback), receive-pack v0 with report-status, fast-forward-only pushes, and a packfile reader/writer written from scratch on the standard library (zlib + sha1, no git binary).

## Design notes

- **Everything is in memory.** The store lives in a single `Store` (`store.ts`): repositories, git objects, refs, issues, pull requests, labels and comments. Nothing is written to disk, so a trial's state is exactly what the requests built.
- **Deterministic.** No wall-clock time and no unseeded randomness enters stored state: server-made commits take their timestamps from a fixed epoch plus a per-repository counter, so the same requests in the same order always build the same objects and a replayed trial exports byte-identical state.
- **Thin packs.** A fetch sends only the objects the client does not already hold (reachable from its `haves`, stopping at shallow boundaries), so incremental fetches and `deepen` work as git clients expect.
- **One store, four surfaces.** REST, GraphQL, MCP and git smart HTTP all read and write the same store, so a repository created over MCP reads back over REST and a branch pushed over git is visible to GraphQL.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4dhdkr5y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
