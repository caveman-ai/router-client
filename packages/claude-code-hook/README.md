# @caveman-ai/router-claude-code

The Caveman Router subagent hook for Claude Code. Every `Agent`/`Task` spawn is
routed to the cheapest model that can do the job; every finished subagent
reports what it actually cost.

```bash
npm i -g @caveman-ai/router-claude-code
caveman-router-hook login --key <your router key>
caveman-router-hook install
```

## Commands

| Command | What it does |
| --- | --- |
| `caveman-router-hook` | The hook itself; Claude Code runs this with the event JSON on stdin. |
| `install [--project]` | Adds the two hook entries to `~/.claude/settings.json` (or `.claude/settings.json`). Idempotent. |
| `uninstall [--project]` | Removes them, leaving every other hook alone. |
| `login --url <url> --key <key>` | Writes `~/.config/caveman-router/config.json` (mode 0600). |
| `on` / `off` | Persistent routing switch. |
| `status` | URL, key presence, installed or not, measured p95 answer time. |

`install` writes exactly:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Agent|Task", "hooks": [{ "type": "command", "command": "caveman-router-hook" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "caveman-router-hook" }] }]
  }
}
```

## Behaviour

**PreToolUse.** Reads the tail of the parent transcript for the numbers the cost
model needs (context tokens, cache reads, turn, children already running), asks
`POST /v1/route/delegate`, and on a `delegate` answer emits

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"…":"…","model":"sonnet"}},"systemMessage":"Caveman · subagent on Sonnet 5 instead of Opus 5 · est. $0.84 vs $1.72 · code search"}
```

`systemMessage` reaches you, never the model. A spawn the router leaves alone
prints nothing. A model written into the agent definition's frontmatter is
reported to the router as a human's declaration; the alias the model in the loop
wrote is not.

**SubagentStop.** Reads the child transcript named by `agent_transcript_path`,
links it to the decision through `<session>/subagents/agent-<id>.meta.json`
(`toolUseId`), and posts the measured usage to
`POST /v1/route/delegate/outcomes`.

**Failure is silence.** No key, no usage line in the transcript, a slow router, a
5xx, an unparsable reply, an unwritable home: exit 0, no stdout, spawn runs as
proposed. The whole hook fits in a 2500 ms budget (`ROUTER_BUDGET_MS` lowers it).

**No deny by default.** The router may report that a task is cheaper done
inline; the hook acts on that only with `ROUTER_VETO=1`, at most once per
session, and only when the router supplied the sentence explaining what to do
instead.

Environment variables and the data notice are in the [repository README](../../README.md).
