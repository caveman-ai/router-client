import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The command Claude Code runs. The bin name is on PATH after a global install. */
export const HOOK_COMMAND = "caveman-router-hook";

// PreToolUse is matcher-scoped to the spawn tools so the hook process never
// starts for anything else; SubagentStop carries the child's cost back.
const ENTRIES: Array<{ event: string; matcher?: string }> = [
  { event: "PreToolUse", matcher: "Agent|Task" },
  { event: "SubagentStop" },
];

export function settingsPath(project: boolean): string {
  return project ? join(process.cwd(), ".claude", "settings.json") : join(homedir(), ".claude", "settings.json");
}

export function readSettings(path: string): Record<string, unknown> | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch (error) {
    // A missing file is an empty settings file; anything else (a parse error, a
    // permission error) must not be overwritten.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
  }
}

function isOurs(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => typeof (h as { command?: unknown })?.command === "string"
    && (h as { command: string }).command.includes(HOOK_COMMAND));
}

export function writeSettings(path: string, root: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic: a partial write here is somebody's whole settings.json — every
  // other hook, every permission — truncated by a full disk or a Ctrl-C.
  const temp = `${path}.caveman-router.tmp`;
  writeFileSync(temp, JSON.stringify(root, null, 2) + "\n");
  renameSync(temp, path);
}

/** Idempotent: an existing entry for this command is left exactly as it is. */
export function installHooks(path: string): boolean {
  const root = readSettings(path);
  if (!root) return false;
  const hooks = (root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks))
    ? (root.hooks as Record<string, unknown>) : {};
  for (const { event, matcher } of ENTRIES) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (!list.some(isOurs)) {
      list.push(matcher === undefined
        ? { hooks: [{ type: "command", command: HOOK_COMMAND }] }
        : { matcher, hooks: [{ type: "command", command: HOOK_COMMAND }] });
    }
    hooks[event] = list;
  }
  root.hooks = hooks;
  writeSettings(path, root);
  return true;
}

export function uninstallHooks(path: string): boolean {
  const root = readSettings(path);
  if (!root) return false;
  const hooks = root.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;
  let removed = false;
  for (const { event } of ENTRIES) {
    if (!Array.isArray(hooks[event])) continue;
    const list = hooks[event] as unknown[];
    const kept = list.filter((entry) => !isOurs(entry));
    if (kept.length !== list.length) removed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removed && Object.keys(hooks).length === 0) delete root.hooks;
  if (removed) writeSettings(path, root);
  return removed;
}

export function hooksInstalled(path: string): boolean {
  const root = readSettings(path);
  const hooks = root?.hooks as Record<string, unknown> | undefined;
  return ENTRIES.every(({ event }) => Array.isArray(hooks?.[event]) && (hooks![event] as unknown[]).some(isOurs));
}
