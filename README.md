# Caveman Router — client and Claude Code hook

The Caveman Router decides which model an agent should spend a request on. This
repository is the open-source harness side of it: a TypeScript client for the
router API, and a Claude Code hook that uses it to pick the model for every
subagent you spawn.

The router itself is a hosted service (`https://router.caveman.so`). These
packages only call it.

- [`@caveman-ai/router-client`](packages/client) — the API client.
- [`@caveman-ai/router-claude-code`](packages/claude-code-hook) — the Claude Code hook.

## 60-second install (Claude Code)

```bash
npm i -g @caveman-ai/router-claude-code
caveman-router-hook login --key <your router key>
caveman-router-hook install
```

That writes two entries into `~/.claude/settings.json`: a `PreToolUse` hook
scoped to `Agent|Task`, and a `SubagentStop` hook. Nothing else changes. Start a
Claude Code session and spawn a subagent; when the router moves it to a cheaper
model you get one line:

```
Caveman · subagent on Sonnet 5 instead of Opus 5 · est. $0.84 vs $1.72 · code search
```

That line is shown to you, not to the model. A spawn the router leaves alone
says nothing at all.

`caveman-router-hook status` prints the URL, whether a key is set, whether the
hook is installed, and the measured p95 of its own answer time.
`caveman-router-hook off` turns routing off; `uninstall` removes the hook.

## Environment

| Variable | Meaning |
| --- | --- |
| `ROUTER_URL` | Router base URL. Default `https://router.caveman.so`. |
| `ROUTER_API_KEY` | Router key, sent as `x-cave-api-key`. |
| `ROUTER_OFF=1` | Route nothing for this session. |
| `ROUTER_VETO=1` | Let the hook deny a spawn the router says is cheaper inline (at most once per session). Off by default: the hook rewrites, it does not block. |
| `ROUTER_BUDGET_MS` | Lower the hook's 2500 ms wall-clock budget. |
| `ROUTER_AGENT_POOL` | Comma-separated Claude families the router may pick a subagent from (`opus,sonnet`). It narrows the newest Haiku, Sonnet and Opus by family name; the child policy stays on. A list naming none of them is ignored (the reply's reason is `agent_policy_default_pool`). Unset, all three. |
| `CAVEMAN_ROUTER_HOME` | State directory. Default `~/.config/caveman-router`. |

Env wins, then `~/.config/caveman-router/config.json` (written by
`caveman-router-hook login`), then the default.

## Use it from any OpenAI SDK

You do not need this package to use the router from an application. Point
any OpenAI-compatible SDK at it and ask for `model: "auto"`; the router picks
a model from your pool and forwards the request to OpenRouter or the upstream
the operator configured. Works for GPT, Claude, Gemini, DeepSeek, Grok,
Mistral, Qwen and anything else OpenRouter serves.

```python
from openai import OpenAI
client = OpenAI(base_url="https://router.caveman.so/v1", api_key="crk_...")
r = client.chat.completions.create(
    model="auto:openai/gpt-5.6,anthropic/claude-sonnet-4.5,google/gemini-3.7-flash",
    messages=[{"role": "user", "content": "…"}],
    extra_headers={"x-upstream-key": "sk-or-..."},   # your own OpenRouter key
)
print(r.model)
```

## Agent routing mode

Coding agents are routed as a session, not as isolated prompts. Ask for it with
routing mode `agent` (alongside `balanced` and `cost-efficient`): as `mode` on
`POST /v1/route`, under `routing` on a proxy request body, or with the header
`x-cave-routing-mode: agent`. Optionally describe the repository with a `repo`
object — `routing.repo` in a body, or `x-cave-repo-profile: <compact JSON, at
most 1 KiB>` as a header:

```json
{"files": 1240, "bytes": 18400000, "languages": ["go", "typescript"], "test_files": 310, "touched_files": 3, "touched_dirs": 2}
```

Every field is optional; `languages` holds at most 16 short lowercase names.
`setup claude-code` sends the mode header for you; the spawn hook sends `repo`
on every subagent decision.

The Claude Code hook is different: with `setup claude-code` it keeps your
claude.ai login, so Claude turns stay on your Pro/Max subscription and the
router chooses among Claude models unless you put others in your pool. See
[the hook README](packages/claude-code-hook/README.md).

## What gets sent, and what is kept

On every subagent spawn the hook sends the router:

- the subagent's prompt, description and `subagent_type`;
- the model your harness proposed, and whether it came from the agent
  definition's frontmatter;
- the parent session's token counts (context, cache reads), its turn number, its
  model, and how many children are already running;
- a repository profile: the number of committed files, their total size in
  bytes, the top languages by file count (names only), how many files look like
  tests, and how many distinct files and directories the session has edited.
  It is computed locally from `git ls-tree` and the transcript; no file path and
  no file content is sent.

On `SubagentStop` it sends the child's measured token usage, turn count and tool
call count against the decision id.

It does not read or send your file contents, file paths, tool outputs or transcript text — only the prompt the parent model wrote for the subagent, which may itself quote code.

**Data notice.** Prompts and tool inputs sent to the router are retained, after
automatic redaction of secrets and personal data, and are used to improve
routing. If that is not acceptable, do not install the hook — or run
`caveman-router-hook off`, which stops all traffic to the router.

## Design rules this code follows

- **An actuator that gets no answer changes nothing.** No key, a slow router, a
  5xx, an unparsable reply: the hook exits 0, prints nothing, and your spawn runs
  exactly as your harness proposed.
- **The budget is real.** The whole hook — transcript read, frontmatter read,
  router call — fits in 2500 ms. The remaining budget travels as
  `x-cave-budget-ms` so the router shortens its own classifier call to fit.
- **The line is for the human.** Routing lines go out as `systemMessage`, which
  never enters the model's context.
- **No deny by default.** The router reports that a task would be cheaper inline;
  only `ROUTER_VETO=1` lets the hook act on it, and only once per session.

Apache-2.0.
