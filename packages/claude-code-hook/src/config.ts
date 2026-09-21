import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ROUTER_URL } from "@caveman-ai/router-client";

/** State root: the config file, the latency samples and the per-session
 * decision records. Overridable so a test never touches a real home. */
export function routerHome(): string {
  return process.env.CAVEMAN_ROUTER_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "caveman-router");
}

export function configPath(): string {
  return join(routerHome(), "config.json");
}

type StoredConfig = { url?: unknown; key?: unknown; router?: unknown };

function stored(): StoredConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

/** Env first so one session can point at a different router without editing a
 * file; the config file is what `login` wrote; the default is hosted. */
export function routerURL(): string {
  const env = (process.env.ROUTER_URL ?? "").trim();
  if (env) return env;
  const value = stored().url;
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ROUTER_URL;
}

export function routerKey(): string {
  const env = (process.env.ROUTER_API_KEY ?? "").trim();
  if (env) return env;
  const value = stored().key;
  return typeof value === "string" ? value.trim() : "";
}

export function writeConfig(patch: { url?: string; key?: string; router?: "on" | "off" }): void {
  const next = { ...stored(), ...patch };
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies when writeFileSync CREATES the file: a second `login`
  // over a config someone widened leaves the key world-readable.
  try { chmodSync(configPath(), 0o600); } catch { /* not ours to chmod */ }
}

/** The opt-out in one place: `ROUTER_OFF=1` for one session, `caveman-router-hook off`
 * persistently. Default is on — the golden path takes no flag. */
export function routerOn(): boolean {
  const env = (process.env.ROUTER_OFF ?? "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "off") return false;
  return stored().router !== "off";
}

export function latencyPath(): string {
  return join(routerHome(), "spawn", "latency.json");
}

/** The hook's own answer time, last 20 calls, so `status` reports a measured
 * p95 instead of the published target. */
export function recordLatency(ms: number): void {
  let kept: number[] = [];
  try {
    const previous = JSON.parse(readFileSync(latencyPath(), "utf8")) as unknown;
    if (Array.isArray(previous)) kept = previous.filter((value): value is number => typeof value === "number");
  } catch { /* first call on this machine */ }
  try {
    mkdirSync(dirname(latencyPath()), { recursive: true });
    writeFileSync(latencyPath(), JSON.stringify([...kept, Math.round(ms)].slice(-20)));
  } catch { /* an unwritable home never blocks a spawn */ }
}

/** Nearest-rank p95 over at most 20 samples — the slowest of them until there
 * are 20. No interpolation: a fabricated percentile is worse than a blunt one. */
export function latencyP95(): number | undefined {
  try {
    const samples = (JSON.parse(readFileSync(latencyPath(), "utf8")) as unknown[])
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);
    if (samples.length === 0) return undefined;
    return samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];
  } catch {
    return undefined;
  }
}

// A session id is joined into a file path, so it is validated before it is used
// as one: `--session ../../../secret` is a file write, not a session.
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type SpawnRecord = { decision_id: string; model: string };
export type SpawnState = { decisions?: Record<string, SpawnRecord>; denied?: boolean };

function statePath(session: string): string | undefined {
  return SESSION_ID_RE.test(session) ? join(routerHome(), "spawn", `${session}.json`) : undefined;
}

export function readSpawnState(session: string): SpawnState {
  const path = statePath(session);
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SpawnState) : {};
  } catch {
    return {};
  }
}

export function writeSpawnState(session: string, state: SpawnState): void {
  const path = statePath(session);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch { /* the decision still stands; only the outcome is lost */ }
}

/** The off switch rides the first line ever shown on this machine and never again. */
export function withOffSwitch(line: string): string {
  const marker = join(routerHome(), "spawn", "off-switch.json");
  if (existsSync(marker)) return line;
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ shown: true }) + "\n");
  } catch {
    return line;
  }
  return `${line} · caveman-router-hook off`;
}
