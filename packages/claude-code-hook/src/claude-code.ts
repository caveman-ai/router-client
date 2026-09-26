import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { routerHome, routerKey, routerURL } from "./config.js";
import { HOOK_COMMAND, installHooks, readSettings, uninstallHooks, writeSettings } from "./install.js";

// Pointing Claude Code at the router is three settings keys and nothing else:
// the base URL, the token, and which model the router should pick. Everything
// past that is the router's job, not the client's.
export const STATUSLINE_COMMAND = `${HOOK_COMMAND} statusline`;
export const DEFAULT_MODEL = "auto";

/** `auto`, `auto:<a>,<b>` (a shortlist for the router) or a `vendor/model` id.
 * No whitespace: the value goes into settings.json and then onto a wire. */
export function validModel(name: string): boolean {
  if (name === "auto") return true;
  if (/^auto:[^\s,]+(,[^\s,]+)*$/.test(name)) return true;
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._:-]+)+$/.test(name);
}

function env(root: Record<string, unknown>): Record<string, unknown> {
  return root.env && typeof root.env === "object" && !Array.isArray(root.env)
    ? (root.env as Record<string, unknown>) : {};
}

function ourStatusLine(value: unknown): boolean {
  const command = (value as { command?: unknown })?.command;
  return typeof command === "string" && command.trim() === STATUSLINE_COMMAND;
}

export const HEADER_NAME = "x-cave-api-key";
/** `auto` routes the main loop as an agent turn. Static: Claude Code reads
 * ANTHROPIC_CUSTOM_HEADERS once at start, so no per-request header fits here. */
export const MODE_HEADER = "x-cave-routing-mode: agent";

const headerLines = (value: unknown): string[] =>
  String(typeof value === "string" ? value : "").split("\n").map((line) => line.trim()).filter(Boolean);
const isKeyHeader = (line: string): boolean => line.toLowerCase().startsWith(`${HEADER_NAME}:`);
const isModeHeader = (line: string): boolean => line.toLowerCase() === MODE_HEADER;

/** Claude Code's `ANTHROPIC_CUSTOM_HEADERS` is newline-separated `Name: value`
 * lines. Ours are the key line and the exact mode line; anyone else's lines —
 * a routing mode of their own included — survive untouched. */
function withoutOurHeader(value: unknown): string[] {
  return headerLines(value).filter((line) => !isKeyHeader(line) && !isModeHeader(line));
}

export type SetupOptions = { url: string; key: string; model: string; statusline: boolean; apiKey: boolean };
export type SetupResult = { changed: string[]; statuslineTaken: boolean; conflict?: string };

/** Subscription mode (default) never touches ANTHROPIC_AUTH_TOKEN, so Claude
 * Code keeps using the claude.ai login and Anthropic bills the subscription;
 * the router key rides a custom header instead. `--api-key` is the old way. */
export function setupClaudeCode(path: string, options: SetupOptions): SetupResult | undefined {
  const root = readSettings(path);
  if (!root) return undefined;
  const changed: string[] = [];
  const next = env(root);
  if (next.ANTHROPIC_BASE_URL !== options.url) changed.push("env.ANTHROPIC_BASE_URL");
  next.ANTHROPIC_BASE_URL = options.url;

  let conflict: string | undefined;
  // --api-key leaves a key line it finds (it only ever adds the token); the
  // subscription path re-appends it so a second setup is a no-op.
  const lines = headerLines(next.ANTHROPIC_CUSTOM_HEADERS).filter((line) => !isModeHeader(line) && (options.apiKey || !isKeyHeader(line)));
  if (options.apiKey) {
    if (next.ANTHROPIC_AUTH_TOKEN !== options.key) changed.push("env.ANTHROPIC_AUTH_TOKEN");
    next.ANTHROPIC_AUTH_TOKEN = options.key;
  } else {
    lines.push(`${HEADER_NAME}: ${options.key}`);
    conflict = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
      .find((name) => (typeof next[name] === "string" && next[name]) || process.env[name]);
  }
  // Both paths route the main loop when the model is auto; a fixed model is
  // not routed, and a routing-mode line of the user's own wins.
  const routed = options.model === "auto" || options.model.startsWith("auto:");
  if (routed && !lines.some((line) => line.toLowerCase().startsWith("x-cave-routing-mode:"))) lines.push(MODE_HEADER);
  const headers = lines.join("\n");
  if ((next.ANTHROPIC_CUSTOM_HEADERS ?? "") !== headers) changed.push("env.ANTHROPIC_CUSTOM_HEADERS");
  if (headers) next.ANTHROPIC_CUSTOM_HEADERS = headers;
  else delete next.ANTHROPIC_CUSTOM_HEADERS;
  root.env = next;
  if (root.model !== options.model) changed.push("model");
  root.model = options.model;

  let statuslineTaken = false;
  if (options.statusline) {
    const existing = root.statusLine;
    if (existing === undefined || ourStatusLine(existing)) {
      if (existing === undefined) changed.push("statusLine");
      root.statusLine = { type: "command", command: STATUSLINE_COMMAND };
    } else {
      statuslineTaken = true;
    }
  }
  writeSettings(path, root);
  // The spawn hooks route subagents too, and installHooks is idempotent.
  installHooks(path);
  return { changed, statuslineTaken, conflict };
}

/** Removes exactly what either mode writes — a model somebody else chose
 * (`opus`), a statusLine and a foreign custom header are left alone. */
