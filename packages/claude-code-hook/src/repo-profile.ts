import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { RepoProfile } from "@caveman-ai/router-client";
import { routerHome } from "./config.js";

// The shape of the repository the session works in: file count, byte total,
// languages by file count, test files. Counts and names only — no path and no
// content leaves the machine. Read off the committed tree (`git ls-tree -l`
// carries sizes), cached per (cwd, HEAD) so a commit costs one walk.

export const PROFILE_BUDGET_MS = 300;
const MAX_LANGUAGES = 8;

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp",
  ".cxx": "cpp", ".hpp": "cpp", ".cs": "csharp", ".swift": "swift", ".scala": "scala",
  ".sh": "shell", ".bash": "shell", ".sql": "sql", ".html": "html", ".css": "css",
  ".scss": "css", ".vue": "vue", ".svelte": "svelte", ".dart": "dart", ".ex": "elixir",
  ".exs": "elixir", ".lua": "lua", ".zig": "zig",
};

const TEST_FILE_RE = /(_test\.go|\.(test|spec)\.[^/]+|(^|\/)test_[^/]*\.py)$|(^|\/)tests?\//;

/** Parses `git ls-tree -r -l -z` output: `<mode> <type> <sha> <size>\t<path>\0`.
 * Submodules (type commit, size `-`) are not files of this repository. */
export function profileFromLsTree(out: string): RepoProfile {
  let files = 0;
  let bytes = 0;
  let testFiles = 0;
  const counts = new Map<string, number>();
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [, type, , size] = record.slice(0, tab).split(/ +/);
    if (type !== "blob") continue;
    const path = record.slice(tab + 1);
    files += 1;
    bytes += Number(size) || 0;
    if (TEST_FILE_RE.test(path)) testFiles += 1;
    const language = LANGUAGES[extname(path).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const languages = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_LANGUAGES).map(([name]) => name);
  return { files, bytes, languages, test_files: testFiles };
}

function git(cwd: string, args: string[], timeout: number): string {
  // fsmonitor off: a hook must never start a repository's configured daemon.
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  });
}

function cachePath(cwd: string): string {
  return join(routerHome(), "spawn", `repo-${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`);
}

/** The profile for `cwd`, or undefined when it is not a git repository, git is
 * slow or missing, or anything else fails. Never throws. */
export function repoProfile(cwd: unknown, budgetMs = PROFILE_BUDGET_MS): RepoProfile | undefined {
  const budget = Math.min(budgetMs, PROFILE_BUDGET_MS);
  // execFileSync reads a timeout of 0 as "no timeout".
  if (typeof cwd !== "string" || !cwd || !(budget > 0)) return undefined;
  const started = Date.now();
  const left = () => budget - (Date.now() - started);
  try {
    const head = git(cwd, ["rev-parse", "HEAD"], left()).trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) return undefined;
    const path = cachePath(cwd);
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as { cwd?: unknown; head?: unknown; profile?: RepoProfile };
      if (cached.cwd === cwd && cached.head === head && cached.profile) return cached.profile;
    } catch { /* no cache for this cwd yet */ }
    const remaining = left();
    if (remaining <= 0) return undefined;
    const profile = profileFromLsTree(git(cwd, ["ls-tree", "-r", "-l", "-z", "--full-tree", head], remaining));
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ cwd, head, profile }));
    } catch { /* an unwritable home costs a re-walk next spawn */ }
    return profile;
  } catch {
    return undefined;
  }
}
