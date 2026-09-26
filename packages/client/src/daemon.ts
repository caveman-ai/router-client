import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// The local side of caveman-routerd: HTTP over its control socket. Every call
// answers `undefined` on any failure — a missing socket, a refused connection,
// a slow daemon, a bad body — because every caller is a harness hook that must
// fail open and never hold the harness up.

export const DAEMON_PORT = 47821;
/** Windows has no unix socket: the control API listens on TCP and wants the
 * local token. The contract leaves the port open; this is the default we use. */
export const DAEMON_CONTROL_PORT = 47822;
export const EVENT_TIMEOUT_MS = 50;
export const SPAWN_TIMEOUT_MS = 2000;

export type DaemonHarness = "claude-code" | "codex" | "opencode";

/** `~/.caveman`, resolved per call so a test's temp HOME applies. */
export function daemonHome(): string {
  return join(homedir(), ".caveman");
}

export function socketPath(): string {
  return join(daemonHome(), "routerd.sock");
}

export function localToken(): string {
  try { return readFileSync(join(daemonHome(), "routerd.token"), "utf8").trim(); } catch { return ""; }
}

export type DaemonReply = { status: number; body: unknown };

/** One request with a hard wall-clock cap: the timer destroys the socket, so a
 * daemon that accepts and never answers costs exactly `timeoutMs`. */
export function daemonRequest(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<DaemonReply | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: DaemonReply | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
    const windows = process.platform === "win32";
    if (windows) headers["x-caveman-local-token"] = localToken();
    let req: ReturnType<typeof request>;
    try {
      req = request({
        method,
        path,
        headers,
        agent: false,
        ...(windows ? { host: "127.0.0.1", port: DAEMON_CONTROL_PORT } : { socketPath: socketPath() }),
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => {
          let parsed: unknown;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
          finish({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", () => finish(undefined));
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => { req.destroy(); finish(undefined); }, timeoutMs);
    req.on("error", () => finish(undefined));
    req.end(payload);
  });
}

const ok = (reply: DaemonReply | undefined): boolean => !!reply && reply.status >= 200 && reply.status < 300;

export async function daemonHealthy(timeoutMs = 500): Promise<boolean> {
  const reply = await daemonRequest("GET", "/health", undefined, timeoutMs);
  return ok(reply) && (reply!.body as { ok?: unknown } | undefined)?.ok === true;
}

export async function postEvent(harness: DaemonHarness, sessionId: string, kind: string, data: unknown, timeoutMs = EVENT_TIMEOUT_MS): Promise<boolean> {
  return ok(await daemonRequest("POST", "/hook/event", { harness, session_id: sessionId, kind, data }, timeoutMs));
}

export type PromptHook = { prompt_id?: string; cwd?: string; prompt_excerpt?: string; transcript_path?: string };

export async function postPrompt(harness: DaemonHarness, sessionId: string, prompt: PromptHook, timeoutMs = EVENT_TIMEOUT_MS): Promise<DaemonReply | undefined> {
  return daemonRequest("POST", "/hook/prompt", { harness, session_id: sessionId, ...prompt }, timeoutMs);
}

export type SpawnHook = { tool: "Agent" | "spawn_agent"; tool_input: unknown; parent: { model?: string; effort?: string }; cwd?: string };
export type SpawnDecision = { model: string | null; effort: string | null; line: string | null; decision_id: string | null };

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** `undefined` means the daemon did not answer (the caller may fall back);
 * a decision with every field null means it answered "leave it". */
export async function spawnDecision(harness: DaemonHarness, sessionId: string, spawn: SpawnHook, timeoutMs = SPAWN_TIMEOUT_MS): Promise<SpawnDecision | undefined> {
  const reply = await daemonRequest("POST", "/hook/spawn", { harness, session_id: sessionId, ...spawn }, timeoutMs);
  if (!ok(reply) || !reply!.body || typeof reply!.body !== "object") return undefined;
  const body = reply!.body as Record<string, unknown>;
  return { model: str(body.model), effort: str(body.effort), line: str(body.line), decision_id: str(body.decision_id) };
}
