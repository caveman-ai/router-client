# Contributing

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Node 20 or newer, pnpm 10. No runtime dependencies in either package — that is a hard
rule, not a preference: the hook runs on every subagent spawn and must start in
milliseconds. Dev dependencies are `typescript` and `@types/node`.

The wire types live in `packages/client/src/types.ts` and mirror the router
server's structs. Change them only to follow a server change.

The hook must exit 0 and print nothing on any failure. If you add a path that
can throw, prove with a test that it still prints nothing.
