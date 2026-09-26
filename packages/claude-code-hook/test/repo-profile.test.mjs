import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { profileFromLsTree, repoProfile } from "../dist/repo-profile.js";
import { orchestratorClause, touchedFromTranscript } from "../dist/index.js";

const LS_TREE = [
  "100644 blob 1111111111111111111111111111111111111111     120\tsrc/index.ts",
  "100644 blob 2222222222222222222222222222222222222222      80\tsrc/index.test.ts",
  "100644 blob 3333333333333333333333333333333333333333    1000\tsrc/app.tsx",
  "100644 blob 4444444444444444444444444444444444444444      50\tserver/main.go",
  "100644 blob 5555555555555555555555555555555555555555      30\tserver/main_test.go",
  "100644 blob 6666666666666666666666666666666666666666      10\ttests/test_api.py",
  "100644 blob 7777777777777777777777777777777777777777       5\tREADME.md",
  "160000 commit 8888888888888888888888888888888888888888       -\tvendor/lib",
].join("\0") + "\0";

test("ls-tree output becomes counts, a byte total and languages by file count", () => {
  assert.deepEqual(profileFromLsTree(LS_TREE), {
    files: 7,
    bytes: 1295,
    languages: ["typescript", "go", "python"],
    test_files: 3,
  });
  assert.deepEqual(profileFromLsTree(""), { files: 0, bytes: 0, languages: [], test_files: 0 });
});

test("at most eight languages, most files first", () => {
  const exts = ["ts", "go", "py", "rs", "java", "rb", "php", "c", "swift", "lua"];
  const lines = exts.flatMap((ext, i) => Array.from({ length: 20 - i }, (_, n) => `100644 blob ${"a".repeat(40)} 1\tf${n}.${ext}`));
  const { languages } = profileFromLsTree(lines.join("\0"));
  assert.deepEqual(languages, ["typescript", "go", "python", "rust", "java", "ruby", "php", "c"]);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "router-repo-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "a.go"), "package a\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  return { dir, git };
}

test("the profile is cached per HEAD and recomputed after a commit", async () => {
  const home = mkdtempSync(join(tmpdir(), "router-home-"));
  process.env.CAVEMAN_ROUTER_HOME = home;
  const { dir, git } = repo();
  // A generous budget: this asserts caching, not speed.
  assert.deepEqual(await repoProfile(dir, 300), { files: 1, bytes: 10, languages: ["go"], test_files: 0 });

  // Poison the cache: the same HEAD must be served from it, not re-walked.
  const [file] = readdirSync(join(home, "spawn")).filter((name) => name.startsWith("repo-"));
  const path = join(home, "spawn", file);
  const cached = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...cached, profile: { files: 99 } }));
  assert.deepEqual(await repoProfile(dir, 300), { files: 99 });

  writeFileSync(join(dir, "a_test.go"), "package a\n");
  git("add", ".");
  git("commit", "-q", "-m", "two");
  assert.deepEqual(await repoProfile(dir, 300), { files: 2, bytes: 20, languages: ["go"], test_files: 1 });
});

