import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// The stdin fixture Claude Code hands a statusLine command.
const STDIN = {
  session_id: "sess-abc",
  model: { id: "auto", display_name: "Opus 5" },
  cwd: "/tmp/p",
  workspace: { current_dir: "/tmp/p" },
  cost: { total_cost_usd: 0.4 },
};

function box() {
  const home = mkdtempSync(join(tmpdir(), "router-cc-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function cli(home, args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, CAVEMAN_ROUTER_HOME: join(home, "state"), ...env },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

const settingsOf = (home) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

async function fakeRouter(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("setup defaults to subscription mode: base url + our custom header, no auth token", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash"] },
    env: { FOO: "bar", ANTHROPIC_CUSTOM_HEADERS: "X-Mine: 1" },
  }, null, 2));

  const first = await cli(home, ["setup", "claude-code", "--url", "http://r.test", "--key", "crk_x", "--statusline"]);
  assert.match(first.stdout, /billing: your Claude subscription \(claude\.ai login\)/);
  assert.match(first.stdout, /restart Claude Code/);
  const after = settingsOf(home);
  assert.equal(after.env.ANTHROPIC_BASE_URL, "http://r.test");
  assert.equal(after.env.ANTHROPIC_CUSTOM_HEADERS, "X-Mine: 1\nx-cave-api-key: crk_x", "ours appended, theirs kept");
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, undefined, "the claude.ai login is left alone");
  assert.equal(after.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(after.env.FOO, "bar", "an unrelated env var survives");
  assert.equal(after.model, "auto");
  assert.deepEqual(after.statusLine, { type: "command", command: "caveman-router-hook statusline" });
  assert.deepEqual(after.permissions, { allow: ["Bash"] });
  assert.ok(after.hooks.PreToolUse.length === 1 && after.hooks.SubagentStop.length === 1, "spawn hooks installed too");

  await cli(home, ["setup", "claude-code", "--url", "http://r.test", "--key", "crk_x", "--statusline"]);
  assert.deepEqual(settingsOf(home), after, "second setup changes nothing, header not duplicated");

  const status = await cli(home, ["status"], { env: { ROUTER_URL: "http://r.test", ROUTER_API_KEY: "crk_x" } });
  assert.match(status.stdout, /claude code subscription/);
});

test("--api-key writes the auth token and no custom header", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  const out = await cli(home, ["setup", "claude-code", "--url", "http://r.test", "--key", "crk_x", "--api-key"]);
  assert.match(out.stdout, /billing: API key via the router/);
  const after = settingsOf(home);
  assert.equal(after.env.ANTHROPIC_BASE_URL, "http://r.test");
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, "crk_x");
  assert.equal(after.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.match((await cli(home, ["status"])).stdout, /claude code api-key/);
});

test("subscription setup warns about an ANTHROPIC key that takes precedence", async () => {
  const settings = await cli(box(), ["setup", "claude-code", "--key", "crk_x"], { env: { ANTHROPIC_API_KEY: "sk-ant-1" } });
  assert.match(settings.stdout, /warning: ANTHROPIC_API_KEY is set and takes precedence/);

  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-2" } }));
  const out = await cli(home, ["setup", "claude-code", "--key", "crk_x"]);
  assert.match(out.stdout, /warning: ANTHROPIC_AUTH_TOKEN is set and takes precedence/);

  const clean = await cli(box(), ["setup", "claude-code", "--key", "crk_x"]);
  assert.doesNotMatch(clean.stdout, /warning:/);
});

test("status says not set up before setup", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  assert.match((await cli(home, ["status"])).stdout, /claude code not set up/);
});

test("setup never overwrites somebody else's statusLine", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    statusLine: { type: "command", command: "my-own-line.sh" },
  }));
  const out = await cli(home, ["setup", "claude-code", "--key", "crk_x", "--statusline"]);
  assert.deepEqual(settingsOf(home).statusLine, { type: "command", command: "my-own-line.sh" });
  assert.match(out.stdout, /caveman-router-hook statusline/, "prints the snippet to chain");
});

test("setup refuses a settings file that is not an object", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), "[1,2,3]");
  const out = await cli(home, ["setup", "claude-code"]);
  assert.equal(out.code, 1);
  assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), "[1,2,3]");
});

test("teardown removes exactly what subscription setup wrote, keeping a foreign header", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    env: { FOO: "bar", ANTHROPIC_CUSTOM_HEADERS: "X-Mine: 1" }, permissions: {},
  }));
  await cli(home, ["setup", "claude-code", "--url", "http://r.test", "--key", "crk_x", "--statusline"]);
  await cli(home, ["teardown", "claude-code"]);
  const after = settingsOf(home);
  assert.deepEqual(after.env, { FOO: "bar", ANTHROPIC_CUSTOM_HEADERS: "X-Mine: 1" });
  assert.equal(after.model, undefined);
  assert.equal(after.statusLine, undefined);
  assert.equal(after.hooks, undefined, "an emptied hooks map is removed, not left as {}");
  assert.deepEqual(after.permissions, {});
  assert.match((await cli(home, ["status"])).stdout, /claude code not set up/);
});

