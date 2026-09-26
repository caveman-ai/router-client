# Caveman Router: client, harness adapters and setup

The Caveman Router decides which model an agent should spend a request on.
This repository is the open-source harness side of it: the adapters that
connect Claude Code, Codex and OpenCode to `caveman-routerd` (the local
routing daemon), a one-command setup, a TypeScript client for the router API,
and the original Claude Code subagent hook.

- [`@caveman-ai/router-setup`](packages/setup): `caveman-router setup` / `teardown`, and the hook entry points.
- [`@caveman-ai/router-client`](packages/client): the router API client and the `caveman-routerd` control-socket client.
- [`@caveman-ai/router-claude-code`](packages/claude-code-hook): the Claude Code hook.
- [`@caveman-ai/router-codex`](packages/codex-hook): the Codex hook.
- [`packages/claude-code-plugin`](packages/claude-code-plugin): the Claude Code hooks as a plugin.

## Use any model in Claude Code, Codex and OpenCode

`caveman-routerd` runs on your machine. Each harness sends its model traffic
to it on `127.0.0.1:47821`, and it forwards every request straight to the
provider with your own credentials. On each new ask it picks the model from a
pool you choose, and hooks in the harness tell it what the proxy cannot see.
Model traffic never goes through Caveman.

```bash
npm i -g @caveman-ai/router-setup
caveman-router setup
```

Setup asks which harnesses to set up, how you reach Claude (your claude.ai
subscription, an API key, or neither), whether you have OpenAI and OpenRouter
keys, which models to route between (a preset, or ids such as
`anthropic/claude-sonnet-5,openai/gpt-6-astra`) and the routing mode. Then it:

1. checks that `caveman-routerd` is on your PATH (it ships separately; setup
   never downloads binaries);
2. stores each API key with `caveman-routerd keys set <provider>`, over stdin;
3. writes the pool, the mode and the subscription switches with
   `caveman-routerd config set`;
4. runs `caveman-routerd install-service` (launchd or systemd) and waits for
   the daemon to answer;
5. configures each harness (below);
6. prints what it changed and a one-line test command.

For scripts: `caveman-router setup --yes --harness claude-code,codex,opencode|all
--preset frontier|balanced|cheap` (or `--models <ids>`) `--claude
subscription|key|none --openai key|none --openrouter key|none --mode
agent|balanced|cost-efficient`. Keys then come from `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` and `OPENROUTER_API_KEY`. `--context-window <tokens>` sets
the window Claude Code assumes for `auto` when the daemon cannot report one.
Running setup again is safe: it changes only what differs.

### What is stored where

| Where | What |
| --- | --- |
| Your OS keychain (via `caveman-routerd`) | Provider API keys. Never in a harness file, never on a command line. |
| `~/.caveman/` | The daemon's config, its local token and its socket; `router-setup.json` records what setup changed. |
| `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_CUSTOM_HEADERS` (the local token and routing mode), `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, `model: "auto"`, hooks, and a statusline wrapper that still runs your own statusline. With non-Claude models in the pool: one `/model` picker entry and `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`. With `--claude key`: `apiKeyHelper: "caveman-routerd token"`. |
| `~/.codex/caveman.config.toml` | A Codex profile of its own: the `caveman` provider (its token comes from `caveman-routerd codex-auth`), `model = "auto"` and the hooks. Use `codex --profile caveman`. Your `config.toml` is not edited. |
| `~/.config/opencode/opencode.json`, `plugins/caveman-router.js` | The `caveman` provider (`apiKey: "{file:~/.caveman/routerd.token}"`) and a plugin that adds the token header and tags requests with the session. Pick `caveman/auto`. |

The local token (`~/.caveman/routerd.token`) grants use of the local proxy,
and so of the provider keys the daemon holds: treat it like a key. Only
`~/.claude/settings.json` holds a copy (Claude Code has no other way to send
the header the proxy requires). Codex gets it from `caveman-routerd codex-auth`
and OpenCode reads it from its file. Files setup creates, and every backup,
are `0600`; a file it edits keeps its mode.

The hooks give the daemon the first 500 characters of each ask, subagent
prompts, the statusline JSON and a repository profile (counts and language
names, no paths). The daemon sends the hosted router what it needs to decide;
with `zdr = true` in its config it sends only computed features, no text. Every file setup edits is backed up first
as `<file>.caveman-backup-<time>`.

### Subscriptions

- **Claude subscription:** works in Claude Code, unmodified. The daemon passes
  the login Claude Code sends straight through to Anthropic. Setup never
  reads, copies or stores it. In Codex and OpenCode, Claude models need an
  API key.
- **ChatGPT subscription:** use it in Codex the normal way. Routing it
  anywhere else is unclear under OpenAI's terms, so it stays off. Setup never
  reads `~/.codex/auth.json`.
- **API keys:** any model, in any harness.

`--openai subscription` and `--claude-cli-adapter` only flip the daemon's
`subscriptions.chatgpt` and `subscriptions.claude_cli_adapter` switches; the
daemon does not act on either yet.

### Undo

```bash
caveman-router teardown                # every harness, plus the service and the keys setup stored
caveman-router teardown --harness codex
```

A file nobody touched since setup gets its original bytes back. A file you
edited since keeps your edits and loses only setup's keys. Restart the
harnesses afterwards.

### When the daemon is down

Hooks give up after 50 ms (500 ms for the session-start check, 2 s when
choosing a subagent's model) and the harness carries on. But requests to `127.0.0.1:47821` fail until the
daemon is back, so Claude Code shows "Caveman routing is off" at session start
when it cannot reach it. `caveman-routerd install-service` restarts it;
`caveman-router teardown` takes the harnesses off it.

### Known limits

- Codex needs a Codex CLI with profile files (`<name>.config.toml`; checked
  with 0.156) and a `caveman-routerd` build that serves the Responses API.
  Codex asks you to trust the new hooks on its next start.
- Codex applies the model and effort the hook picks for `spawn_agent`
  (checked end to end with Codex 0.156.1). The model must be an id in the
  catalog Codex loaded from the daemon's `/models`; Codex rejects any other
  id and that spawn fails, so the daemon must only answer with ids it lists.
- OpenCode's per-turn model setting (`CAVEMAN_OPENCODE_SET_MODEL=1`) is
  experimental: it is read from OpenCode's source and has not been run
  against a live OpenCode turn.
- Claude Code's Agent tool takes `opus`, `sonnet`, `haiku` or `fable`, so
  subagents are steered between Claude models only.

## Claude Code subagent hook (hosted router)

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
