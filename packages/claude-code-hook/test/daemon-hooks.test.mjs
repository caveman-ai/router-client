import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { daemonReplies, fakeDaemon, tempHome } from "../../client/test/fake-daemon.mjs";

// The socket path follows $CAVEMAN_HOME: a value from the developer's shell
// must not point these tests at a real daemon.
delete process.env.CAVEMAN_HOME;

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const INDEX = new URL("../dist/index.js", import.meta.url).href;

function hook(home, event, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(process.execPath, [CLI], {
      cwd: home,
      // No router key: the hosted fallback has nothing to call, so any output
      // comes from the daemon path.
      env: { PATH: process.env.PATH, HOME: home, CAVEMAN_ROUTER_HOME: join(home, "state"), ...env },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(event));
  });
}

const agentEvent = (home, input = { prompt: "scan", description: "scan", subagent_type: "explore", model: "opus" }) => ({
  hook_event_name: "PreToolUse", session_id: "s1", cwd: home, tool_name: "Agent", tool_use_id: "t1", tool_input: input,
});

test("UserPromptSubmit prefetches through /hook/prompt", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies());
  try {
    const out = await hook(home, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p-1", cwd: home, prompt: "fix the bug" });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "");
    assert.equal(daemon.seen.length, 1);
    assert.equal(daemon.seen[0].path, "/hook/prompt");
    assert.deepEqual(daemon.seen[0].body, { harness: "claude-code", session_id: "s1", prompt_id: "p-1", cwd: home, prompt_excerpt: "fix the bug" });
  } finally { await daemon.close(); }
});

test("PreToolUse Agent: the daemon's model becomes updatedInput.model, other fields kept", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies({ model: "anthropic/claude-haiku-5", effort: null, line: "Caveman · child on Haiku", decision_id: "d1" }));
  try {
    const out = await hook(home, agentEvent(home));
    const reply = JSON.parse(out.stdout);
    assert.deepEqual(reply.hookSpecificOutput, {
      hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { prompt: "scan", description: "scan", subagent_type: "explore", model: "haiku" },
    });
    assert.equal(reply.systemMessage, "Caveman · child on Haiku");
    assert.equal(daemon.seen[0].body.tool, "Agent");
    assert.equal(daemon.seen[0].body.harness, "claude-code");
    assert.deepEqual(daemon.seen[0].body.tool_input, { prompt: "scan", description: "scan", subagent_type: "explore", model: "opus", model_declared: false });
  } finally { await daemon.close(); }
});

test("PreToolUse Agent: a non-Claude id is never written into the Agent tool", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies({ model: "openai/gpt-6-luna", effort: null, line: null, decision_id: null }));
  try {
    const out = await hook(home, agentEvent(home));
    assert.equal(out.stdout, "");
  } finally { await daemon.close(); }
});

test("PreToolUse with no daemon falls back silently and fast", async () => {
  const home = tempHome();
  const out = await hook(home, agentEvent(home));
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.equal(out.stderr, "");
});

test("PreToolUse with a stuck daemon gives up at the 2 s spawn budget", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, undefined, { hang: true });
  try {
    const out = await hook(home, agentEvent(home));
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "");
    assert.ok(out.ms < 3500, `took ${out.ms} ms`);
  } finally { await daemon.close(); }
});

test("events with a stuck daemon do not hold the harness", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, undefined, { hang: true });
  try {
    for (const event of [
      { hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p", prompt: "x" },
      { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Agent", tool_input: {}, tool_response: {} },
      { hook_event_name: "Stop", session_id: "s" },
    ]) {
      const out = await hook(home, event);
      assert.equal(out.code, 0);
      assert.equal(out.stdout, "");
      // Node startup dominates; the daemon call itself is capped at 50 ms.
      assert.ok(out.ms < 1500, `${event.hook_event_name} took ${out.ms} ms`);
    }
  } finally { await daemon.close(); }
});

test("SessionStart: a down daemon is a user-visible systemMessage", async () => {
  const home = tempHome();
  const out = await hook(home, { hook_event_name: "SessionStart", session_id: "s", cwd: home, source: "startup" });
  assert.equal(out.code, 0);
  assert.match(JSON.parse(out.stdout).systemMessage, /Caveman routing is off/);
});

test("SessionStart: a healthy daemon is silent and gets the repo profile", async () => {
  const home = tempHome();
  const repo = join(home, "repo");
  mkdirSync(repo);
  const daemon = await fakeDaemon(home, daemonReplies());
  try {
    const out = await hook(home, { hook_event_name: "SessionStart", session_id: "s", cwd: repo, source: "startup" });
    assert.equal(out.stdout, "");
    assert.equal(daemon.seen[0].path, "/health");
  } finally { await daemon.close(); }
});

test("PostToolUse: subagent_done for Agent only (Claude Code tool results reach the proxy); Stop sends stop", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies());
  try {
    await hook(home, { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_input: {}, tool_response: { exitCode: 2 } });
    await hook(home, {
      hook_event_name: "PostToolUse", session_id: "s", tool_name: "Agent", tool_input: { model: "sonnet", prompt: "p" },
      tool_response: { agentId: "a1", resolvedModel: "claude-sonnet-5", usage: { input_tokens: 10 }, totalDurationMs: 1200, totalToolUseCount: 3 },
    });
    await hook(home, { hook_event_name: "Stop", session_id: "s" });
    assert.deepEqual(daemon.seen.map((entry) => entry.body), [
      { harness: "claude-code", session_id: "s", kind: "subagent_done", data: { agent_id: "a1", requested_model: "sonnet", resolved_model: "claude-sonnet-5", usage: { input_tokens: 10 }, duration_ms: 1200, tool_count: 3 } },
      { harness: "claude-code", session_id: "s", kind: "stop", data: {} },
    ]);
  } finally { await daemon.close(); }
});

