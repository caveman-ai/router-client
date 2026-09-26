import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../client/test/fake-daemon.mjs";

export const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
export const TOKEN = "0123456789abcdef0123456789abcdef";

// A stand-in caveman-routerd: logs argv (and stdin, to a separate file) and
// answers `token` and `status --json` the way the contract says.
const FAKE_ROUTERD = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(home, "routerd-calls.jsonl"), JSON.stringify(args) + "\\n");
  if (input) fs.appendFileSync(path.join(home, "routerd-stdin.jsonl"), JSON.stringify({ args, input }) + "\\n");
  if (args[0] === "token") process.stdout.write("${TOKEN}\\n");
  if (args[0] === "status") process.stdout.write(JSON.stringify({ running: true, port: 47821, version: "test", sessions: 0, brain: { ok: true, latency_ms: 3 },
    pool: process.env.FAKE_POOL_WINDOWS ? [
      { id: "anthropic/claude-opus-5-5", context_window: 1000000, max_output_tokens: 128000 },
      { id: "anthropic/claude-sonnet-5", context_window: 1000000, max_output_tokens: 64000 },
      { id: "openai/gpt-6-astra", context_window: 400000, max_output_tokens: 128000 },
      { id: "openai/gpt-5.6-sol", context_window: 272000, max_output_tokens: 64000 },
    ] : ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5", "openai/gpt-6-astra", "openai/gpt-5.6-sol"] }));
});
`;

export function box() {
  const home = tempHome("rs-");
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "caveman-routerd"), FAKE_ROUTERD, { mode: 0o755 });
  for (const dir of [".claude", ".codex", join(".config", "opencode")]) mkdirSync(join(home, dir), { recursive: true });
  // Credential files that must never be opened: a FIFO blocks whoever reads it,
  // so a read hangs the run and the test times out.
  execFileSync("mkfifo", [join(home, ".codex", "auth.json"), join(home, ".claude", ".credentials.json")]);
  return { home, bin };
}

export function run(env, args, { withDaemon = true, extraEnv = {}, input } = {}) {
  const PATH = withDaemon ? `${env.bin}:${process.env.PATH}` : process.env.PATH.split(":").filter((dir) => !dir.includes("caveman")).join(":");
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { cwd: env.home, env: { PATH, HOME: env.home, ...extraEnv } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

export const calls = (home) => {
  try { return readFileSync(join(home, "routerd-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
};
export const stdinOf = (home) => {
  try { return readFileSync(join(home, "routerd-stdin.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
};

/** Every regular file under home (FIFOs and sockets skipped), path → text. */
export function snapshot(home) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[full.slice(home.length + 1)] = readFileSync(full, "utf8");
    }
  };
  walk(home);
  return out;
}
