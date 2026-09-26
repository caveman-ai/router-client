#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { configureClaudeCode, decodePrevious, isClaudeModel, teardownClaudeCode } from "./claude-code.js";
import { configureCodex, teardownCodex } from "./codex.js";
import { loadState, saveState } from "./files.js";
import { configureOpencode, teardownOpencode } from "./opencode.js";
import { ROUTERD, onPath, parseStatus, routerd, routerdOnPath, waitForHealth } from "./routerd.js";
import type { PoolModel } from "./routerd.js";

const HARNESSES = ["claude-code", "codex", "opencode"] as const;
type HarnessName = (typeof HARNESSES)[number];
const MODES = ["agent", "balanced", "cost-efficient"];

/** Presets name catalog ids by provider; setup keeps the ones you have access
 * to. `balanced` is caveman-routerd's own default pool. */
export const PRESETS: Record<string, string[]> = {
  frontier: ["anthropic/claude-opus-5-5", "openai/gpt-6-astra"],
  balanced: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5", "openai/gpt-6-astra", "openai/gpt-5.6-sol"],
  cheap: ["anthropic/claude-sonnet-5", "openai/gpt-5.6-sol"],
};

const KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };

const [sub, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
}
const has = (name: string): boolean => rest.includes(`--${name}`);

class Stop extends Error {}
function fail(message: string): never {
  throw new Stop(message);
}

function readAll(): Promise<string> {
  if (stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => { text += chunk; });
    stdin.on("end", () => resolve(text));
    stdin.on("error", () => resolve(text));
  });
}

const interactive = (): boolean => !!stdin.isTTY && !has("yes");

