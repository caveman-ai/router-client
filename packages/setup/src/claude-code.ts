import { homedir } from "node:os";
import { join } from "node:path";
import type { PoolModel } from "./routerd.js";
import { applyKeys, currentValue, formatJson, parseJsonObject, readText, recordFor, restoreKeys, restoreManaged, writeManaged } from "./files.js";
import type { FileRecord, Json, SetupState } from "./files.js";

// Claude Code: user settings only. Base URL at the daemon, the local token and
// routing mode as custom headers, hint headers on, model auto, the hooks, and a
// statusline wrapper around whatever statusline the user already had.

export const CLAUDE_HOOK_COMMAND = "caveman-router hook claude-code";
export const STATUSLINE_COMMAND = "caveman-router statusline";
export const TOKEN_HEADER = "x-caveman-local-token";
export const MODE_HEADER = "x-cave-routing-mode";

const command = (extra: Record<string, unknown> = {}) => ({ type: "command", command: CLAUDE_HOOK_COMMAND, ...extra });

/** The hooks, also shipped as packages/claude-code-plugin/hooks/hooks.json.
 * Event-only hooks run async so Claude Code never waits on them. */
export const CLAUDE_HOOKS: Record<string, Array<Record<string, unknown>>> = {
  SessionStart: [{ hooks: [command({ timeout: 5 })] }],
  UserPromptSubmit: [{ hooks: [command({ timeout: 5 })] }],
  PreToolUse: [{ matcher: "Agent|Task", hooks: [command({ timeout: 10 })] }],
  // Agent only: other tool results reach the daemon on the proxied request.
  PostToolUse: [{ matcher: "Agent|Task", hooks: [command({ async: true })] }],
  Stop: [{ hooks: [command({ async: true })] }],
  SubagentStop: [{ hooks: [command({ async: true })] }],
};

export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

export const isClaudeModel = (id: string): boolean => /(^|\/)claude-/.test(id) || id.startsWith("anthropic/");

// Ours: this setup's hook command, or the older caveman-router-hook binary.
const ourCommand = (value: unknown): boolean =>
  typeof value === "string" && (value.startsWith(CLAUDE_HOOK_COMMAND) || value.includes("caveman-router-hook"));
const isOurGroup = (group: unknown): boolean =>
  Array.isArray((group as { hooks?: unknown })?.hooks) && ((group as { hooks: unknown[] }).hooks).some((hook) => ourCommand((hook as { command?: unknown })?.command));
const ourStatusLine = (value: unknown): boolean =>
  typeof (value as { command?: unknown })?.command === "string" && (value as { command: string }).command.startsWith(STATUSLINE_COMMAND);

const headerLines = (value: unknown): string[] =>
  (typeof value === "string" ? value : "").split("\n").map((line) => line.trim()).filter(Boolean);
const headerName = (line: string): string => line.split(":")[0]!.trim().toLowerCase();

export const encodePrevious = (command: string): string => Buffer.from(command, "utf8").toString("base64url");
export const decodePrevious = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

export type ClaudeOptions = { port: number; token: string; mode: string; pool: PoolModel[]; claude: "subscription" | "key" | "none"; contextWindow?: number };
export type ClaudeResult = { path: string; changed: boolean; notes: string[] };

