import { homedir } from "node:os";
import { join } from "node:path";
import { readText, restoreManaged, writeManaged } from "./files.js";
import type { SetupState } from "./files.js";
import { ROUTERD } from "./routerd.js";

// Codex CLI: one file of our own, the profile ~/.codex/caveman.config.toml.
// Codex (profile v2, verified against codex-cli 0.156) loads
// `<CODEX_HOME>/<name>.config.toml` as a layer over config.toml for
// `codex --profile <name>`. The provider, `model = "auto"` and the hooks all
// live in it, so plain `codex` sessions are untouched and config.toml is never
// edited. It is only read, to refuse a clash.

export const CODEX_HOOK_COMMAND = "caveman-router hook codex";
export const CODEX_PROFILE = "caveman";
const BEGIN = "# >>> caveman-router: managed by `caveman-router setup`; undo with `caveman-router teardown`";
const END = "# <<< caveman-router";

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export const codexProfilePath = (): string => join(codexHome(), `${CODEX_PROFILE}.config.toml`);

const tomlString = (value: string): string => JSON.stringify(value);

/** Codex hook groups (codex-rs/config HookEventsToml; timeouts in seconds). */
export const CODEX_HOOKS: Array<{ event: string; matcher?: string; timeout?: number; async?: boolean }> = [
  { event: "SessionStart", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "PreToolUse", matcher: "spawn_agent", timeout: 10 },
  { event: "PostToolUse", async: true },
  { event: "SubagentStop", async: true },
  { event: "Stop", async: true },
  { event: "Interrupt", async: true },
];

export function codexProfile(options: { port: number; token: string; mode: string }): string {
  const lines = [
    BEGIN,
    `# Use it with: codex --profile ${CODEX_PROFILE}`,
    `model_provider = "caveman"`,
    `model = "auto"`,
    "",
    "[model_providers.caveman]",
    `name = "Caveman (local router)"`,
    `base_url = ${tomlString(`http://127.0.0.1:${options.port}/v1`)}`,
    `wire_api = "responses"`,
    // A command auth provider makes Codex load its model catalog from
    // {base_url}/models, which caveman-routerd serves. The command prints the
    // local token; no provider key is ever written here.
    `auth = { command = ${tomlString(ROUTERD)}, args = ["codex-auth"] }`,
    `http_headers = { "x-caveman-local-token" = ${tomlString(options.token)}, "x-cave-routing-mode" = ${tomlString(options.mode)} }`,
  ];
  for (const hook of CODEX_HOOKS) {
    lines.push("", `[[hooks.${hook.event}]]`);
    if (hook.matcher) lines.push(`matcher = ${tomlString(hook.matcher)}`);
    lines.push(`[[hooks.${hook.event}.hooks]]`, `type = "command"`, `command = ${tomlString(CODEX_HOOK_COMMAND)}`);
    if (hook.timeout) lines.push(`timeout = ${hook.timeout}`);
    if (hook.async) lines.push("async = true");
  }
  lines.push(END, "");
  return lines.join("\n");
}

/** What Codex itself appended after our block (the hook trust it records in
 * the active profile file, `[hooks.state.…]`), kept across re-runs so the
 * user does not have to trust the hooks again. */
function codexTail(current: string | undefined): string {
  if (!current) return "";
  const end = current.indexOf(`\n${END}\n`);
  return end === -1 ? "" : current.slice(end + END.length + 2);
}

const CAVEMAN_TABLE = /^(model_providers|profiles)\.caveman(\.|$)/;
const normalize = (key: string): string => key.trim().replace(/\s*\.\s*/g, ".").replace(/["']/g, "");
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** Where config.toml would clash with the profile: a caveman provider (the
 * layers would mix keys), a legacy `[profiles.caveman]` table or `profile =
 * "caveman"` (Codex refuses `--profile caveman` with either). undefined when
 * it is safe. Comments and multi-line strings are skipped. */
export function clash(text: string): string | undefined {
  let table = "";
  let multiline: string | null = null;
  for (const raw of text.split("\n")) {
    if (multiline) {
      if (countOf(raw, multiline) % 2 === 1) multiline = null;
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\[?([^\]]+)\]\]?/.exec(line);
    if (header) {
      table = normalize(header[1]!);
      if (CAVEMAN_TABLE.test(table)) return `[${header[1]!.trim()}]`;
      continue;
    }
    const assignment = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=(.*)$/.exec(line);
    if (!assignment) continue;
    const key = normalize(assignment[1]!);
    const full = table ? `${table}.${key}` : key;
    const value = assignment[2]!.replace(/#.*$/, "").trim();
    if (CAVEMAN_TABLE.test(full)) return full;
    if (full === "profile" && /^["']caveman["']$/.test(value)) return `profile = "caveman"`;
    if (full === "model_providers" || full === "profiles") {
      if (/\bcaveman\s*=/.test(value)) return `${full} = { caveman = … }`;
    }
    for (const delimiter of ['"""', "'''"]) {
      if (countOf(assignment[2]!, delimiter) % 2 === 1) { multiline = delimiter; break; }
    }
  }
  return undefined;
}

export type CodexResult = { paths: string[]; changed: boolean; notes: string[] };

export function configureCodex(state: SetupState, options: { port: number; token: string; mode: string }): CodexResult {
  const configPath = join(codexHome(), "config.toml");
  const profilePath = codexProfilePath();
  const problem = clash(readText(configPath) ?? "");
  if (problem) throw new Error(`${configPath} already has ${problem}; not touching Codex. Remove it and re-run.`);
  const current = readText(profilePath);
  if (current !== undefined && !current.startsWith(BEGIN)) throw new Error(`${profilePath} exists and is not ours; not touching it`);
  const changed = writeManaged(state, profilePath, codexProfile(options) + codexTail(current));
  return {
    paths: [profilePath],
    changed,
    notes: [`codex: start it with \`codex --profile ${CODEX_PROFILE}\`; on first start it asks you to trust the caveman-router hooks (they steer spawn_agent)`],
  };
}

export function teardownCodex(state: SetupState): string[] {
  const profilePath = codexProfilePath();
  // The whole file is ours (plus Codex's trust records for our hooks).
  return [`${profilePath}: ${restoreManaged(state, profilePath, () => false)}`];
}