test("UserPromptSubmit without a prompt id sends nothing (the daemon keys the prefetch on it)", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies());
  try {
    await hook(home, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" });
    assert.equal(daemon.seen.length, 0);
  } finally { await daemon.close(); }
});

test("statuslineChain forwards the JSON and runs the previous command unchanged", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies());
  const script = join(home, "prev.sh");
  writeFileSync(script, "#!/bin/sh\nread line\nprintf 'PREV:%s' \"$line\"\nexit 3\n", { mode: 0o755 });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { statuslineChain } = await import(INDEX);
    const stdin = JSON.stringify({ session_id: "s9", model: { id: "auto" }, context_window: { used_percentage: 41 } });
    // Run in a child so its stdout is capturable.
    const out = await new Promise((resolve) => {
      const child = execFile(process.execPath, ["--input-type=module", "-e",
        `const { statuslineChain } = await import(${JSON.stringify(INDEX)}); process.exitCode = await statuslineChain(${JSON.stringify(stdin)}, ${JSON.stringify(`sh ${script}`)});`],
        { env: { PATH: process.env.PATH, HOME: home } }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
      child.stdin.end();
    });
    assert.equal(typeof statuslineChain, "function");
    assert.equal(out.stdout, `PREV:${stdin}`, "previous output byte-for-byte");
    assert.equal(out.code, 3, "previous exit code kept");
    assert.equal(daemon.seen[0].path, "/hook/event");
    assert.equal(daemon.seen[0].body.kind, "statusline");
    assert.equal(daemon.seen[0].body.session_id, "s9");
    assert.deepEqual(daemon.seen[0].body.data.context_window, { used_percentage: 41 });
  } finally {
    process.env.HOME = previous;
    await daemon.close();
  }
});

test("statuslineChain with a stuck daemon still renders within ~20 ms of the command", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, undefined, { hang: true });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { statuslineChain } = await import(INDEX);
    const started = Date.now();
    const code = await statuslineChain(JSON.stringify({ session_id: "s" }), "true");
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`);
  } finally {
    process.env.HOME = previous;
    await daemon.close();
  }
});

// A hosted router that always delegates to haiku, and a transcript the
// hosted path can read, so any hosted call shows up.
async function hostedRouter() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "delegate", delegate: { model: "anthropic/claude-haiku-5" }, line: "hosted", decision_id: "h1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

function withTranscript(home) {
  const project = join(home, ".claude", "projects", "p");
  mkdirSync(project, { recursive: true });
  const path = join(project, "t.jsonl");
  writeFileSync(path, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n"
    + JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 1000 }, content: [] } }) + "\n");
  return { ...agentEvent(home), transcript_path: path };
}

test("the hosted fallback runs only when no daemon is there, and never when Claude Code is pointed at the daemon", { timeout: 30_000 }, async () => {
  const hosted = await hostedRouter();
  const env = { ROUTER_URL: hosted.url, ROUTER_API_KEY: "rk_test" };
  try {
    for (const [name, handler, options, expectHosted, extra] of [
      ["daemon 503", () => ({ status: 503, body: { error: "down" } }), {}, 0, {}],
      ["daemon 204", () => ({ status: 204 }), {}, 0, {}],
      ["daemon stuck", undefined, { hang: true }, 0, {}],
      ["no daemon", null, {}, 1, {}],
      ["no daemon, base URL at the daemon", null, {}, 0, { ANTHROPIC_BASE_URL: "http://127.0.0.1:47821" }],
    ]) {
      const home = tempHome();
      const daemon = handler === null ? undefined : await fakeDaemon(home, handler, options);
      hosted.calls.length = 0;
      try {
        const out = await hook(home, withTranscript(home), { ...env, ...extra });
        assert.equal(out.code, 0);
        assert.equal(hosted.calls.length, expectHosted, `${name}: hosted calls`);
        if (!expectHosted) assert.equal(out.stdout, "", `${name}: spawn left alone`);
      } finally { await daemon?.close(); }
    }
  } finally { hosted.close(); }
});

test("the base URL in settings.json counts too", { timeout: 30_000 }, async () => {
  const hosted = await hostedRouter();
  const home = tempHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:47821" } }));
  try {
    await hook(home, withTranscript(home), { ROUTER_URL: hosted.url, ROUTER_API_KEY: "rk_test" });
    assert.equal(hosted.calls.length, 0);
  } finally { hosted.close(); }
});

test("an inherit answer drops model from the spawn instead of writing \"inherit\"", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies({ model: "inherit", effort: null, line: null, decision_id: "d" }));
  try {
    const reply = JSON.parse((await hook(home, agentEvent(home))).stdout);
    assert.deepEqual(reply.hookSpecificOutput.updatedInput, { prompt: "scan", description: "scan", subagent_type: "explore" });
  } finally { await daemon.close(); }
});

test("statuslineChain: a previous command killed by a signal is a failure", async () => {
  const home = tempHome();
  const out = await new Promise((resolve) => {
    const child = execFile(process.execPath, ["--input-type=module", "-e",
      `const { statuslineChain } = await import(${JSON.stringify(INDEX)}); process.exitCode = await statuslineChain("{}", "kill -9 $$");`],
      { env: { PATH: process.env.PATH, HOME: home } }, (error) => resolve({ code: error?.code ?? 0 }));
    child.stdin.end();
  });
  assert.notEqual(out.code, 0);
});
