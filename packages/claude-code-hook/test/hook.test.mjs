import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// A home per test: the transcript guard only opens files under
// <home>/.claude/projects, and homedir() honours $HOME.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "router-hook-"));
  const project = join(home, ".claude", "projects", "p");
  mkdirSync(project, { recursive: true });
  return { home, project };
}

const PARENT_LINES = [
  JSON.stringify({ type: "user", message: { content: "please scan the repo" } }),
  JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-5-20260101",
      usage: { input_tokens: 1200, cache_read_input_tokens: 220000, cache_creation_input_tokens: 11831, output_tokens: 700 },
      content: [{ type: "text", text: "spawning" }],
    },
  }),
].join("\n") + "\n";

function writeParent(box) {
  const path = join(box.project, "session.jsonl");
  writeFileSync(path, PARENT_LINES);
  return path;
}

function preToolUse(box) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    cwd: box.home,
    tool_name: "Agent",
    tool_use_id: "toolu_01",
    transcript_path: writeParent(box),
    tool_input: { subagent_type: "explore", description: "scan repo", prompt: "find the router hook", model: "opus" },
  };
}

async function fakeRouter(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      handler(req, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function runHook(box, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI], {
      env: { PATH: process.env.PATH, HOME: box.home, CAVEMAN_ROUTER_HOME: join(box.home, "state"), ...env },
    }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
    child.stdin.end(JSON.stringify(payload));
  });
}

const delegateReply = {
  decision: "delegate",
  delegate: { model: "anthropic/claude-sonnet-5", effort: null, context: "fresh" },
  reason: "ranked",
  line: "Caveman · subagent on Sonnet 5 instead of Opus 5 · est. $0.84 vs $1.72 · code search",
  deny_line: "",
  inline_recommended: false,
  collect: true,
  decision_id: "dlg_1",
  router_version: "delegate-v1",
};

function answer(payload) {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

test("a delegate answer rewrites the model and shows the human one line", async () => {
  const box = sandbox();
  const router = await fakeRouter(answer(delegateReply));
  try {
    const { stdout } = await runHook(box, preToolUse(box), { ROUTER_URL: router.url, ROUTER_API_KEY: "crk_dev" });
    assert.equal(stdout, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { subagent_type: "explore", description: "scan repo", prompt: "find the router hook", model: "sonnet" },
      },
      systemMessage: `${delegateReply.line} · caveman-router-hook off`,
    }));
    const sent = router.seen[0].body;
    assert.equal(router.seen[0].path, "/v1/route/delegate");
    assert.equal(router.seen[0].headers["x-cave-session-id"], "sess-1");
    assert.ok(Number(router.seen[0].headers["x-cave-budget-ms"]) <= 2500);
    assert.deepEqual(sent.parent, {
      model: "claude-opus-5-20260101",
      context_tokens: 233031,
      cache_read_tokens: 220000,
      turn: 1,
      children_active: 0,
    });
    assert.equal(sent.task.model, "claude-opus-5-20260101");
    assert.equal(sent.task.model_declared, false);
    assert.equal(sent.harness.kind, "claude-code");
    assert.equal(sent.veto, false);
    // The decision is filed under the tool_use_id SubagentStop will resolve.
    const state = JSON.parse(readFileSync(join(box.home, "state", "spawn", "sess-1.json"), "utf8"));
    assert.deepEqual(state.decisions.toolu_01, { decision_id: "dlg_1", model: "anthropic/claude-sonnet-5" });
  } finally {
    router.close();
  }
});

