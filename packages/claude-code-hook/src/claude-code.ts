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

export type SetupOptions = { url: string; key: string; model: string; statusline: boolean };
export type SetupResult = { changed: string[]; statuslineTaken: boolean };

/** Merges exactly four keys and leaves every other one byte for byte. */
export function setupClaudeCode(path: string, options: SetupOptions): SetupResult | undefined {
  const root = readSettings(path);
  if (!root) return undefined;
  const changed: string[] = [];
  const next = env(root);
  if (next.ANTHROPIC_BASE_URL !== options.url) changed.push("env.ANTHROPIC_BASE_URL");
  if (next.ANTHROPIC_AUTH_TOKEN !== options.key) changed.push("env.ANTHROPIC_AUTH_TOKEN");
  next.ANTHROPIC_BASE_URL = options.url;
  next.ANTHROPIC_AUTH_TOKEN = options.key;
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
  return { changed, statuslineTaken };
}

/** Removes exactly what setup writes — a model somebody else chose (`opus`)
 * and a statusLine somebody else wrote are left alone. */
export function teardownClaudeCode(path: string): string[] | undefined {
  const root = readSettings(path);
  if (!root) return undefined;
  const removed: string[] = [];
  const next = env(root);
  for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
    if (key in next) { delete next[key]; removed.push(`env.${key}`); }
  }
  if (Object.keys(next).length === 0) delete root.env;
  else root.env = next;
  if (typeof root.model === "string" && validModel(root.model)) { delete root.model; removed.push("model"); }
  if (ourStatusLine(root.statusLine)) { delete root.statusLine; removed.push("statusLine"); }
  writeSettings(path, root);
  if (uninstallHooks(path)) removed.push("hooks");
  return removed;
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
  const estimate = usd(summary.estimate_usd);
  if (measured > 0) parts.push(`$${measured.toFixed(2)}`);
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
