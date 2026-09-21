# @caveman-ai/router-claude-code

## Claude Code on your Claude subscription

```bash
npm i -g @caveman-ai/router-claude-code
caveman-router-hook login --url https://router.caveman.so --key crk_...
caveman-router-hook setup claude-code --statusline
```

This keeps your claude.ai login. Setup writes `env.ANTHROPIC_BASE_URL` and
`env.ANTHROPIC_CUSTOM_HEADERS` (`x-cave-api-key: <your router key>`) and never
touches `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, so Claude Code still
sends its OAuth bearer and Anthropic still bills your Pro/Max plan. The router
authenticates you on the header and forwards that bearer untouched for Claude
turns — it never stores the login token.

With a subscription, `auto` picks among Claude models by default: those turns
cost you nothing beyond the plan you already pay for. Only non-Claude models —
and only if you put them in your pool — cost money, through your own upstream
key. `caveman-router-hook model <name>` switches to a fixed model
(`google/gemini-3.7-flash`, `openrouter/deepseek/deepseek-v4-pro-0813`,
`anthropic/claude-sonnet-4.5`) or a shortlist (`auto:<a>,<b>`). The statusline
shows which model actually answered:

```
auto → deepseek-v4-pro-0813 · code:repo_scan · 14 turns · $0.31
```

If `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` is already set (in settings or
your shell), Claude Code uses it instead of the login and connectors stop
working; setup prints a warning naming it. Remove it to go back to the
subscription.

**Teams on API billing:** `setup claude-code --api-key` writes
`env.ANTHROPIC_AUTH_TOKEN` = your router key and no custom header. That bills
per token against the key and disables claude.ai connectors.

`setup claude-code` merges only its own keys (`env.ANTHROPIC_BASE_URL`, one of
`env.ANTHROPIC_CUSTOM_HEADERS` / `env.ANTHROPIC_AUTH_TOKEN`, `model`, and —
with `--statusline`, and only if you do not already have one — `statusLine`)
into `~/.claude/settings.json` (`--project` for `.claude/settings.json`). An
existing custom header of yours is kept; ours is appended on its own line and
never duplicated. It also installs the spawn hooks so subagents route too.
`teardown claude-code` removes exactly those, including only our header line.
Restart Claude Code after either. `caveman-router-hook status` prints the mode.

Same idea as [claude-code-router](https://github.com/musistudio/claude-code-router):
point Claude Code at an Anthropic-compatible endpoint and serve it from any
provider. The difference is who decides — routing here comes from the router's
classifier and cost model per turn, not static rules you maintain — and that
your subscription keeps paying for the Claude turns. Your prompts go to the
router either way: the [data notice](../../README.md) applies, and now to every
turn rather than only to subagent spawns. `caveman-router-hook off` only stops
the spawn hook — to stop sending turns, run `teardown claude-code`.

**Caveat.** Claude Code's own `/model` picker only lists Anthropic names. A
non-Anthropic model goes in through `caveman-router-hook model <name>` or the
`model` key in settings.json, not the picker.

## Subagent routing only

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
| `status` | URL, key presence, installed or not, Claude Code mode (`subscription` / `api-key` / `not set up`), measured p95 answer time. |
| `setup claude-code [--url U] [--key K] [--model M] [--api-key] [--statusline] [--project]` | Points Claude Code itself at the router, keeping your Claude subscription (see above); `--api-key` bills the router key instead. Installs the spawn hooks. |
| `teardown claude-code [--project]` | Removes exactly what `setup` wrote. |
| `model [NAME]` | Sets `settings.model`; with no NAME prints the configured one. |
| `statusline` | The statusLine command; Claude Code pipes the render JSON on stdin. |

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