test("not a repo, no budget, or a git that hangs: no profile, fast", async () => {
  process.env.CAVEMAN_ROUTER_HOME = mkdtempSync(join(tmpdir(), "router-home-"));
  assert.equal(await repoProfile(mkdtempSync(join(tmpdir(), "router-plain-"))), undefined);
  assert.equal(await repoProfile(repo().dir, 0), undefined);
  assert.equal(await repoProfile(undefined), undefined);

  const real = repo().dir;
  const bin = mkdtempSync(join(tmpdir(), "router-bin-"));
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n");
  chmodSync(join(bin, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const started = Date.now();
    assert.equal(await repoProfile(real), undefined);
    assert.ok(Date.now() - started < 1000, `gave up on the hanging git (${Date.now() - started} ms)`);
  } finally {
    process.env.PATH = saved;
  }
});

test("a partial clone is counted without fetching a single blob", async () => {
  process.env.CAVEMAN_ROUTER_HOME = mkdtempSync(join(tmpdir(), "router-home-"));
  const { dir: source, git } = repo();
  writeFileSync(join(source, "b.go"), "package a\n\nfunc B() {}\n");
  git("add", ".");
  git("commit", "-q", "-m", "two");
  git("config", "uploadpack.allowFilter", "true");
  const clone = join(mkdtempSync(join(tmpdir(), "router-partial-")), "clone");
  execFileSync("git", ["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${source}`, clone], { stdio: "ignore" });
  const blob = execFileSync("git", ["rev-parse", "HEAD:b.go"], { cwd: clone, encoding: "utf8" }).trim();
  const missing = () => {
    try {
      execFileSync("git", ["cat-file", "-e", blob], { cwd: clone, stdio: "ignore", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
      return false;
    } catch { return true; }
  };
  assert.ok(missing(), "the clone starts without the blob");
  assert.deepEqual(await repoProfile(clone, 300), { files: 2, languages: ["go"], test_files: 0 });
  assert.ok(missing(), "profiling lazily fetched a blob");
});

test("a walk that runs out of time is cached as large, and a grandchild cannot hold it open", async () => {
  const home = mkdtempSync(join(tmpdir(), "router-home-"));
  process.env.CAVEMAN_ROUTER_HOME = home;
  const dir = mkdtempSync(join(tmpdir(), "router-big-"));
  const bin = mkdtempSync(join(tmpdir(), "router-bin-"));
  // ls-tree leaves a background grandchild holding stdout and exits: only a
  // process-group kill ends the walk before the grandchild does.
  writeFileSync(join(bin, "git"), `#!/bin/sh
echo "$GIT_NO_LAZY_FETCH$GIT_TERMINAL_PROMPT$GIT_OPTIONAL_LOCKS" > "${bin}/env"
case "$3" in
  rev-parse) echo 1111111111111111111111111111111111111111 ;;
  config) exit 1 ;;
  ls-tree) sleep 5 & exit 0 ;;
esac
`);
  chmodSync(join(bin, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const started = Date.now();
    assert.deepEqual(await repoProfile(dir, 300), { files: 1_000_000 });
    assert.ok(Date.now() - started < 1000, `walk held open (${Date.now() - started} ms)`);
    assert.equal(readFileSync(join(bin, "env"), "utf8").trim(), "100");
    const [file] = readdirSync(join(home, "spawn")).filter((name) => name.startsWith("repo-"));
    assert.deepEqual(JSON.parse(readFileSync(join(home, "spawn", file), "utf8")).profile, { files: 1_000_000 });
    // Served from the cache: no second 300 ms walk for the same HEAD.
    const again = Date.now();
    assert.deepEqual(await repoProfile(dir, 300), { files: 1_000_000 });
    assert.ok(Date.now() - again < 200, `re-walked (${Date.now() - again} ms)`);
  } finally {
    process.env.PATH = saved;
  }
});

test("touched counts distinct edited files and their directories", () => {
  const use = (name, input) => ({ type: "tool_use", id: `t${Math.random()}`, name, input });
  const text = [
    { type: "assistant", message: { content: [use("Edit", { file_path: "/r/src/a.ts" }), use("Read", { file_path: "/r/src/z.ts" })] } },
    { type: "assistant", message: { content: [use("Write", { file_path: "/r/src/b.ts" }), use("MultiEdit", { file_path: "/r/src/a.ts" })] } },
    { type: "assistant", message: { content: [use("NotebookEdit", { notebook_path: "/r/nb/x.ipynb" })] } },
    { type: "user", message: { content: [use("Edit", { file_path: "/r/other.ts" })] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n{partial";
  assert.deepEqual(touchedFromTranscript(text), { touched_files: 3, touched_dirs: 2 });
  assert.deepEqual(touchedFromTranscript(""), { touched_files: 0, touched_dirs: 0 });
});

test("orchestrator clause: only a different, non-kept recommendation", () => {
  const parent = "claude-sonnet-5-20260101";
  assert.equal(orchestratorClause({ model: "anthropic/claude-opus-5", reason: "ranked", applied: false }, parent), "orchestrator: opus recommended");
  assert.equal(orchestratorClause({ model: "openai/gpt-5.6", reason: "ranked" }, parent), "orchestrator: gpt-5.6 recommended");
  assert.equal(orchestratorClause({ model: "claude-sonnet-5", reason: "ranked" }, parent), "", "same family as the parent");
  assert.equal(orchestratorClause({ model: "anthropic/claude-opus-5", reason: "parent_kept" }, parent), "");
  assert.equal(orchestratorClause(undefined, parent), "");
  assert.equal(orchestratorClause({ model: 7 }, parent), "");
});
