# Caveman Router Client (`caveman-ai/router-client`)

Open-source harness side of the Caveman Router: TypeScript API client
(`@caveman-ai/router-client`) and Claude Code subagent model-routing hook
(`@caveman-ai/router-claude-code`).

Published npm releases of `@caveman-ai/router-claude-code` and the unified
`@caveman-ai/sdk/router` client also ship from
[caveman-ai/cloud-sdk](https://github.com/caveman-ai/cloud-sdk).

`CLAUDE.md` is a symlink to this file.

## Layout

| Path | Package |
|---|---|
| `packages/client/` | `@caveman-ai/router-client` — zero-dep TypeScript client for `router.caveman.so` |
| `packages/claude-code-hook/` | `@caveman-ai/router-claude-code` — `PreToolUse` / `SubagentStop` hook CLI (`caveman-router-hook`) |
| `.github/workflows/ci.yml` | Build and test CI |

## Checks

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## Invariants

- **Fail open on every error.** Missing key, timeout, 5xx, or invalid reply exits 0 and prints nothing so the caller's spawn proceeds unchanged.
- **2500 ms wall-clock budget.** Forward remaining budget via `x-cave-budget-ms`.
- **No credential leaks on redirects.** Reject redirects carrying router auth headers.
- **Public repo.** Never add private router server internals or credentials.
