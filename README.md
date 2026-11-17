# lumenforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arronf2e/lumenforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arronf2e/lumenforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Lumenforge is a GitHub-compatible git forge in a single dependency-free Node
process (standard library only, no git binary). One in-memory store is shared
by four surfaces, so an object created through any of them is the same object
through all the others:

- **git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch with shallow
  and deepen) with a v0 fallback, and receive-pack v0 with report-status;
  packs are built and parsed in-process, objects are content-addressed with
  SHA-1 exactly as git computes them.
- **REST API v3** — repositories, branches, git refs, the contents API,
  commits, labels, issues with comments, and pull requests with three-way
  merges (merge and squash), all behind the one bearer token.
- **GraphQL v4 subset** — viewer, repository, issue and pull request queries
  with connections and cursors, introspection probes, node(id:) lookups, and
  the create/close issue, create/merge pull request and add comment mutations.
- **MCP endpoint** — JSON-RPC at /mcp speaking both the server/discover
  revision and the legacy initialize handshake, with the six GitHub tools
  (create/get repository, create/list issues, create/merge pull request).

State is deterministic: a logical clock stamps every mutation, so replaying
the same request stream reproduces the same bytes.

## Run it

```sh
MAKEFUN_ENV_URL=<trial environment url> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with the trial environment,
serves until the environment reports done, and exits.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g0z5v85z&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