test("teardown removes what --api-key setup wrote, and drops an emptied header key", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { FOO: "bar" } }));
  await cli(home, ["setup", "claude-code", "--url", "http://r.test", "--key", "crk_x", "--api-key"]);
  await cli(home, ["teardown", "claude-code"]);
  assert.deepEqual(settingsOf(home).env, { FOO: "bar" });

  const only = box();
  writeFileSync(join(only, ".claude", "settings.json"), "{}");
  await cli(only, ["setup", "claude-code", "--key", "crk_x"]);
  await cli(only, ["teardown", "claude-code"]);
  assert.equal(settingsOf(only).env, undefined, "no leftover empty ANTHROPIC_CUSTOM_HEADERS");
});

test("teardown leaves a model and a statusLine that are not ours", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    model: "opus",
    statusLine: { type: "command", command: "my-own-line.sh" },
  }));
  await cli(home, ["teardown", "claude-code"]);
  const after = settingsOf(home);
  assert.equal(after.model, "opus");
  assert.deepEqual(after.statusLine, { type: "command", command: "my-own-line.sh" });
});

test("model validates, sets and reads back", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  for (const good of ["auto", "auto:a/b,c/d", "openrouter/deepseek/deepseek-v4-pro-0813", "google/gemini-3.7-flash"]) {
    const out = await cli(home, ["model", good]);
    assert.equal(out.code, 0, good);
    assert.match(out.stdout, /\/model inside Claude Code still works/);
    assert.equal(settingsOf(home).model, good);
  }
  for (const bad of ["opus 5", "justaname", "auto:", "with space/x"]) {
    const out = await cli(home, ["model", bad]);
    assert.equal(out.code, 1, bad);
    assert.match(out.stderr, /not a model name/);
  }
  assert.match((await cli(home, ["model"])).stdout, /google\/gemini-3\.7-flash/);
});

test("statusline formats every branch and falls back without router config", async () => {
  const home = box();
  let body = {
    session_hash: "h", decisions: 14,
    last: { model: "deepseek/deepseek-v4-pro-0813", reason: "ranked", kind: "route", task: "code:repo_scan", tier: "medium" },
    models: {}, measured_usd: 0.31, estimate_usd: 0,
  };
  const router = await fakeRouter((req, res) => {
    assert.equal(req.headers["x-cave-api-key"], "crk_x");
    assert.match(req.url, /^\/v1\/session\?session_id=sess-abc$/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  const env = { ROUTER_URL: router.url, ROUTER_API_KEY: "crk_x" };
  const line = async (home) => (await cli(home, ["statusline"], { input: JSON.stringify(STDIN), env })).stdout.trim();

  assert.equal(await line(home), "auto → deepseek-v4-pro-0813 · code:repo_scan · 14 turns · $0.31");

  body = { ...body, measured_usd: 0, list_price_usd: 0.08, estimate_usd: 0.12 };
  assert.equal(await line(box()), "auto → deepseek-v4-pro-0813 · code:repo_scan · 14 turns · list $0.08");
  body = { ...body, measured_usd: 0, list_price_usd: 0, estimate_usd: 0.12 };
  assert.equal(await line(box()), "auto → deepseek-v4-pro-0813 · code:repo_scan · 14 turns · est. $0.12");

  body = { ...body, estimate_usd: 0 };
  assert.equal(await line(box()), "auto → deepseek-v4-pro-0813 · code:repo_scan · 14 turns");

  body = { ...body, decisions: 0, last: null };
  assert.equal(await line(box()), "auto");

  router.close();
  // No router key at all: Claude Code's own display name, unchanged.
  const bare = await cli(box(), ["statusline"], { input: JSON.stringify(STDIN) });
  assert.equal(bare.stdout.trim(), "Opus 5");
  assert.equal(bare.stderr, "");
  assert.equal(bare.code, 0);
});

test("statusline caches for 2 s and survives a router slower than 300 ms", async () => {
  const home = box();
  let hits = 0;
  let stall = false;
  const router = await fakeRouter((req, res) => {
    hits += 1;
    const send = () => res.end(JSON.stringify({ decisions: 3, last: { model: "x/fast", task: "chat" }, measured_usd: 0 }));
    if (stall) setTimeout(send, 1500);
    else send();
  });
  const env = { ROUTER_URL: router.url, ROUTER_API_KEY: "crk_x" };
  const run = () => cli(home, ["statusline"], { input: JSON.stringify(STDIN), env });

  assert.equal((await run()).stdout.trim(), "auto → fast · chat · 3 turns");
  assert.equal((await run()).stdout.trim(), "auto → fast · chat · 3 turns");
  assert.equal(hits, 1, "the second render inside 2 s is served from cache");

  // Age the cache past the refresh window, then make the router hang: the
  // 300 ms abort fires and the cached line is printed instead.
  const cache = join(home, "state", "statusline", "sess-abc.json");
  writeFileSync(cache, JSON.stringify({ at: Date.now() - 5000, line: "auto → fast · chat · 3 turns" }));
  stall = true;
  const started = Date.now();
  const out = await run();
  assert.equal(out.stdout.trim(), "auto → fast · chat · 3 turns");
  assert.ok(Date.now() - started < 1400, `gave up on the slow router (${Date.now() - started} ms)`);
  assert.equal(hits, 2);
  router.close();
});

test("teardown keeps a user's own Anthropic token", async () => {
  const home = box();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://r.test", ANTHROPIC_AUTH_TOKEN: "sk-ant-mine" } }));
  await cli(home, ["teardown", "claude-code"]);
  assert.equal(settingsOf(home).env.ANTHROPIC_AUTH_TOKEN, "sk-ant-mine");
  assert.equal(settingsOf(home).env.ANTHROPIC_BASE_URL, undefined);
});