export function teardownClaudeCode(path: string): string[] | undefined {
  const root = readSettings(path);
  if (!root) return undefined;
  const removed: string[] = [];
  const next = env(root);
  if ("ANTHROPIC_BASE_URL" in next) { delete next.ANTHROPIC_BASE_URL; removed.push("env.ANTHROPIC_BASE_URL"); }
  // Only a router key (crk_…) is ours to remove; a user's own Anthropic token
  // that setup merely warned about stays.
  if (typeof next.ANTHROPIC_AUTH_TOKEN === "string" && next.ANTHROPIC_AUTH_TOKEN.startsWith("crk_")) {
    delete next.ANTHROPIC_AUTH_TOKEN; removed.push("env.ANTHROPIC_AUTH_TOKEN");
  }
  if ("ANTHROPIC_CUSTOM_HEADERS" in next) {
    const kept = withoutOurHeader(next.ANTHROPIC_CUSTOM_HEADERS);
    if (kept.join("\n") !== next.ANTHROPIC_CUSTOM_HEADERS) removed.push("env.ANTHROPIC_CUSTOM_HEADERS");
    if (kept.length === 0) delete next.ANTHROPIC_CUSTOM_HEADERS;
    else next.ANTHROPIC_CUSTOM_HEADERS = kept.join("\n");
  }
  if (Object.keys(next).length === 0) delete root.env;
  else root.env = next;
  if (typeof root.model === "string" && validModel(root.model)) { delete root.model; removed.push("model"); }
  if (ourStatusLine(root.statusLine)) { delete root.statusLine; removed.push("statusLine"); }
  writeSettings(path, root);
  if (uninstallHooks(path)) removed.push("hooks");
  return removed;
}

/** What `status` reports, read back out of settings.json. */
export function setupMode(path: string): "subscription" | "api-key" | "not set up" {
  const root = readSettings(path);
  const next = root ? env(root) : {};
  if (typeof next.ANTHROPIC_BASE_URL !== "string" || !next.ANTHROPIC_BASE_URL) return "not set up";
  const headers = String(typeof next.ANTHROPIC_CUSTOM_HEADERS === "string" ? next.ANTHROPIC_CUSTOM_HEADERS : "");
  if (headers.split("\n").some((line) => line.trim().toLowerCase().startsWith(`${HEADER_NAME}:`))) return "subscription";
  return typeof next.ANTHROPIC_AUTH_TOKEN === "string" && next.ANTHROPIC_AUTH_TOKEN ? "api-key" : "subscription";
}

/** `model <name>` edits the same settings file setup wrote. */
export function setModel(path: string, name: string): boolean {
  const root = readSettings(path);
  if (!root) return false;
  root.model = name;
  writeSettings(path, root);
  return true;
}

export function configuredModel(path: string): string | undefined {
  const value = readSettings(path)?.model;
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------- statusline

export type SessionSummary = {
  decisions?: number;
  last?: { model?: string; task?: string; tier?: string } | null;
  measured_usd?: number;
  list_price_usd?: number;
  estimate_usd?: number;
};

const REFRESH_MS = 2000;
const FETCH_MS = 300;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function cachePath(session: string): string | undefined {
  return SESSION_ID_RE.test(session) ? join(routerHome(), "statusline", `${session}.json`) : undefined;
}

const usd = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** `auto → deepseek-v4-pro-0813 · code:repo_scan · 14 turns · $0.31` */
export function statusLine(head: string, summary: SessionSummary): string {
  const parts: string[] = [];
  const last = summary.last ?? undefined;
  const model = typeof last?.model === "string" ? last.model : "";
  parts.push(model ? `${head} → ${model.split("/").pop()}` : head);
  // ponytail: task wins over tier when both are present — the example line
  // carries one label, not two.
  const label = last?.task || last?.tier;
  if (label) parts.push(label);
  const decisions = typeof summary.decisions === "number" ? summary.decisions : 0;
  if (decisions > 0) parts.push(`${decisions} turn${decisions === 1 ? "" : "s"}`);
  const measured = usd(summary.measured_usd);
  const listPrice = usd(summary.list_price_usd);
  const estimate = usd(summary.estimate_usd);
  if (measured > 0) parts.push(`$${measured.toFixed(2)}`);
  else if (listPrice > 0) parts.push(`list $${listPrice.toFixed(2)}`);
  else if (estimate > 0) parts.push(`est. $${estimate.toFixed(2)}`);
  return parts.join(" · ");
}

async function fetchSummary(url: string, key: string, session: string): Promise<SessionSummary | undefined> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/v1/session?session_id=${encodeURIComponent(session)}`, {
      headers: { "x-cave-api-key": key },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? body as SessionSummary : undefined;
  } catch {
    return undefined;
  }
}

/** Runs on every render: at most one request per session per 2 s, never more
 * than 300 ms of wait, and any failure falls back to what Claude Code already
 * knows. Never writes stderr, never exits non-zero. */
export async function statuslineHook(stdin: string): Promise<string> {
  let event: Record<string, any> = {};
  try { event = JSON.parse(stdin || "{}") ?? {}; } catch { /* fall through */ }
  const fallback = typeof event?.model?.display_name === "string" ? event.model.display_name : "";
  const session = typeof event?.session_id === "string" ? event.session_id : "";
  const head = typeof event?.model?.id === "string" && event.model.id ? event.model.id : fallback;
  const url = routerURL();
  const key = routerKey();
  const path = cachePath(session);
  if (!session || !key || !url || !path) return fallback;

  let cached: { at?: number; line?: string } = {};
  try { cached = JSON.parse(readFileSync(path, "utf8")) ?? {}; } catch { /* no cache yet */ }
  if (typeof cached.line === "string" && typeof cached.at === "number" && Date.now() - cached.at < REFRESH_MS) {
    return cached.line;
  }
  const summary = await fetchSummary(url, key, session);
  if (!summary) return typeof cached.line === "string" ? cached.line : fallback;
  const line = statusLine(head, summary);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: Date.now(), line }));
  } catch { /* an unwritable home costs a refresh, not a render */ }
  return line;
}
