import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { RepoProfile } from "@caveman-ai/router-client";
import { routerHome } from "./config.js";

// The shape of the repository the session works in: file count, byte total,
// languages by file count, test files. Counts and names only — no path and no
// content leaves the machine. Read off the committed tree (`git ls-tree -l`
// carries sizes; a partial clone gets no sizes), cached per (cwd, HEAD) so a
// commit costs one walk.

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

// Every git call runs with lazy fetching off (a partial clone would otherwise
// download every missing blob `ls-tree -l` asks the size of), no credential
// prompt, and no optional index lock.
const GIT_ENV = { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

/** A git call that ran out of time. `bytes` is how much output it had streamed:
 * a walk that timed out after streaming a lot is a big tree, one that streamed
 * almost nothing was just a slow machine. */
class GitTimeout extends Error {
  constructor(readonly bytes = 0) { super("git timed out"); }
}

// ls-tree -l lines run ~100 bytes, so this is past the router's 2000-file
// `large` line; a timeout below it is load, not size.
const LARGE_TREE_BYTES = 128 * 1024;

/** Kill git and everything it started. POSIX: the process group. Windows has
 * no groups; taskkill /T walks the tree. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", detached: true }).unref();
    else process.kill(-pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** git in its own process group. At the deadline the WHOLE group is killed and
 * the promise settles at once, so a grandchild (a fetch helper, a credential
 * helper) cannot hold the pipe past the budget. */
function git(cwd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!(timeout > 0)) return reject(new GitTimeout());
    let child: ChildProcess;
    try {
      // fsmonitor off: a hook must never start a repository's configured daemon.
      child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd, detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...GIT_ENV },
      });
    } catch (error) {
      return reject(error);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | undefined, out = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.pid) killTree(child.pid);
        child.stdout?.destroy();
        // A detached child must not keep the hook's event loop alive.
        child.unref();
        reject(error);
      } else {
        resolve(out);
      }
    };
    const timer = setTimeout(() => finish(new GitTimeout(size)), timeout);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_MAX_OUTPUT) finish(new Error("git output too large"));
      else chunks.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(code === 0 ? undefined : new Error(`git exited ${code}`), Buffer.concat(chunks).toString("utf8")));
  });
}

function cachePath(cwd: string): string {
  return join(routerHome(), "spawn", `repo-${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`);
}

// The profile cached for a walk that did not finish in the budget. A tree that
// big is a large repository; caching it as large (the router buckets 2000+
// files as `large`) saves every later spawn the timeout and keeps it out of the
// permissive `unknown` bucket. It is a sentinel, not a count.
export const TIMED_OUT_PROFILE: RepoProfile = { files: 1_000_000 };

/** The profile for `cwd`, or undefined when it is not a git repository, git is
 * slow or missing, or anything else fails. Never throws. */
export async function repoProfile(cwd: unknown, budgetMs = PROFILE_BUDGET_MS): Promise<RepoProfile | undefined> {
  const budget = Math.min(budgetMs, PROFILE_BUDGET_MS);
  if (typeof cwd !== "string" || !cwd || !(budget > 0)) return undefined;
  const started = Date.now();
  const left = () => budget - (Date.now() - started);
  try {
    const head = (await git(cwd, ["rev-parse", "HEAD"], left())).trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) return undefined;
    const path = cachePath(cwd);
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as { cwd?: unknown; head?: unknown; profile?: RepoProfile };
      if (cached.cwd === cwd && cached.head === head && cached.profile) return cached.profile;
    } catch { /* no cache for this cwd yet */ }
    const save = (profile: RepoProfile) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ cwd, head, profile }));
      } catch { /* an unwritable home costs a re-walk next spawn */ }
      return profile;
    };
    // A partial clone has no local blobs to size: count files, skip the bytes.
    // Older git marks one with extensions.partialClone, newer with
    // remote.<name>.promisor = true.
    const partial = (await git(cwd, ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"], left()).catch((error) => {
      if (error instanceof GitTimeout) throw error;
      return ""; // exit 1: neither is set
    })).split("\n").some((line) => /^extensions\.partialclone \S/i.test(line) || /\.promisor (true|yes|on|1)$/i.test(line.trim()));
    const walkBudget = left();
    let out: string;
    try {
      out = await git(cwd, ["ls-tree", "-r", ...(partial ? [] : ["-l"]), "-z", "--full-tree", head], walkBudget);
    } catch (error) {
      // Only a walk that had most of the budget AND had streamed a big tree's
      // worth of output says the tree is large; a late start or a loaded
      // machine says nothing.
      if (error instanceof GitTimeout && walkBudget >= PROFILE_BUDGET_MS / 2 && error.bytes >= LARGE_TREE_BYTES) return save(TIMED_OUT_PROFILE);
      return undefined;
    }
    const profile = profileFromLsTree(out);
    if (partial) delete profile.bytes;
    return save(profile);
  } catch {
    return undefined;
  }
}