async function ask(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [${fallback}] `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function askSecret(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const internal = rl as unknown as { _writeToOutput: (text: string) => void };
  const write = internal._writeToOutput.bind(rl);
  internal._writeToOutput = (text: string) => { if (text.includes(question)) write(text); };
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
    stdout.write("\n");
  }
}

async function choose(name: string, question: string, options: string[], fallback: string): Promise<string> {
  const given = flag(name);
  if (given !== undefined) {
    if (!options.includes(given)) fail(`--${name} must be one of ${options.join("|")}`);
    return given;
  }
  if (!interactive()) return fallback;
  for (;;) {
    const answer = await ask(`${question} (${options.join("/")})`, fallback);
    if (options.includes(answer)) return answer;
    console.log(`  pick one of: ${options.join(", ")}`);
  }
}

function detectedHarnesses(): HarnessName[] {
  const found = HARNESSES.filter((harness) => onPath(harness === "claude-code" ? "claude" : harness));
  return found.length > 0 ? found : [...HARNESSES];
}

function parseHarnesses(value: string): HarnessName[] {
  if (value === "all") return [...HARNESSES];
  const list = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const item of list) if (!(HARNESSES as readonly string[]).includes(item)) fail(`unknown harness ${item} (claude-code, codex, opencode or all)`);
  return list as HarnessName[];
}

const vendor = (id: string): string => (isClaudeModel(id) ? "anthropic" : id.includes("/") ? id.split("/")[0]! : "");

async function setup(): Promise<void> {
  // 1. The daemon must be installed; this package never downloads binaries.
  if (!routerdOnPath()) {
    fail([
      `${ROUTERD} is not on your PATH.`,
      "It is the local routing daemon the harnesses talk to, and it ships separately from these npm packages.",
      `Install ${ROUTERD} for your platform, make sure \`${ROUTERD} status --json\` runs, then re-run \`caveman-router setup\`.`,
    ].join("\n"));
  }

  // 2. What to route, and with which credentials. Everything is asked before
  // anything is changed, so a missing key stops setup with nothing half-done.
  const harnesses = flag("harness") !== undefined
    ? parseHarnesses(flag("harness")!)
    : interactive() ? parseHarnesses(await ask("Harnesses to set up (claude-code,codex,opencode or all)", detectedHarnesses().join(","))) : detectedHarnesses();
  const claude = await choose("claude", "Claude access: your claude.ai subscription (Claude Code only), an API key, or none", ["subscription", "key", "none"], harnesses.includes("claude-code") ? "subscription" : "none");
  const openai = await choose("openai", "OpenAI access: an API key, your ChatGPT subscription (off by default, see README), or none", ["key", "subscription", "none"], "none");
  const openrouter = await choose("openrouter", "OpenRouter API key (any other model)", ["key", "none"], "none");
  let models: string[];
  if (flag("models")) models = flag("models")!.split(",").map((id) => id.trim()).filter(Boolean);
  else {
    const preset = await choose("preset", "Models to route between", Object.keys(PRESETS), "balanced");
    models = PRESETS[preset]!;
  }
  const mode = await choose("mode", "Routing mode", MODES, "agent");
  const claudeCliAdapter = has("claude-cli-adapter");
  const contextWindow = flag("context-window") === undefined ? undefined : Number(flag("context-window"));
  if (contextWindow !== undefined && !(Number.isInteger(contextWindow) && contextWindow > 0)) fail("--context-window takes a token count, e.g. 272000");

  const keys: Record<string, string> = {};
  for (const [provider, wanted] of [["anthropic", claude === "key"], ["openai", openai === "key"], ["openrouter", openrouter === "key"]] as const) {
    if (!wanted) continue;
    const fromEnv = (process.env[KEY_ENV[provider]!] ?? "").trim();
    const key = fromEnv || (interactive() ? await askSecret(`${provider} API key (stored by ${ROUTERD} in your OS keychain): `) : "");
    if (!key) fail(`no ${provider} key: set ${KEY_ENV[provider]} or run setup interactively`);
    keys[provider] = key;
  }

  const access = new Set<string>();
  if (claude !== "none") access.add("anthropic");
  if (openai !== "none") access.add("openai");
  const pool = models.filter((id) => access.has(vendor(id)) || openrouter === "key");
  const dropped = models.filter((id) => !pool.includes(id));
  if (pool.length === 0) fail(`none of ${models.join(", ")} is reachable with the access you chose`);

  // 3. Keys go to the daemon over stdin, never onto argv or into a harness file.
  const state = loadState();
  for (const [provider, key] of Object.entries(keys)) {
    const stored = await routerd(["keys", "set", provider], key);
    if (stored.code !== 0) fail(`${ROUTERD} keys set ${provider} failed: ${stored.stderr.trim() || `exit ${stored.code}`}`);
    state.keys = [...new Set([...(state.keys ?? []), provider])];
  }
  saveState(state);

  // 4. Pool, mode and subscription switches into the daemon's config. The
  // daemon reads it at start, so this comes before (re)installing the service.
  const config: Array<[string, string]> = [
    ["mode", mode],
    ["pool.models", JSON.stringify(pool)],
    ["subscriptions.chatgpt", String(openai === "subscription")],
    ["subscriptions.claude_cli_adapter", String(claudeCliAdapter)],
  ];
  if (claude !== "none") config.push(["providers.anthropic.auth", claude === "subscription" ? "passthrough" : "key"]);
  for (const [key, value] of config) {
    const set = await routerd(["config", "set", key, value]);
    if (set.code !== 0) fail(`${ROUTERD} config set ${key} failed: ${set.stderr.trim() || `exit ${set.code}`}`);
  }
  // 5. The service (install-service restarts it on the new config), then its health.
  const installed = await routerd(["install-service"]);
  if (installed.code !== 0) fail(`${ROUTERD} install-service failed: ${installed.stderr.trim() || `exit ${installed.code}`}`);
  const healthMs = Number(process.env.CAVEMAN_SETUP_HEALTH_MS) || 15_000;
  if (!(await waitForHealth(healthMs))) fail(`${ROUTERD} did not answer on ~/.caveman/routerd.sock within ${Math.round(healthMs / 1000)} s; check \`${ROUTERD} status --json\``);

  const token = (await routerd(["token"])).stdout.trim();
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) fail(`${ROUTERD} token printed no usable token`);
  const status = parseStatus((await routerd(["status", "--json"])).stdout);
  const known = new Map(status.pool.map((model) => [model.id, model]));
  const poolInfo: PoolModel[] = pool.map((id) => known.get(id) ?? { id });

  // 6. Each harness. A Claude subscription reaches Claude models in Claude
  // Code only; elsewhere they need a key or the experimental CLI adapter.
  const outside = (models: PoolModel[]) => (claude === "subscription" && !claudeCliAdapter ? models.filter((model) => !isClaudeModel(model.id)) : models);
  const lines: string[] = [];
  const notes: string[] = [];
  const tests: string[] = [];
  for (const harness of harnesses) {
    try {
      if (harness === "claude-code") {
        const result = configureClaudeCode(state, { port: status.port, token, mode, pool: poolInfo, claude: claude as "subscription" | "key" | "none", ...(contextWindow ? { contextWindow } : {}) });
        lines.push(`  claude-code  ${result.path}${result.changed ? "" : " (already set up)"}`);
        notes.push(...result.notes);
        tests.push(`claude -p "which model are you?"`);
      } else if (harness === "codex") {
        const result = configureCodex(state, { port: status.port, token, mode });
        lines.push(`  codex        ${result.paths.join(", ")}${result.changed ? "" : " (already set up)"}`);
        notes.push(...result.notes);
        if (outside(poolInfo).length === 0) notes.push("codex: every pool model is a Claude subscription model, which Codex cannot use");
        tests.push(`codex exec --profile caveman "which model are you?"`);
      } else {
        const result = configureOpencode(state, { port: status.port, token, mode, pool: outside(poolInfo) });
        lines.push(`  opencode     ${result.paths.join(", ")}${result.changed ? "" : " (already set up)"}`);
        notes.push(...result.notes);
        tests.push(`opencode run -m caveman/auto "which model are you?"`);
      }
    } finally {
      saveState(state);
    }
  }

  // 7. Summary.
  console.log(`caveman-routerd  running on 127.0.0.1:${status.port}, mode ${mode}`);
  console.log(`pool             ${pool.join(", ")}`);
  if (dropped.length > 0) console.log(`skipped          ${dropped.join(", ")} (no access)`);
  console.log(`keys             ${Object.keys(keys).length > 0 ? `${Object.keys(keys).join(", ")} in ${ROUTERD}'s keychain` : "none stored"}`);
  if (claude === "subscription") console.log("claude           your claude.ai subscription, passed through unchanged in Claude Code only");
  if (openai === "subscription") console.log("chatgpt          subscriptions.chatgpt on (grey per OpenAI's terms; setup never reads ~/.codex/auth.json)");
  if (claudeCliAdapter) console.log("experimental     subscriptions.claude_cli_adapter on");
  console.log("configured");
  for (const line of lines) console.log(line);
  for (const note of notes) console.log(`note: ${note}`);
  console.log("backups: <file>.caveman-backup-<time> beside each edited file; undo: caveman-router teardown");
  console.log(`try: ${tests[0] ?? `${ROUTERD} status --json`}`);
}