function hooksWithout(root: Json, predicate: (group: unknown) => boolean): Record<string, unknown[]> {
  const hooks = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? { ...(root.hooks as Record<string, unknown[]>) } : {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((group) => !predicate(group));
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return hooks;
}

export function configureClaudeCode(state: SetupState, options: ClaudeOptions): ClaudeResult {
  const path = claudeSettingsPath();
  const original = readText(path);
  const root = parseJsonObject(original);
  if (!root) throw new Error(`${path} is not a JSON object; not touching it`);
  const record = recordFor(state, path);
  record.extra ??= {};
  const notes: string[] = [];

  // Our header lines replace any line with the same header name; the prior
  // value is restored whole on teardown.
  const priorHeaders = record.prior && "env.ANTHROPIC_CUSTOM_HEADERS" in record.prior
    ? record.prior["env.ANTHROPIC_CUSTOM_HEADERS"] : currentValue(root, "env.ANTHROPIC_CUSTOM_HEADERS");
  const lines = headerLines(priorHeaders).filter((line) => ![TOKEN_HEADER, MODE_HEADER].includes(headerName(line)));
  lines.push(`${TOKEN_HEADER}: ${options.token}`, `${MODE_HEADER}: ${options.mode}`);

  const desired: Record<string, unknown> = {
    "env.ANTHROPIC_BASE_URL": `http://127.0.0.1:${options.port}`,
    "env.ANTHROPIC_CUSTOM_HEADERS": lines.join("\n"),
    "env.CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
    model: "auto",
  };
  // API-key mode: Claude Code needs a credential to start without a claude.ai
  // login. It gets the LOCAL token; the Anthropic key stays in the daemon.
  if (options.claude === "key") desired["env.ANTHROPIC_AUTH_TOKEN"] = options.token;
  else {
    const conflict = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].find((name) => currentValue(root, `env.${name}`) && !(record.set?.[`env.${name}`]));
    if (conflict) notes.push(`env.${conflict} is set in ${path} and replaces your claude.ai subscription login`);
  }

  const others = options.pool.filter((model) => !isClaudeModel(model.id));
  if (others.length > 0) {
    // Claude Code allows ONE custom picker entry; the rest are one `/model <id>` away.
    desired["env.ANTHROPIC_CUSTOM_MODEL_OPTION"] = others[0]!.id;
    desired["env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"] = `${others[0]!.id} (Caveman)`;
    // `auto` is not a claude- id, so Claude Code sizes it by this variable:
    // the smallest window in the pool keeps compaction safe on any pick.
    const windows = options.pool.map((model) => model.context).filter((value): value is number => typeof value === "number");
    const smallest = options.contextWindow ?? (windows.length === options.pool.length ? Math.min(...windows) : undefined);
    if (smallest) desired["env.CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = String(smallest);
    else notes.push("the pool's context windows are unknown, so Claude Code assumes 200K for auto; pass --context-window <smallest window in tokens> to set CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    if (others.length > 1) notes.push(`other pool models: /model ${others.slice(1).map((model) => model.id).join(", /model ")}`);
  }

  // Statusline: wrap the user's own (the pre-setup one, not ours).
  const priorStatus = record.prior && "statusLine" in record.prior ? record.prior.statusLine : currentValue(root, "statusLine");
  const previous = priorStatus && !ourStatusLine(priorStatus) ? (priorStatus as { command?: unknown }).command : undefined;
  const statusLine: Record<string, unknown> = {
    type: "command",
    command: typeof previous === "string" && previous ? `${STATUSLINE_COMMAND} --prev ${encodePrevious(previous)}` : STATUSLINE_COMMAND,
  };
  const padding = (priorStatus as { padding?: unknown } | undefined)?.padding;
  if (padding !== undefined) statusLine.padding = padding;
  desired.statusLine = statusLine;

  applyKeys(root, record, desired);

  // Hooks: ours replace any earlier caveman entries; those are remembered and
  // come back on teardown.
  if (!("hooks" in record.extra)) {
    record.extra.hooks = hooksWithout(root, (group) => !isOurGroup(group));
  }
  const hooks = hooksWithout(root, isOurGroup);
  // The caveman-router plugin ships the same hooks: with it enabled, settings
  // get none, or every hook would run twice.
  const plugins = root.enabledPlugins && typeof root.enabledPlugins === "object" ? root.enabledPlugins as Record<string, unknown> : {};
  if (Object.entries(plugins).some(([name, on]) => name.startsWith("caveman-router@") && on === true)) {
    notes.push("the caveman-router plugin is enabled and supplies the hooks; none written to settings.json");
  } else {
    for (const [event, groups] of Object.entries(CLAUDE_HOOKS)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  if (Object.keys(hooks).length > 0) root.hooks = hooks;
  else delete root.hooks;

  const changed = writeManaged(state, path, formatJson(root, original));
  return { path, changed, notes };
}

function surgical(current: string, record: FileRecord): string | null {
  const root = parseJsonObject(current);
  if (!root) return null;
  // Our header lines go even if the user edited the rest of the header list.
  const headers = currentValue(root, "env.ANTHROPIC_CUSTOM_HEADERS");
  if (typeof headers === "string" && record.set && headers !== record.set["env.ANTHROPIC_CUSTOM_HEADERS"]) {
    const kept = headerLines(headers).filter((line) => !line.toLowerCase().startsWith(`${TOKEN_HEADER}:`));
    (root.env as Json).ANTHROPIC_CUSTOM_HEADERS = kept.join("\n");
    if (kept.length === 0) delete (root.env as Json).ANTHROPIC_CUSTOM_HEADERS;
  }
  restoreKeys(root, record);
  const hooks = hooksWithout(root, isOurGroup);
  for (const [event, groups] of Object.entries((record.extra?.hooks ?? {}) as Record<string, unknown[]>)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  if (Object.keys(hooks).length > 0) root.hooks = hooks;
  else delete root.hooks;
  return formatJson(root, current);
}

export function teardownClaudeCode(state: SetupState): string {
  const path = claudeSettingsPath();
  return `${path}: ${restoreManaged(state, path, surgical)}`;
}
