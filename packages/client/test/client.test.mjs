import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { RouterClient } from "../dist/index.js";

// One fake router per test: it records what arrived and answers what the test
// needs, so the assertions are about the wire and nothing else.
async function fakeRouter(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      handler(req, res, seen.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const ok = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ decision_id: "d1", decision: "delegate", collect: true }));
};

test("delegate sends key, session, budget and slider", async () => {
  const router = await fakeRouter(ok);
  try {
    const client = new RouterClient({ url: router.url, apiKey: "crk_test", sessionId: "s1", userHash: "u1", slider: "cheaper" });
    const result = await client.delegate({ parent: { model: "m", context_tokens: 10 }, task: { prompt: "p" } }, { budgetMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.data.decision_id, "d1");
    const call = router.seen[0];
    assert.equal(call.path, "/v1/route/delegate");
    assert.equal(call.headers["x-cave-api-key"], "crk_test");
    assert.equal(call.headers["x-cave-session-id"], "s1");
    assert.equal(call.headers["x-cave-user-hash"], "u1");
    assert.equal(call.headers["x-cave-budget-ms"], "2000");
    assert.equal(call.body.slider, "cheaper");
  } finally {
    router.close();
  }
});

test("a per-call slider beats the client default", async () => {
  const router = await fakeRouter(ok);
  try {
    const client = new RouterClient({ url: router.url, apiKey: "k", slider: "cheaper" });
    await client.task({ ask: "a", parent: { model: "m" }, slider: "careful" });
    assert.equal(router.seen[0].body.slider, "careful");
    assert.equal(router.seen[0].headers["x-cave-budget-ms"], undefined);
  } finally {
    router.close();
  }
});

test("outcome bodies match the server contract", async () => {
  const router = await fakeRouter(ok);
  try {
    const client = new RouterClient({ url: router.url, apiKey: "k" });
    await client.outcome("tok", "completed");
    await client.delegateOutcome("dlg", {
      model: "anthropic/claude-sonnet-5",
      input_tokens: 1, cache_read_tokens: 2, cache_creation_tokens: 3,
      output_tokens: 4, turns: 5, tool_calls: 6, result_chars: 0,
    });
    assert.deepEqual(router.seen[0].body, { outcome_token: "tok", outcome_kind: "completed" });
    assert.equal(router.seen[1].path, "/v1/route/delegate/outcomes");
    assert.equal(router.seen[1].body.decision_id, "dlg");
    assert.equal(router.seen[1].body.child.turns, 5);
  } finally {
    router.close();
  }
});

test("5xx, bad body and a missing key are values, not throws", async () => {
  const router = await fakeRouter((req, res, n) => {
    if (n === 1) { res.writeHead(500); res.end("nope"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[1]");
  });
  try {
    const client = new RouterClient({ url: router.url, apiKey: "k" });
    assert.deepEqual(await client.route({ text: "x", models: ["a"] }), { ok: false, reason: "http_500" });
    assert.deepEqual(await client.route({ text: "x", models: ["a"] }), { ok: false, reason: "bad_body" });
    const keyless = new RouterClient({ url: router.url, apiKey: "" });
    assert.deepEqual(await keyless.route({ text: "x", models: ["a"] }), { ok: false, reason: "no_api_key" });
  } finally {
    router.close();
  }
});

test("a slow server times out inside the budget", async () => {
  const router = await fakeRouter(() => { /* never answers */ });
  try {
    const client = new RouterClient({ url: router.url, apiKey: "k" });
    const started = Date.now();
    const result = await client.delegate({ parent: { model: "m", context_tokens: 1 }, task: { prompt: "p" } }, { budgetMs: 150 });
    assert.deepEqual(result, { ok: false, reason: "timeout" });
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(await client.delegate({ parent: { model: "m", context_tokens: 1 }, task: { prompt: "p" } }, { budgetMs: 0 }), { ok: false, reason: "no_budget" });
  } finally {
    router.close();
  }
});

test("an unreachable router is a network reason", async () => {
  const client = new RouterClient({ url: "http://127.0.0.1:1", apiKey: "k" });
  const result = await client.route({ text: "x", models: ["a"] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /network|timeout/);
});
