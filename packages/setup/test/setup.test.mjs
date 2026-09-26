import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { daemonReplies, fakeDaemon } from "../../client/test/fake-daemon.mjs";
import { TOKEN, box, calls, run, snapshot, stdinOf } from "./helpers.mjs";

const OPENAI_KEY = "sk-test-NEVER-IN-A-HARNESS-FILE-4242";
const ANTHROPIC_KEY = "sk-ant-test-NEVER-IN-A-HARNESS-FILE-4343";

const USER_SETTINGS = JSON.stringify({
  permissions: { allow: ["Bash(ls)"] },
  env: { FOO: "bar", ANTHROPIC_CUSTOM_HEADERS: "X-Team: blue" },
  statusLine: { type: "command", command: "sh ~/.claude/mine.sh", padding: 1 },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }] },
}, null, 2) + "\n";

const USER_TOML = `# my codex config
model = "gpt-5.5"   # default model

[model_providers.work]
name = "Work gateway"
base_url = "https://gw.example/v1"
wire_api = "responses"

[profiles.work]
model_provider = "work"
instructions = """
[model_providers.caveman]
this is a string, not a table
"""
`;

const USER_CODEX_HOOKS = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } }, null, 2) + "\n";
const USER_OPENCODE = JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { mine: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://x" } } } }, null, 2) + "\n";

function seed(env) {
  writeFileSync(join(env.home, ".claude", "settings.json"), USER_SETTINGS);
  writeFileSync(join(env.home, ".codex", "config.toml"), USER_TOML);
  writeFileSync(join(env.home, ".codex", "hooks.json"), USER_CODEX_HOOKS);
  writeFileSync(join(env.home, ".config", "opencode", "opencode.json"), USER_OPENCODE);
}

const SETUP = ["setup", "--yes", "--harness", "all", "--preset", "balanced", "--claude", "subscription", "--openai", "key", "--mode", "agent"];
const read = (env, ...parts) => readFileSync(join(env.home, ...parts), "utf8");
const backups = (dir) => readdirSync(dir).filter((name) => name.includes(".caveman-backup-"));

test("setup configures all three harnesses, is idempotent, and teardown restores every byte", { timeout: 60_000 }, async () => {
  const env = box();
  seed(env);
  const daemon = await fakeDaemon(env.home, daemonReplies());
  try {
    // Pool windows as a daemon that reports them would; the real one lists ids only.
    const out = await run(env, SETUP, { extraEnv: { OPENAI_API_KEY: OPENAI_KEY, FAKE_POOL_WINDOWS: "1" } });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /try: claude -p/);

    // --- the daemon, driven only through its CLI
    const argv = calls(env.home);
    // Config before the service: the daemon reads it at start.
    assert.deepEqual(argv.map((args) => args[0]), ["keys", "config", "config", "config", "config", "config", "install-service", "token", "status"]);
    assert.deepEqual(stdinOf(env.home), [{ args: ["keys", "set", "openai"], input: OPENAI_KEY }], "the key went over stdin, once");
    assert.ok(argv.every((args) => !args.join(" ").includes(OPENAI_KEY)), "never on argv");
    assert.deepEqual(argv.filter((args) => args[0] === "config"), [
      ["config", "set", "mode", "agent"],
      ["config", "set", "pool.models", JSON.stringify(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5", "openai/gpt-6-astra", "openai/gpt-5.6-sol"])],
      ["config", "set", "subscriptions.chatgpt", "false"],
      ["config", "set", "subscriptions.claude_cli_adapter", "false"],
      ["config", "set", "providers.anthropic.auth", "passthrough"],
    ]);

    // --- Claude Code
    const settings = JSON.parse(read(env, ".claude", "settings.json"));
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    assert.equal(settings.env.FOO, "bar");
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47821");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, `X-Team: blue\nx-caveman-local-token: ${TOKEN}\nx-cave-routing-mode: agent`);
    assert.equal(settings.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "272000", "smallest window in the pool");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "openai/gpt-6-astra");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined, "subscription mode never sets a credential");
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(settings.model, "auto");
    const prev = Buffer.from("sh ~/.claude/mine.sh").toString("base64url");
    assert.deepEqual(settings.statusLine, { type: "command", command: `caveman-router statusline --prev ${prev}`, padding: 1 });
    assert.deepEqual(settings.hooks.PreToolUse[0], { matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }, "the user's hook stays first");
    assert.deepEqual(settings.hooks.PreToolUse[1], { matcher: "Agent|Task", hooks: [{ type: "command", command: "caveman-router hook claude-code", timeout: 10 }] });
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"]) assert.equal(settings.hooks[event].length, 1, event);

    // --- Codex: config.toml and hooks.json untouched, one profile file of ours
    assert.equal(read(env, ".codex", "config.toml"), USER_TOML);
    assert.equal(read(env, ".codex", "hooks.json"), USER_CODEX_HOOKS);
    const profile = read(env, ".codex", "caveman.config.toml");
    assert.match(profile, /^# >>> caveman-router/);
    assert.match(profile, /\nmodel_provider = "caveman"\nmodel = "auto"\n/);
    assert.match(profile, /\[model_providers\.caveman\]\nname = "Caveman \(local router\)"\nbase_url = "http:\/\/127\.0\.0\.1:47821\/v1"\nwire_api = "responses"\nauth = \{ command = "caveman-routerd", args = \["codex-auth"\] \}\n/);
    assert.match(profile, new RegExp(`http_headers = \\{ "x-caveman-local-token" = "${TOKEN}", "x-cave-routing-mode" = "agent" \\}`));
    assert.match(profile, /\[\[hooks\.PreToolUse\]\]\nmatcher = "spawn_agent"\n\[\[hooks\.PreToolUse\.hooks\]\]\ntype = "command"\ncommand = "caveman-router hook codex"\ntimeout = 10\n/);
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStop", "Stop", "Interrupt"]) assert.match(profile, new RegExp(`\\[\\[hooks\\.${event}\\]\\]`));

    // --- OpenCode
    const opencode = JSON.parse(read(env, ".config", "opencode", "opencode.json"));
    assert.equal(opencode.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(opencode.provider.mine, { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://x" } });
    const caveman = opencode.provider.caveman;
    assert.equal(caveman.npm, "@ai-sdk/anthropic");
    assert.deepEqual(caveman.options, { baseURL: "http://127.0.0.1:47821/v1", apiKey: TOKEN, headers: { "x-caveman-local-token": TOKEN, "x-cave-routing-mode": "agent" } });
    // A Claude subscription does not reach OpenCode: only the OpenAI models.
    assert.deepEqual(Object.keys(caveman.models), ["auto", "openai/gpt-6-astra", "openai/gpt-5.6-sol"]);
    assert.deepEqual(caveman.models.auto.limit, { context: 272000, output: 64000 });
    const plugin = read(env, ".config", "opencode", "plugins", "caveman-router.js");
    assert.match(plugin, /export const CavemanRouter/);

    // --- no key in any harness file
    const after = snapshot(env.home);
    for (const [path, text] of Object.entries(after)) {
      if (path.startsWith("routerd-")) continue;
      assert.ok(!text.includes(OPENAI_KEY), `key leaked into ${path}`);
    }

    // --- idempotent: same bytes, no new backups
    const backupCount = backups(join(env.home, ".claude")).length + backups(join(env.home, ".codex")).length;
    assert.equal(backupCount, 1, "one backup per pre-existing edited file (only settings.json is edited there)");
    const again = await run(env, SETUP, { extraEnv: { OPENAI_API_KEY: OPENAI_KEY, FAKE_POOL_WINDOWS: "1" } });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /already set up/);
    const second = snapshot(env.home);
    for (const path of Object.keys(after).filter((path) => !path.startsWith("routerd-") && !path.endsWith("router-setup.json"))) {
      assert.equal(second[path], after[path], `${path} changed on re-run`);
    }
    assert.equal(backups(join(env.home, ".claude")).length + backups(join(env.home, ".codex")).length, 1, "no new backups on re-run");

    // --- teardown: original bytes back, created files gone
    const down = await run(env, ["teardown"]);
    assert.equal(down.code, 0, down.stderr);
    assert.equal(read(env, ".claude", "settings.json"), USER_SETTINGS);
    assert.equal(read(env, ".codex", "config.toml"), USER_TOML);
    assert.equal(read(env, ".codex", "hooks.json"), USER_CODEX_HOOKS);
    assert.equal(existsSync(join(env.home, ".codex", "caveman.config.toml")), false);
    assert.equal(read(env, ".config", "opencode", "opencode.json"), USER_OPENCODE);
    assert.equal(existsSync(join(env.home, ".config", "opencode", "plugins", "caveman-router.js")), false);
    const tail = calls(env.home).slice(-2);
    assert.deepEqual(tail, [["keys", "rm", "openai"], ["uninstall-service"]]);
  } finally {
    await daemon.close();
  }
});

test("teardown after the user edited a file keeps their edit and takes out only ours", { timeout: 60_000 }, async () => {
  const env = box();
  seed(env);
  const daemon = await fakeDaemon(env.home, daemonReplies());
  try {
    assert.equal((await run(env, SETUP, { extraEnv: { OPENAI_API_KEY: OPENAI_KEY } })).code, 0);
    const path = join(env.home, ".claude", "settings.json");
    const edited = JSON.parse(readFileSync(path, "utf8"));
    edited.permissions.allow.push("Bash(git status)");
    writeFileSync(path, JSON.stringify(edited, null, 2) + "\n");
    // Codex records hook trust in the active profile file; it survives a re-run.
    const profilePath = join(env.home, ".codex", "caveman.config.toml");
    const trust = '\n[hooks.state."caveman:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n';
    writeFileSync(profilePath, readFileSync(profilePath, "utf8") + trust);
    assert.equal((await run(env, SETUP, { extraEnv: { OPENAI_API_KEY: OPENAI_KEY } })).code, 0);
    assert.ok(readFileSync(profilePath, "utf8").endsWith(trust), "Codex's trust records kept");

    assert.equal((await run(env, ["teardown", "--harness", "claude-code,codex"])).code, 0);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(settings, { ...JSON.parse(USER_SETTINGS), permissions: { allow: ["Bash(ls)", "Bash(git status)"] } });
    assert.equal(existsSync(profilePath), false, "the profile is wholly ours, trust records and all");
    assert.equal(calls(env.home).some((args) => args[0] === "uninstall-service"), false, "a harness-scoped teardown leaves the daemon");
  } finally {
    await daemon.close();
  }
});

test("--claude key: Claude Code gets the LOCAL token, the Anthropic key only reaches the daemon", { timeout: 60_000 }, async () => {
  const env = box();
  const daemon = await fakeDaemon(env.home, daemonReplies());
  try {
    const out = await run(env, ["setup", "--yes", "--harness", "claude-code,opencode", "--preset", "cheap", "--claude", "key"], { extraEnv: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
    assert.equal(out.code, 0, out.stderr);
    const settings = JSON.parse(read(env, ".claude", "settings.json"));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, TOKEN);
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "an all-Claude pool needs no window override");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
    assert.deepEqual(stdinOf(env.home), [{ args: ["keys", "set", "anthropic"], input: ANTHROPIC_KEY }]);
    assert.match(out.stdout, /skipped +openai\/gpt-5.6-sol/);
    // With a key, Claude models reach OpenCode too.
    assert.deepEqual(Object.keys(JSON.parse(read(env, ".config", "opencode", "opencode.json")).provider.caveman.models), ["auto", "anthropic/claude-sonnet-5"]);
    for (const [path, text] of Object.entries(snapshot(env.home))) {
      if (!path.startsWith("routerd-")) assert.ok(!text.includes(ANTHROPIC_KEY), `key leaked into ${path}`);
    }
    // Switching back to the subscription takes the token credential out again.
    assert.equal((await run(env, ["setup", "--yes", "--harness", "claude-code", "--preset", "cheap", "--claude", "subscription"])).code, 0);
    assert.equal(JSON.parse(read(env, ".claude", "settings.json")).env.ANTHROPIC_AUTH_TOKEN, undefined);
    // Files setup created are removed by teardown.
    assert.equal((await run(env, ["teardown"])).code, 0);
    assert.equal(existsSync(join(env.home, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(env.home, ".config", "opencode", "opencode.json")), false);
  } finally {
    await daemon.close();
  }
});

test("a caveman provider or legacy profile the user wrote stops the Codex setup", { timeout: 60_000 }, async () => {
  const env = box();
  const mine = `[model_providers.caveman]\nbase_url = "http://mine"\n`;
  writeFileSync(join(env.home, ".codex", "config.toml"), mine);
  const daemon = await fakeDaemon(env.home, daemonReplies());
  try {
    const out = await run(env, ["setup", "--yes", "--harness", "codex", "--preset", "cheap", "--openai", "key"], { extraEnv: { OPENAI_API_KEY: OPENAI_KEY } });
    assert.equal(out.code, 1);
    assert.match(out.stderr, /already has \[model_providers\.caveman\]/);
    assert.equal(read(env, ".codex", "config.toml"), mine);
    assert.equal(existsSync(join(env.home, ".codex", "caveman.config.toml")), false);
  } finally {
    await daemon.close();
  }
});

test("no caveman-routerd on PATH: install instructions, nothing touched", async () => {
  const env = box();
  seed(env);
  const before = snapshot(env.home);
  const out = await run(env, SETUP, { withDaemon: false, extraEnv: { OPENAI_API_KEY: OPENAI_KEY } });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /caveman-routerd is not on your PATH/);
  assert.deepEqual(snapshot(env.home), before);
});

test("a daemon that never gets healthy stops setup before any harness is touched", { timeout: 30_000 }, async () => {
  const env = box();
  seed(env);
  const out = await run(env, SETUP, { extraEnv: { OPENAI_API_KEY: OPENAI_KEY, CAVEMAN_SETUP_HEALTH_MS: "600" } });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /did not answer/);
  assert.equal(read(env, ".claude", "settings.json"), USER_SETTINGS);
  assert.equal(read(env, ".codex", "config.toml"), USER_TOML);
});

test("a missing key in --yes mode stops setup before the daemon is touched", async () => {
  const env = box();
  const out = await run(env, ["setup", "--yes", "--harness", "codex", "--openai", "key"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /no openai key/);
  assert.deepEqual(calls(env.home), []);
});

test("the statusline command chains the previous command through the setup CLI", async () => {
  const env = box();
  const daemon = await fakeDaemon(env.home, daemonReplies());
  try {
    const prev = Buffer.from("cat; printf ' <-mine'").toString("base64url");
    const input = JSON.stringify({ session_id: "s1", model: { id: "auto", display_name: "auto" } });
    const out = await run(env, ["statusline", "--prev", prev], { input });
    assert.equal(out.stdout, `${input} <-mine`);
    assert.equal(daemon.seen[0].body.kind, "statusline");
  } finally {
    await daemon.close();
  }
});

test("pool windows unknown (the daemon lists ids only): --context-window sets the Claude Code override", { timeout: 60_000 }, async () => {
  const env = box();
  const daemon = await fakeDaemon(env.home, daemonReplies());
  try {
    let out = await run(env, ["setup", "--yes", "--harness", "claude-code", "--claude", "subscription", "--openai", "key"], { extraEnv: { OPENAI_API_KEY: OPENAI_KEY } });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /--context-window/);
    assert.equal(JSON.parse(read(env, ".claude", "settings.json")).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "no guessed window");
    out = await run(env, ["setup", "--yes", "--harness", "claude-code", "--claude", "subscription", "--openai", "key", "--context-window", "272000"], { extraEnv: { OPENAI_API_KEY: OPENAI_KEY } });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(read(env, ".claude", "settings.json")).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "272000");
  } finally {
    await daemon.close();
  }
});

test("with the caveman-router plugin enabled, setup writes no hooks (they would run twice)", { timeout: 60_000 }, async () => {
  const env = box();
  writeFileSync(join(env.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "caveman-router@caveman": true } }));
  const daemon = await fakeDaemon(env.home, daemonReplies());
  try {
    const out = await run(env, ["setup", "--yes", "--harness", "claude-code", "--claude", "subscription", "--preset", "cheap"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /plugin is enabled/);
    const settings = JSON.parse(read(env, ".claude", "settings.json"));
    assert.equal(settings.hooks, undefined);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47821");
  } finally {
    await daemon.close();
  }
});
