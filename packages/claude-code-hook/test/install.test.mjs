import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = promisify(execFile);

function cli(home, args) {
  return run(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: home, CAVEMAN_ROUTER_HOME: join(home, "state") },
  });
}

test("install is idempotent and uninstall removes only our entries", async () => {
  const home = mkdtempSync(join(tmpdir(), "router-install-"));
  const settings = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settings, JSON.stringify({
    model: "opus",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }] },
  }, null, 2));

  await cli(home, ["install"]);
  await cli(home, ["install"]);
  const after = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(after.model, "opus");
  assert.deepEqual(after.hooks.PreToolUse, [
    { matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] },
    { matcher: "Agent|Task", hooks: [{ type: "command", command: "caveman-router-hook" }] },
  ]);
  assert.deepEqual(after.hooks.SubagentStop, [{ hooks: [{ type: "command", command: "caveman-router-hook" }] }]);

  const status = await cli(home, ["status"]);
  assert.match(status.stdout, /hook {8}installed/);
  assert.match(status.stdout, /key {9}missing/);

  await cli(home, ["uninstall"]);
  const removed = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(removed.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }]);
  assert.deepEqual(removed.hooks.SubagentStop, []);
});

test("login writes url and key, and status reads them back", async () => {
  const home = mkdtempSync(join(tmpdir(), "router-login-"));
  await cli(home, ["login", "--url", "http://127.0.0.1:8096", "--key", "crk_dev"]);
  const status = await cli(home, ["status"]);
  assert.match(status.stdout, /url {9}http:\/\/127\.0\.0\.1:8096/);
  assert.match(status.stdout, /key {9}set/);
  await cli(home, ["off"]);
  assert.match((await cli(home, ["status"])).stdout, /router {6}off/);
});

// A second `login` over a config an umask or an editor widened must narrow it
// back: writeFileSync's `mode` only applies to a file it creates.
test("login keeps the key file at 0600 even when it already exists wider", async () => {
  const home = mkdtempSync(join(tmpdir(), "router-cfg-"));
  const config = join(home, "state", "config.json");
  await cli(home, ["login", "--key", "crk_one"]);
  chmodSync(config, 0o644);
  await cli(home, ["login", "--key", "crk_two"]);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  // …and `status` never prints the key it just wrote.
  assert.ok(!(await cli(home, ["status"])).stdout.includes("crk_two"));
});
