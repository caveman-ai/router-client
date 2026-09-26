import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { DAEMON_PORT, daemonHealthy } from "@caveman-ai/router-client";

// Setup drives the daemon only through its CLI (the routerd contract): it never
// writes ~/.caveman/routerd.toml or the keychain itself.

export const ROUTERD = "caveman-routerd";

export function onPath(bin: string): string | undefined {
  const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
    }
  }
  return undefined;
}

export const routerdOnPath = (): string | undefined => onPath(ROUTERD);

export type RunResult = { code: number; stdout: string; stderr: string };

export function routerd(args: string[], input?: string, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(ROUTERD, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.stdin.on("error", () => { /* the command may not read stdin */ });
    child.stdin.end(input ?? "");
  });
}

export async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await daemonHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export type PoolModel = { id: string; context?: number; output?: number };
export type DaemonStatus = { port: number; pool: PoolModel[] };

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** `status --json`. The contract leaves pool entries' shape open, so both a
 * bare id and an object with a context window are read. */
export function parseStatus(stdout: string): DaemonStatus {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(stdout) ?? {}; } catch { /* defaults */ }
  const pool: PoolModel[] = [];
  for (const entry of Array.isArray(parsed.pool) ? parsed.pool : []) {
    if (typeof entry === "string") { pool.push({ id: entry }); continue; }
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : "";
    if (!id) continue;
    const context = positive(item.context_window) ?? positive(item.context);
    const output = positive(item.max_output_tokens) ?? positive(item.max_output) ?? positive(item.output);
    pool.push({ id, ...(context ? { context } : {}), ...(output ? { output } : {}) });
  }
  return { port: positive(parsed.port) ?? DAEMON_PORT, pool };
}