test("a frontmatter model is reported as declared, not decided on", async () => {
  const box = sandbox();
  mkdirSync(join(box.home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(box.home, ".claude", "agents", "explore.md"), "---\nname: explore\nmodel: opus\n---\nbody\n");
  const router = await fakeRouter(answer({ ...delegateReply, decision: "inline", line: "" }));
  try {
    const { stdout } = await runHook(box, preToolUse(box), { ROUTER_URL: router.url, ROUTER_API_KEY: "crk_dev" });
    assert.equal(stdout, "");
    assert.equal(router.seen[0].body.task.model_declared, true);
  } finally {
    router.close();
  }
});

test("inline with a line prints the line only; no answer prints nothing", async () => {
  const box = sandbox();
  const kept = await fakeRouter(answer({ ...delegateReply, decision: "inline", line: "Caveman · kept on Opus 5 · needs parent context" }));
  try {
    const { stdout } = await runHook(box, preToolUse(box), { ROUTER_URL: kept.url, ROUTER_API_KEY: "crk_dev" });
    assert.equal(stdout, JSON.stringify({ systemMessage: "Caveman · kept on Opus 5 · needs parent context · caveman-router-hook off" }));
  } finally {
    kept.close();
  }
  const dead = sandbox();
  const down = await fakeRouter((_req, res) => { res.writeHead(500); res.end("no"); });
  try {
    assert.equal((await runHook(dead, preToolUse(dead), { ROUTER_URL: down.url, ROUTER_API_KEY: "crk_dev" })).stdout, "");
  } finally {
    down.close();
  }
  // No key, no call, no output.
  const keyless = sandbox();
  assert.equal((await runHook(keyless, preToolUse(keyless), { ROUTER_URL: "http://127.0.0.1:1" })).stdout, "");
  // Off is off.
  const off = sandbox();
  assert.equal((await runHook(off, preToolUse(off), { ROUTER_URL: "http://127.0.0.1:1", ROUTER_API_KEY: "k", ROUTER_OFF: "1" })).stdout, "");
});

test("ROUTER_VETO=1 denies once with the endpoint's own line", async () => {
  const box = sandbox();
  const router = await fakeRouter(answer({ ...delegateReply, decision: "inline", inline_recommended: true, deny_line: "Do this inline: $0.20 vs $1.70 spawned." }));
  try {
    const env = { ROUTER_URL: router.url, ROUTER_API_KEY: "crk_dev", ROUTER_VETO: "1" };
    const first = await runHook(box, preToolUse(box), env);
    assert.equal(first.stdout, JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Do this inline: $0.20 vs $1.70 spawned." },
    }));
    assert.equal(router.seen[0].body.veto, true);
    // At most one deny per session; the second spawn runs as proposed.
    const second = await runHook(box, preToolUse(box), env);
    assert.equal(second.stdout, JSON.stringify({ systemMessage: `${delegateReply.line} · caveman-router-hook off` }));
  } finally {
    router.close();
  }
});

test("SubagentStop posts the child's measured usage against the decision", async () => {
  const box = sandbox();
  const router = await fakeRouter(answer(delegateReply));
  try {
    const env = { ROUTER_URL: router.url, ROUTER_API_KEY: "crk_dev" };
    await runHook(box, preToolUse(box), env);
    const subagents = join(box.project, "subagents");
    mkdirSync(subagents, { recursive: true });
    const childPath = join(subagents, "agent-abc.jsonl");
    const message = {
      id: "msg_1", model: "claude-sonnet-5-20260101",
      usage: { input_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 250 },
      content: [{ type: "tool_use", id: "tu_1", name: "Read" }],
    };
    writeFileSync(childPath, [
      // The same message id repeats once per content block: usage counts once.
      JSON.stringify({ type: "assistant", message }),
      JSON.stringify({ type: "assistant", message }),
    ].join("\n") + "\n");
    writeFileSync(join(subagents, "agent-abc.meta.json"), JSON.stringify({ toolUseId: "toolu_01" }));
    const { stdout } = await runHook(box, {
      hook_event_name: "SubagentStop", session_id: "sess-1", agent_id: "abc", agent_transcript_path: childPath,
    }, env);
    assert.equal(stdout, "");
    const outcome = router.seen.at(-1);
    assert.equal(outcome.path, "/v1/route/delegate/outcomes");
    assert.deepEqual(outcome.body, {
      decision_id: "dlg_1",
      child: {
        model: "claude-sonnet-5-20260101",
        input_tokens: 500, cache_read_tokens: 4000, cache_creation_tokens: 100, output_tokens: 250,
        turns: 1, tool_calls: 1, result_chars: 0,
      },
    });
  } finally {
    router.close();
  }
});

test("a transcript outside ~/.claude/projects is never opened", async () => {
  const box = sandbox();
  const outside = join(box.home, "secrets.jsonl");
  writeFileSync(outside, PARENT_LINES);
  const router = await fakeRouter(answer(delegateReply));
  try {
    const payload = { ...preToolUse(box), transcript_path: outside };
    assert.equal((await runHook(box, payload, { ROUTER_URL: router.url, ROUTER_API_KEY: "k" })).stdout, "");
    assert.equal(router.seen.length, 0);
  } finally {
    router.close();
  }
});
