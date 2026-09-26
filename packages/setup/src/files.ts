import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { daemonHome } from "@caveman-ai/router-client";

// Every file setup edits goes through here: a timestamped backup before each
// change, an atomic write, and a record of what setup wrote. Teardown uses the
// record: a file nobody touched since setup gets its original bytes back; a
// file someone edited since gets only setup's own keys taken out.

export type FileRecord = {
  /** Did the file exist before setup first touched it? */
  existed: boolean;
  /** The pre-setup copy, or null once the file was edited outside setup. */
  backup: string | null;
  /** sha256 of what setup last wrote. */
  written: string;
  /** JSON keys setup set (path key → value) and what they were before. */
  set?: Record<string, unknown>;
  prior?: Record<string, unknown>;
  /** Anything else a writer must remember (the prior statusline, hooks …). */
  extra?: Record<string, unknown>;
};

export type SetupState = { version: 1; files: Record<string, FileRecord>; keys?: string[] };

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export function statePath(): string {
  return join(daemonHome(), "router-setup.json");
}

export function loadState(): SetupState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as SetupState;
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") return parsed;
  } catch { /* first run */ }
  return { version: 1, files: {} };
}

export function saveState(state: SetupState): void {
  atomicWrite(statePath(), JSON.stringify(state, null, 2) + "\n", 0o600);
}

/** undefined when the file does not exist; any other read error throws, so a
 * file we cannot read is never overwritten. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function atomicWrite(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.caveman-router.tmp`;
  writeFileSync(temp, text, mode === undefined ? undefined : { mode });
  renameSync(temp, path);
}

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function backup(path: string): string {
  let target = `${path}.caveman-backup-${stamp()}`;
  for (let n = 1; existsSync(target); n++) target = `${path}.caveman-backup-${stamp()}-${n}`;
  copyFileSync(path, target);
  return target;
}

/** The record for `path`, created on first touch. A file edited outside setup
 * since setup last wrote it loses its verbatim restore: its backup predates
 * edits that restoring it would throw away. */
export function recordFor(state: SetupState, path: string): FileRecord {
  const current = readText(path);
  let record = state.files[path];
  if (!record) {
    record = { existed: current !== undefined, backup: null, written: "" };
    state.files[path] = record;
  } else if (current !== undefined && sha(current) !== record.written) {
    record.backup = null;
  }
  return record;
}

/** Writes `next` if it differs from what is on disk; false when it was
 * already there (an idempotent re-run writes and backs up nothing). */
export function writeManaged(state: SetupState, path: string, next: string): boolean {
  const record = recordFor(state, path);
  const current = readText(path);
  if (current === next) {
    record.written = sha(next);
    return false;
  }
  if (current !== undefined) {
    const copy = backup(path);
    // Only the first backup is the pre-setup original.
    if (record.written === "" && record.existed) record.backup = copy;
  }
  atomicWrite(path, next);
  record.written = sha(next);
  return true;
}

export type Restored = "restored" | "removed" | "edited" | "missing" | "unmanaged";

/** Undoes setup for one file. `surgical` takes the current text and returns
 * it without setup's changes (null: leave it as it is; false: the file is
 * wholly setup's, delete it). */
export function restoreManaged(state: SetupState, path: string, surgical: (current: string, record: FileRecord) => string | null | false): Restored {
  const record = state.files[path];
  if (!record) return "unmanaged";
  const current = readText(path);
  delete state.files[path];
  if (current === undefined) return "missing";
  if (sha(current) === record.written) {
    if (!record.existed) { unlinkSync(path); return "removed"; }
    if (record.backup && existsSync(record.backup)) {
      atomicWrite(path, readFileSync(record.backup, "utf8"));
      return "restored";
    }
  }
  const next = surgical(current, record);
  if (next === false) { unlinkSync(path); return "removed"; }
  if (next === null || next === current) return "edited";
  backup(path);
  atomicWrite(path, next);
  return "edited";
}

// ------------------------------------------------------------ JSON key edits

export const ABSENT = { $absent: true };
const isAbsent = (value: unknown): boolean => !!value && typeof value === "object" && (value as { $absent?: unknown }).$absent === true;

export type Json = Record<string, unknown>;
const splitKey = (key: string): string[] => key.split(".");

function getPath(root: Json, path: string[]): unknown {
  let node: unknown = root;
  for (const part of path) {
    if (!node || typeof node !== "object" || Array.isArray(node) || !(part in (node as Json))) return ABSENT;
    node = (node as Json)[part];
  }
  return node;
}

function setPath(root: Json, path: string[], value: unknown): void {
  let node = root;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) node[part] = {};
    node = node[part] as Json;
  }
  if (isAbsent(value)) delete node[path[path.length - 1]!];
  else node[path[path.length - 1]!] = value;
  // An object setup emptied (env: {}) goes with its last key.
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = getPath(root, path.slice(0, depth));
    if (parent && typeof parent === "object" && !isAbsent(parent) && Object.keys(parent as Json).length === 0) {
      setPath(root, path.slice(0, depth), ABSENT);
    } else break;
  }
}

export const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Sets exactly `desired` (dotted keys; the parts must not contain dots) and
 * remembers each key's pre-setup value once. Keys an earlier run set that this
 * run does not want are put back. */
export function applyKeys(root: Json, record: FileRecord, desired: Record<string, unknown>): void {
  record.set ??= {};
  record.prior ??= {};
  for (const key of Object.keys(record.set)) {
    if (key in desired) continue;
    if (equal(getPath(root, splitKey(key)), record.set[key])) setPath(root, splitKey(key), record.prior[key] ?? ABSENT);
    delete record.set[key];
    delete record.prior[key];
  }
  for (const [key, value] of Object.entries(desired)) {
    if (!(key in record.prior)) record.prior[key] = getPath(root, splitKey(key));
    setPath(root, splitKey(key), value);
    record.set[key] = value;
  }
}

/** Puts back every key setup set that still holds setup's value; a key the
 * user changed since stays as the user left it. */
export function restoreKeys(root: Json, record: FileRecord): void {
  for (const [key, value] of Object.entries(record.set ?? {})) {
    if (equal(getPath(root, splitKey(key)), value)) setPath(root, splitKey(key), record.prior?.[key] ?? ABSENT);
  }
}

export function currentValue(root: Json, key: string): unknown {
  const value = getPath(root, splitKey(key));
  return isAbsent(value) ? undefined : value;
}

/** Parses a JSON object file; undefined for a file that is not one (setup then
 * refuses to touch it rather than overwrite somebody's config). */
export function parseJsonObject(text: string | undefined): Json | undefined {
  if (text === undefined || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Serialises with the file's own indentation. */
export function formatJson(root: Json, original: string | undefined): string {
  const indent = original ? /^([ \t]+)"/m.exec(original)?.[1] ?? "  " : "  ";
  return JSON.stringify(root, null, indent) + "\n";
}