async function teardown(): Promise<void> {
  const state = loadState();
  const only = flag("harness");
  const harnesses = only ? parseHarnesses(only) : [...HARNESSES];
  const lines: string[] = [];
  for (const harness of harnesses) {
    if (harness === "claude-code") lines.push(teardownClaudeCode(state));
    else if (harness === "codex") lines.push(...teardownCodex(state));
    else lines.push(...teardownOpencode(state));
    saveState(state);
  }
  // The whole thing: the service and the keys setup stored go too.
  if (!only && routerdOnPath()) {
    for (const provider of state.keys ?? []) {
      const removed = await routerd(["keys", "rm", provider]);
      lines.push(`${ROUTERD} keys rm ${provider}: ${removed.code === 0 ? "done" : "failed"}`);
    }
    state.keys = [];
    const uninstalled = await routerd(["uninstall-service"]);
    lines.push(`${ROUTERD} uninstall-service: ${uninstalled.code === 0 ? "done" : "failed"}`);
    saveState(state);
  }
  for (const line of lines.filter((line) => !line.endsWith(": unmanaged"))) console.log(line);
  console.log("restored = original bytes back; removed = setup created it; edited = only setup's keys taken out. Restart your harnesses.");
}

const USAGE = `usage:
  caveman-router setup [--harness claude-code,codex,opencode|all] [--models <ids> | --preset frontier|balanced|cheap]
                       [--claude subscription|key|none] [--openai key|subscription|none] [--openrouter key|none]
                       [--mode agent|balanced|cost-efficient] [--context-window <tokens>] [--claude-cli-adapter] [--yes]
  caveman-router teardown [--harness …]
  (used by the harnesses) caveman-router hook claude-code|codex · caveman-router statusline [--prev <b64>]`;

try {
  switch (sub) {
    case "setup": await setup(); break;
    case "teardown": await teardown(); break;
    case "hook":
      // Hooks never fail loudly: each runner catches everything and exits 0.
      if (rest[0] === "claude-code") await (await import("@caveman-ai/router-claude-code")).spawnHook();
      else if (rest[0] === "codex") await (await import("@caveman-ai/router-codex")).codexHook();
      break;
    case "statusline": {
      const previous = flag("prev");
      const { statuslineChain } = await import("@caveman-ai/router-claude-code");
      process.exitCode = await statuslineChain(await readAll(), previous ? decodePrevious(previous) : undefined);
      break;
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
