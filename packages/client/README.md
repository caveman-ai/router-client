# @caveman-ai/router-client

Client for the Caveman Router decision API. ESM, types included, zero runtime
dependencies, Node ≥ 20 (uses the global `fetch`).

```bash
npm i @caveman-ai/router-client
```

```ts
import { RouterClient } from "@caveman-ai/router-client";

const router = new RouterClient({
  url: process.env.ROUTER_URL,        // default https://router.caveman.so
  apiKey: process.env.ROUTER_API_KEY, // sent as x-cave-api-key
  sessionId: "sess-1",                // optional, scopes an ask id to a session
  userHash: "u_9f…",                  // optional
  slider: "balanced",                 // optional default: cheapest|cheaper|balanced|careful|never_cheaper
  timeoutMs: 10_000,
});

const answer = await router.delegate({
  parent: { model: "claude-opus-5", context_tokens: 233_031, turn: 12 },
  task: { prompt: "find every caller of routerPost", agent: "explore", model: "opus" },
  harness: { kind: "claude-code" },
}, { budgetMs: 2000 });

if (answer.ok && answer.data.decision === "delegate") {
  console.log(answer.data.delegate.model, answer.data.line);
}
```

## API

| Method | Endpoint |
| --- | --- |
| `route(req, opts?)` | `POST /v1/route` — pick a model for one request. |
| `task(req, opts?)` | `POST /v1/route/task` — pick model and effort for one ask. |
| `delegate(req, opts?)` | `POST /v1/route/delegate` — inline or spawn, and on which model. |
| `outcome(token, kind, opts?)` | `POST /v1/route/outcomes` — `retry \| test_pass \| test_fail \| abandoned \| completed`. |
| `delegateOutcome(decisionId, child, opts?)` | `POST /v1/route/delegate/outcomes` — what the child actually cost. |

Every method resolves to `{ ok: true, data }` or `{ ok: false, reason }` and
**never throws** on a network error, a timeout, a 5xx or a missing key. A
harness that gets no answer must be able to change nothing without catching
anything. `reason` is one of `no_api_key`, `no_budget`, `timeout`, `network`,
`bad_body`, `http_<status>`.

`opts.budgetMs` is the caller's remaining deadline. It travels as
`x-cave-budget-ms` — the router shortens its classifier call to fit — and aborts
the request at the same instant.

For coding agents, pass routing mode `agent` and an optional repository profile:
`route({ ..., mode: "agent", repo: { files: 1240, languages: ["go"] } })`, or
`repo` on `delegate(...)`. A delegate answer may carry an advisory
`orchestrator` (`{ model, effort, reason, applied: false }`) — a recommendation
for the parent, never applied by the router.

The wire types (`RouteResponse`, `TaskResponse`, `DelegateResponse`, …) are
exported from the package root and mirror the server structs field for field.
