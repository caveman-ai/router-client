import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { daemonReplies, fakeDaemon, tempHome } from "../../client/test/fake-daemon.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function hook(home, event) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(process.execPath, [CLI], { cwd: home, env: { PATH: process.env.PATH, HOME: home } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(typeof event === "string" ? event : JSON.stringify(event));
  });
}

// The fields Codex's PreToolUseCommandInput carries (codex-rs/hooks/src/schema.rs).
const spawnEvent = (overrides = {}) => ({
  session_id: "c1", turn_id: "turn-1", transcript_path: null, cwd: "/work", hook_event_name: "PreToolUse",
  model: "auto", permission_mode: "default", tool_name: "spawn_agent", tool_use_id: "call-1",
  tool_input: { message: "write the tests", task_name: "tests", agent_type: "worker" },
  ...overrides,
});

// The keys Codex's PreToolUse output parser accepts (deny_unknown_fields, camelCase).
const TOP_KEYS = new Set(["continue", "stopReason", "suppressOutput", "systemMessage", "decision", "reason", "hookSpecificOutput"]);
const SPECIFIC_KEYS = new Set(["hookEventName", "permissionDecision", "permissionDecisionReason", "updatedInput", "additionalContext"]);

test("spawn_agent: model and reasoning_effort from /hook/spawn, every other argument kept", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies({ model: "openai/gpt-6-luna", effort: "low", line: "Caveman · child on gpt-6-luna", decision_id: "d1" }));
  try {
    const out = await hook(home, spawnEvent());
    const reply = JSON.parse(out.stdout);
    for (const key of Object.keys(reply)) assert.ok(TOP_KEYS.has(key), `unknown top-level key ${key}`);
    for (const key of Object.keys(reply.hookSpecificOutput)) assert.ok(SPECIFIC_KEYS.has(key), `unknown key ${key}`);
    assert.deepEqual(reply.hookSpecificOutput, {
      hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { message: "write the tests", task_name: "tests", agent_type: "worker", model: "openai/gpt-6-luna", reasoning_effort: "low" },
    });
    assert.equal(reply.systemMessage, "Caveman · child on gpt-6-luna");
    assert.deepEqual(daemon.seen[0].body, {
      harness: "codex", session_id: "c1", tool: "spawn_agent",
      tool_input: { message: "write the tests", task_name: "tests", agent_type: "worker" }, parent: { model: "auto" }, cwd: "/work",
    });
  } finally { await daemon.close(); }
});

test("spawn_agent: a leave-it answer or a junk effort writes nothing", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies({ model: null, effort: "high; rm -rf", line: null, decision_id: null }));
  try {
    assert.equal((await hook(home, spawnEvent())).stdout, "");
  } finally { await daemon.close(); }
});

test("a session not on the caveman profile is never touched", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies({ model: "openai/gpt-6-luna", effort: null, line: null, decision_id: null }));
  try {
    assert.equal((await hook(home, spawnEvent({ model: "gpt-5.5" }))).stdout, "");
    assert.equal(daemon.seen.length, 0);
  } finally { await daemon.close(); }
});

test("events: prompt prefetch, tool_result, subagent_done, stop, interrupt", async () => {
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies());
  const base = { session_id: "c1", turn_id: "turn-2", cwd: "/work", model: "auto", permission_mode: "default", transcript_path: null };
  try {
    for (const event of [
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "add a flag" },
      { ...base, hook_event_name: "PostToolUse", tool_name: "shell", tool_input: {}, tool_response: { exit_code: 1 }, tool_use_id: "x" },
      { ...base, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "worker", stop_hook_active: false, last_assistant_message: null },
      { ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: null },
      { ...base, hook_event_name: "Interrupt" },
    ]) {
      const out = await hook(home, event);
      assert.equal(out.stdout, "");
      assert.equal(out.code, 0);
    }
    const bodies = daemon.seen.map((entry) => entry.body);
    assert.deepEqual(bodies[0], { harness: "codex", session_id: "c1", prompt_id: "turn-2", cwd: "/work", prompt_excerpt: "add a flag" });
    assert.deepEqual(bodies[1].data, { tool: "shell", ok: false, exit_code: 1 });
    assert.deepEqual(bodies[2], { harness: "codex", session_id: "c1", kind: "subagent_done", data: { agent_id: "a1", agent_type: "worker" } });
    assert.deepEqual(bodies.slice(3).map((body) => body.kind), ["stop", "interrupt"]);
  } finally { await daemon.close(); }
});

test("fails open: no socket, a stuck daemon, garbage stdin", async () => {
  const home = tempHome();
  let out = await hook(home, spawnEvent());
  assert.deepEqual([out.code, out.stdout, out.stderr], [0, "", ""]);
  out = await hook(home, "not json");
  assert.deepEqual([out.code, out.stdout, out.stderr], [0, "", ""]);
  const daemon = await fakeDaemon(home, undefined, { hang: true });
  try {
    out = await hook(home, spawnEvent());
    assert.equal(out.stdout, "");
    assert.ok(out.ms < 3500, `spawn took ${out.ms} ms`);
    out = await hook(home, { ...spawnEvent(), hook_event_name: "Stop" });
    assert.ok(out.ms < 1500, `stop took ${out.ms} ms`);
  } finally { await daemon.close(); }
});

test("SessionStart on a down daemon warns the user", async () => {
  const home = tempHome();
  const out = await hook(home, { session_id: "c1", transcript_path: null, cwd: "/w", hook_event_name: "SessionStart", model: "auto", permission_mode: "default", source: "startup" });
  assert.match(JSON.parse(out.stdout).systemMessage, /Caveman routing is off/);
});
