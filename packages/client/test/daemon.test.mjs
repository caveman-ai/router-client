import assert from "node:assert/strict";
import test from "node:test";
import { daemonHealthy, postEvent, postPrompt, spawnDecision } from "../dist/index.js";
import { daemonReplies, fakeDaemon, tempHome } from "./fake-daemon.mjs";

function withHome(home) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  return () => { process.env.HOME = previous; };
}

test("hooks reach the control socket with harness and session", async () => {
  const home = tempHome();
  const restore = withHome(home);
  const daemon = await fakeDaemon(home, daemonReplies({ model: "haiku", effort: "low", line: "moved", decision_id: "d1" }));
  try {
    assert.equal(await daemonHealthy(), true);
    assert.equal(await postEvent("codex", "s1", "stop", {}), true);
    assert.equal((await postPrompt("claude-code", "s1", { prompt_id: "p1", cwd: "/x" }))?.status, 204);
    const decision = await spawnDecision("claude-code", "s1", { tool: "Agent", tool_input: { prompt: "p" }, parent: { model: "claude-opus-5" } });
    assert.deepEqual(decision, { model: "haiku", effort: "low", line: "moved", decision_id: "d1" });
    assert.deepEqual(daemon.seen.map((entry) => entry.path), ["/health", "/hook/event", "/hook/prompt", "/hook/spawn"]);
    assert.deepEqual(daemon.seen[1].body, { harness: "codex", session_id: "s1", kind: "stop", data: {} });
    assert.equal(daemon.seen[2].body.prompt_id, "p1");
    assert.equal(daemon.seen[3].body.tool, "Agent");
  } finally {
    await daemon.close();
    restore();
  }
});

test("a missing socket fails open immediately", async () => {
  const restore = withHome(tempHome());
  try {
    const started = Date.now();
    assert.equal(await daemonHealthy(), false);
    assert.equal(await postEvent("codex", "s", "stop", {}), false);
    assert.equal(await spawnDecision("codex", "s", { tool: "spawn_agent", tool_input: {}, parent: {} }), undefined);
    assert.ok(Date.now() - started < 200, "no waiting on a daemon that is not there");
  } finally {
    restore();
  }
});

test("a stuck daemon costs exactly the timeout", async () => {
  const home = tempHome();
  const restore = withHome(home);
  const daemon = await fakeDaemon(home, undefined, { hang: true });
  try {
    let started = Date.now();
    assert.equal(await postEvent("codex", "s", "stop", {}), false);
    const eventMs = Date.now() - started;
    assert.ok(eventMs >= 45 && eventMs < 200, `event waited ${eventMs} ms`);
    started = Date.now();
    assert.equal(await spawnDecision("codex", "s", { tool: "spawn_agent", tool_input: {}, parent: {} }, 300), undefined);
    const spawnMs = Date.now() - started;
    assert.ok(spawnMs >= 290 && spawnMs < 600, `spawn waited ${spawnMs} ms`);
  } finally {
    await daemon.close();
    restore();
  }
});

test("a non-2xx or unparsable spawn answer is no answer", async () => {
  const home = tempHome();
  const restore = withHome(home);
  const daemon = await fakeDaemon(home, () => ({ status: 500, body: { model: "x" } }));
  try {
    assert.equal(await spawnDecision("codex", "s", { tool: "spawn_agent", tool_input: {}, parent: {} }), undefined);
    assert.equal(await daemonHealthy(), false);
  } finally {
    await daemon.close();
    restore();
  }
});
