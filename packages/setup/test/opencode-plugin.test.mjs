import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { daemonReplies, fakeDaemon, tempHome } from "../../client/test/fake-daemon.mjs";

const PLUGIN = new URL("../assets/opencode-plugin.js", import.meta.url).href;

async function plugin(home) {
  process.env.HOME = home;
  mkdirSync(join(home, ".caveman"), { recursive: true });
  writeFileSync(join(home, ".caveman", "routerd.token"), "tok123\n");
  const { CavemanRouter } = await import(PLUGIN);
  return CavemanRouter({ directory: "/proj" });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const cavemanModel = { providerID: "caveman", modelID: "auto" };

test("chat.headers: token and session id on caveman requests only", async () => {
  const saved = process.env.HOME;
  try {
    const hooks = await plugin(tempHome());
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses_1", model: cavemanModel, provider: { info: { id: "caveman" } } }, output);
    assert.deepEqual(output.headers, { "x-caveman-session": "ses_1", "x-caveman-local-token": "tok123" });
    const other = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses_2", model: { providerID: "anthropic", modelID: "x" }, provider: { info: { id: "anthropic" } } }, other);
    assert.deepEqual(other.headers, {});
  } finally { process.env.HOME = saved; }
});

test("chat.message prefetches; tool.execute.after reports; other providers are ignored", async () => {
  const saved = process.env.HOME;
  const home = tempHome();
  const daemon = await fakeDaemon(home, daemonReplies());
  try {
    const hooks = await plugin(home);
    const message = { message: { model: cavemanModel }, parts: [{ type: "text", text: "fix the flaky test" }, { type: "file", url: "x" }] };
    await hooks["chat.message"]({ sessionID: "ses_1", model: cavemanModel, messageID: "msg_1" }, message);
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_1", callID: "c1", args: {} }, { title: "", output: "", metadata: { exit: 1 } });
    await hooks["chat.message"]({ sessionID: "ses_9", model: { providerID: "openai", modelID: "gpt" } }, { message: {}, parts: [] });
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_9", callID: "c2", args: {} }, { title: "", output: "", metadata: {} });
    await settle();
    assert.deepEqual(daemon.seen.map((entry) => entry.body), [
      { harness: "opencode", session_id: "ses_1", prompt_id: "msg_1", cwd: "/proj", prompt_excerpt: "fix the flaky test" },
      { harness: "opencode", session_id: "ses_1", kind: "tool_result", data: { tool: "bash", ok: false, exit_code: 1 } },
    ]);
    assert.deepEqual(message.message.model, cavemanModel, "the model is left alone unless the experimental flag is on");
  } finally { process.env.HOME = saved; await daemon.close(); }
});

test("experimental: CAVEMAN_OPENCODE_SET_MODEL=1 applies a model the daemon returns", async () => {
  const saved = process.env.HOME;
  const home = tempHome();
  const daemon = await fakeDaemon(home, ({ path }) => (path === "/hook/prompt" ? { status: 200, body: { model: "openai/gpt-6-luna" } } : { status: 204 }));
  process.env.CAVEMAN_OPENCODE_SET_MODEL = "1";
  try {
    const hooks = await plugin(home);
    const output = { message: { id: "msg_2", model: cavemanModel }, parts: [{ type: "text", text: "go" }] };
    await hooks["chat.message"]({ sessionID: "ses_1", model: cavemanModel }, output);
    assert.deepEqual(output.message.model, { providerID: "caveman", modelID: "openai/gpt-6-luna" });
    assert.equal(daemon.seen[0].body.prompt_id, "msg_2", "the message id stands in when the input has none");
  } finally {
    delete process.env.CAVEMAN_OPENCODE_SET_MODEL;
    process.env.HOME = saved;
    await daemon.close();
  }
});

test("no daemon: every hook returns promptly without throwing", async () => {
  const saved = process.env.HOME;
  process.env.CAVEMAN_OPENCODE_SET_MODEL = "1";
  try {
    const hooks = await plugin(tempHome());
    const started = Date.now();
    const output = { message: { id: "m", model: cavemanModel }, parts: [] };
    await hooks["chat.message"]({ sessionID: "s", model: cavemanModel }, output);
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "s", callID: "c", args: {} }, { title: "", output: "", metadata: {} });
    assert.ok(Date.now() - started < 300);
    assert.deepEqual(output.message.model, cavemanModel);
  } finally {
    delete process.env.CAVEMAN_OPENCODE_SET_MODEL;
    process.env.HOME = saved;
  }
});

test("a stuck daemon costs the experimental path at most its 2 s cap", { timeout: 10_000 }, async () => {
  const saved = process.env.HOME;
  const home = tempHome();
  const daemon = await fakeDaemon(home, undefined, { hang: true });
  process.env.CAVEMAN_OPENCODE_SET_MODEL = "1";
  try {
    const hooks = await plugin(home);
    const started = Date.now();
    await hooks["chat.message"]({ sessionID: "s", model: cavemanModel, messageID: "m" }, { message: { model: cavemanModel }, parts: [] });
    const ms = Date.now() - started;
    assert.ok(ms >= 1900 && ms < 2600, `took ${ms} ms`);
  } finally {
    delete process.env.CAVEMAN_OPENCODE_SET_MODEL;
    process.env.HOME = saved;
    await daemon.close();
  }
});
