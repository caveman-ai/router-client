import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { RouterClient } from "@caveman-ai/router-client";
import type { DelegateChildUsage, DelegateParent, DelegateResponse, RepoProfile } from "@caveman-ai/router-client";
import { readSpawnState, recordLatency, routerKey, routerOn, routerURL, withOffSwitch, writeSpawnState } from "./config.js";
import { PROFILE_BUDGET_MS, repoProfile } from "./repo-profile.js";

// The spawn actuator. On Claude Code's PreToolUse for an Agent/Task spawn it
// asks the router whether the child should run on a cheaper model and rewrites
// `tool_input.model` through `updatedInput`; on SubagentStop it posts what the
// child actually cost. EVERY failure path — no key, no numbers, a slow or
// unparsable reply — exits 0 with no stdout, which Claude Code reads as "run
// the spawn exactly as proposed".
//
// `systemMessage` reaches the human only, so the routing line never enters the
// model's context; `additionalContext` (what the model reads) stays empty.
export const SPAWN_BUDGET_MS = 2500;
// Under this much of the budget left there is no time to ask and no time for an
// answer to arrive: the spawn runs as proposed, silently.
const SPAWN_MIN_CALL_MS = 300;
const SPAWN_TAIL_BYTES = 256 * 1024;
const SPAWN_CHILD_MAX_BYTES = 16 * 1024 * 1024;
// A subagent_type is a file name under .claude/agents; anything with a slash, a
// leading dot or 64+ characters is not one and is never opened.
const SUBAGENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Claude Code's Agent tool takes a family ALIAS, never a model id.
const SPAWN_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);
// Claude Code writes far more `type: "user"` lines than there are human asks:
// hook output, slash-command echoes and caveats all ride the user role.
const TRANSCRIPT_META_PREFIXES = ["<command-name>", "<local-command-stdout>", "<local-command-caveat>", "<system-reminder>"];

function budgetMS(): number {
  const declared = Number(process.env.ROUTER_BUDGET_MS);
  return Number.isFinite(declared) && declared > 0 ? Math.min(declared, SPAWN_BUDGET_MS) : SPAWN_BUDGET_MS;
}

// ONE deadline for the whole hook, set at its entry: the transcript read, the
// frontmatter read and the decision call all spend the same budget, so a slow
// disk costs the classifier its time instead of costing the developer a longer
// pause than the hook promised.
let deadline = 0;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// transcriptText reads a hook-supplied transcript path. A hook event is input:
// `transcript_path` naming /etc/shadow is a file read, not a transcript. The
// resolved real path must sit under ~/.claude/projects and nothing else is
// opened; the read is a bounded tail, so a 40 MiB session costs milliseconds.
// `whole` refuses a file bigger than the bound instead of tailing it: a TAIL of
// a child transcript is a wrong sum, not a partial one.
function transcriptText(path: unknown, tailBytes: number, whole = false): string {
  if (typeof path !== "string" || !path) return "";
  let real: string;
  let root: string;
  try {
    real = realpathSync(path);
    root = realpathSync(join(homedir(), ".claude", "projects"));
  } catch {
    return "";
  }
  if (!real.startsWith(root + sep)) return "";
  let fd: number | undefined;
  try {
    fd = openSync(real, "r");
    const size = fstatSync(fd).size;
    if (whole && size > tailBytes) return "";
    const want = Math.min(size, tailBytes);
    const buffer = Buffer.allocUnsafe(want);
    readSync(fd, buffer, 0, want, size - want);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closing a read fd cannot fail usefully */ }
  }
}

// A tail starts mid-line and a live transcript can end mid-write: a line that is
// not a whole JSON object is skipped, never repaired.
function* entries(text: string): Generator<any> {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { yield JSON.parse(line); } catch { /* partial line */ }
  }
}

// parentFromTranscript reads the numbers the cost model needs off the tail. No
// usage line in the tail means an unknown context, and a cost comparison over a
// guessed context is forbidden: the caller then sends nothing.
export function parentFromTranscript(text: string): DelegateParent | undefined {
  let model = "";
  let usage: Record<string, unknown> | undefined;
  let turn = 0;
  const openChildren = new Set<string>();
  for (const entry of entries(text)) {
    const message = entry?.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    if (entry?.type === "assistant") {
      if (message?.usage && typeof message.usage === "object") usage = message.usage;
      if (typeof message?.model === "string") model = message.model;
      for (const block of content) {
        if (block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task") && typeof block.id === "string") openChildren.add(block.id);
      }
    }
    if (entry?.type === "user") {
      if (typeof message?.content === "string" && !entry.isMeta && !entry.isSidechain && !entry.isCompactSummary
        && !TRANSCRIPT_META_PREFIXES.some((prefix) => (message.content as string).startsWith(prefix))) turn += 1;
      for (const block of content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") openChildren.delete(block.tool_use_id);
      }
    }
  }
  if (!usage) return undefined;
  return {
    model,
    context_tokens: num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
    cache_read_tokens: num(usage.cache_read_input_tokens),
    // turn and children_active are counted over the 256 KiB tail, not the
    // session — a long session undercounts both. Neither can overcount, and the
    // endpoint only uses children_active to refuse a deny.
    turn,
    // The 1M-context build spells itself "…[1m]", which is a window the
    // catalogue cannot read off the id. Every other window the catalogue knows
    // better than the hook does, so an undeclared one stays absent: guessing
    // here moves the compaction horizon and every estimate hanging off it.
    ...(/\[1m\]/i.test(model) ? { window: 1_000_000 } : {}),
    children_active: openChildren.size,
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** How many distinct files, and directories, the session edited in the tail.
 * Counts only: the paths themselves never leave the hook. */
export function touchedFromTranscript(text: string): { touched_files: number; touched_dirs: number } {
  const files = new Set<string>();
  for (const entry of entries(text)) {
    if (entry?.type !== "assistant") continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of content) {
      if (block?.type !== "tool_use" || !EDIT_TOOLS.has(block.name)) continue;
      const path = block.input?.file_path ?? block.input?.notebook_path;
      if (typeof path === "string" && path) files.add(path);
    }
  }
  return { touched_files: files.size, touched_dirs: new Set([...files].map((path) => dirname(path))).size };
}

/** The git profile plus the tail's edit counts; zero edits add nothing, and
 * nothing at all means no `repo` field. */
async function sessionRepo(text: string, cwd: unknown): Promise<RepoProfile | undefined> {
  const budget = Math.min(PROFILE_BUDGET_MS, remainingMS() - SPAWN_MIN_CALL_MS);
  const touched = touchedFromTranscript(text);
  const repo: RepoProfile = {
    ...(budget > 0 ? await repoProfile(cwd, budget) : undefined),
    ...(touched.touched_files > 0 ? touched : {}),
  };
  return Object.keys(repo).length > 0 ? repo : undefined;
}

/** `ROUTER_AGENT_POOL=opus,sonnet` narrows the pool; unset, the router picks
 * its own Claude Code defaults. */
function agentPool(): string[] | undefined {
  const pool = (process.env.ROUTER_AGENT_POOL ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  return pool.length > 0 ? pool : undefined;
}

/** The router's advice for the PARENT, as a clause on the developer line. It is
 * never applied: Claude Code cannot switch the running session's model. */
export function orchestratorClause(orchestrator: unknown, parentModel: string): string {
  const advice = orchestrator as { model?: unknown; reason?: unknown } | undefined;
  if (!advice || typeof advice.model !== "string" || !advice.model || advice.reason === "parent_kept") return "";
  const name = claudeChildModel(advice.model).split("/").pop()!;
  return name === claudeChildModel(parentModel) ? "" : `orchestrator: ${name} recommended`;
}

// A model the developer wrote into `.claude/agents/<type>.md` frontmatter is a
// declaration, and the endpoint is told so rather than the hook deciding what
// to do about it.
function declaredChildModel(subagentType: string, cwd: unknown): boolean {
  if (!SUBAGENT_TYPE_RE.test(subagentType)) return false;
  const roots = [
    typeof cwd === "string" && cwd ? join(cwd, ".claude", "agents") : "",
    join(homedir(), ".claude", "agents"),
  ];
  for (const root of roots) {
    if (!root) continue;
    let text: string;
    try { text = readFileSync(join(root, `${subagentType}.md`), "utf8").slice(0, 4096); } catch { continue; }
    if (!text.startsWith("---")) continue;
    const end = text.indexOf("\n---", 3);
    if (/^model:[ \t]*\S+/m.test(end === -1 ? text : text.slice(0, end))) return true;
  }
  return false;
}

// Claude Code's Agent tool takes the short alias for Anthropic models and a full
// id for anything else.
function claudeChildModel(model: string): string {
  const family = /claude-(opus|sonnet|haiku)/.exec(model);
  return family ? family[1]! : model;
}

// …and it SENDS one too. An alias names a family, not a model, and the endpoint
// prices models — so it is expanded against the parent, the one concrete model
// the hook knows. A family the parent is not travels as the bare family for the
// catalogue to resolve into its newest member.
export function proposedModel(alias: string, parentModel: string): string {
  const name = alias.trim().toLowerCase();
  if (name === "" || name === "inherit") return parentModel;
  if (!SPAWN_MODEL_FAMILIES.has(name)) return alias;
  const parent = parentModel.toLowerCase();
  return parent.includes(`-${name}-`) || parent.endsWith(`-${name}`) ? parentModel : name;
}

function client(sessionId: string): RouterClient {
  return new RouterClient({ url: routerURL(), apiKey: routerKey(), ...(sessionId ? { sessionId } : {}) });
}

/** What is left of the hook's one deadline, spent by whatever ran before this:
 * the header is the router's budget and the abort is the hook's, so both sides
 * stop at the same instant the developer was promised. */
function remainingMS(): number {
  return deadline - Date.now();
}

async function decide(evt: Record<string, any>): Promise<void> {
  // PreToolUse is the only event whose output can rewrite a spawn. An Agent
  // tool_name arriving on any other event must not cost a decision call whose
  // answer nothing can apply.
  if (evt.hook_event_name !== undefined && evt.hook_event_name !== "PreToolUse") return;
  if (evt.tool_name !== "Agent" && evt.tool_name !== "Task") return;
  const input = (evt.tool_input && typeof evt.tool_input === "object" && !Array.isArray(evt.tool_input)
    ? evt.tool_input : {}) as Record<string, unknown>;
  const text = transcriptText(evt.transcript_path, SPAWN_TAIL_BYTES);
  const parent = parentFromTranscript(text);
  // No key, no call: do not spend a git walk on an answer that cannot come.
  if (!parent || !routerKey()) return;
  const repo = await sessionRepo(text, evt.cwd);
  const models = agentPool();
  const agent = typeof input.subagent_type === "string" ? input.subagent_type : "";
  const proposed = proposedModel(typeof input.model === "string" ? input.model : "", parent.model);
  const veto = (process.env.ROUTER_VETO ?? "") === "1";
  const session = typeof evt.session_id === "string" ? evt.session_id : "";
  const budget = remainingMS();
  if (budget < SPAWN_MIN_CALL_MS) return;
  const started = Date.now();
  const result = await client(session).delegate({
    parent,
    task: {
      agent,
      description: typeof input.description === "string" ? input.description : "",
      prompt: typeof input.prompt === "string" ? input.prompt : "",
      model: proposed,
      // A declaration is the definition's FRONTMATTER and nothing else: the
      // model on the call is the harness's own alias, which the model in the
      // loop wrote, and treating it as a human's choice would exempt every
      // spawn Claude Code makes from routing.
      model_declared: declaredChildModel(agent, evt.cwd),
      background: input.run_in_background === true,
    },
    harness: { kind: "claude-code" },
    ...(repo ? { repo } : {}),
    ...(models ? { models } : {}),
    // The endpoint only reports inline_recommended unless the caller says it
    // can act on it; the hook owns the deny.
    veto,
  }, { budgetMs: budget });
  recordLatency(Date.now() - started);
  if (!result.ok) return;
  const reply = result.data as Partial<DelegateResponse>;
  const clause = orchestratorClause(reply.orchestrator, parent.model);
  const said = typeof reply.line === "string" ? reply.line.trim() : "";
  // The clause rides a line and never makes one: a spawn left alone stays silent.
  const line = said && clause ? `${said} · ${clause}` : said;
  const delegate = (reply.delegate && typeof reply.delegate === "object" && !Array.isArray(reply.delegate)
    ? reply.delegate : {}) as Record<string, unknown>;
  const picked = typeof delegate.model === "string" ? delegate.model : "";

  if (veto && (reply.inline_recommended === true || reply.decision === "inline")) {
    // Deny safety: at most one per session. Every other guard — context over
    // 0.6 × window, a background spawn, another child active, a retry — is the
    // endpoint's call and already rides inline_recommended. The reason is the
    // endpoint's deny line and only that: it is the one sentence the MODEL
    // reads, and it must name what to do instead with both costs. No deny line,
    // no deny.
    const state = readSpawnState(session);
    const reason = typeof reply.deny_line === "string" ? reply.deny_line.trim() : "";
    if (!state.denied && reason) {
      writeSpawnState(session, { ...state, denied: true });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      }));
      return;
    }
  }
  const next = picked ? claudeChildModel(picked) : "";
  if (reply.decision === "delegate" && next && next !== (proposed ? claudeChildModel(proposed) : "")) {
    if (reply.collect === true && typeof reply.decision_id === "string" && typeof evt.tool_use_id === "string") {
      const state = readSpawnState(session);
      writeSpawnState(session, {
        ...state,
        decisions: { ...state.decisions, [evt.tool_use_id]: { decision_id: reply.decision_id, model: picked } },
      });
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input, model: next } },
      ...(line ? { systemMessage: withOffSwitch(line) } : {}),
    }));
    return;
  }
  // Nothing changed: a line here is the "kept for a reason" case, and silence is
  // the default — a spawn left alone gets no line at all.
  if (line) process.stdout.write(JSON.stringify({ systemMessage: withOffSwitch(line) }));
}

// childUsage sums the child's real cost off its own transcript. Claude Code
// writes one line per content block, so the same `message.id` repeats with the
// same usage: usage is taken once per message id (last wins, it is the complete
// one) and tool calls are counted by unique tool_use id.
export function childUsage(text: string): DelegateChildUsage | undefined {
  const usageByMessage = new Map<string, Record<string, unknown>>();
  const toolCalls = new Set<string>();
  let model = "";
  for (const entry of entries(text)) {
    if (entry?.type !== "assistant") continue;
    const message = entry.message;
    if (typeof message?.model === "string") model = message.model;
    if (message?.usage && typeof message.usage === "object") usageByMessage.set(String(message.id ?? usageByMessage.size), message.usage);
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool_use" && typeof block.id === "string") toolCalls.add(block.id);
    }
  }
  if (usageByMessage.size === 0) return undefined;
  const child: DelegateChildUsage = {
    model,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    output_tokens: 0,
    turns: usageByMessage.size,
    tool_calls: toolCalls.size,
    // The hook never reads the child's answer: result length is the router's to
    // measure, and 0 says "not measured here" rather than guessing one.
    result_chars: 0,
  };
  for (const usage of usageByMessage.values()) {
    child.input_tokens += num(usage.input_tokens);
    child.cache_read_tokens += num(usage.cache_read_input_tokens);
    child.cache_creation_tokens += num(usage.cache_creation_input_tokens);
    child.output_tokens += num(usage.output_tokens);
  }
  return child;
}

// The tool_use_id ↔ agent_id mapping is NOT guessed: SubagentStop carries
// agent_id and agent_transcript_path but no tool_use_id, and PostToolUse (which
// carries both) fires only AFTER SubagentStop — too late to report. Claude Code
// writes `<session>/subagents/agent-<id>.meta.json` beside the child transcript
// carrying the spawning `toolUseId`, which is the exact key the PreToolUse
// decision was filed under. No meta file, no mapping, no row.
async function report(evt: Record<string, any>): Promise<void> {
  const transcript = typeof evt.agent_transcript_path === "string" ? evt.agent_transcript_path : "";
  if (!transcript.endsWith(".jsonl")) return;
  const text = transcriptText(transcript, SPAWN_CHILD_MAX_BYTES, true);
  if (!text) return;
  let toolUseID = "";
  try {
    const meta = JSON.parse(transcriptText(`${transcript.slice(0, -".jsonl".length)}.meta.json`, 64 * 1024)) as { toolUseId?: unknown };
    if (typeof meta.toolUseId === "string") toolUseID = meta.toolUseId;
  } catch { return; }
  if (!toolUseID) return;
  const session = typeof evt.session_id === "string" ? evt.session_id : "";
  const record = readSpawnState(session).decisions?.[toolUseID];
  if (!record) return;
  const child = childUsage(text);
  if (!child) return;
  const budget = remainingMS();
  if (budget < SPAWN_MIN_CALL_MS) return;
  await client(session).delegateOutcome(record.decision_id, child, { budgetMs: budget });
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

/** The whole actuator behind one command, because Claude Code addresses a hook
 * by command: PreToolUse decides, SubagentStop reports. Everything runs inside
 * the one try, first statement included: a hook that exits non-zero is a hook
 * that broke somebody's spawn. */
export async function spawnHook(): Promise<void> {
  try {
    deadline = Date.now() + budgetMS();
    if (!routerOn()) return;
    const evt = JSON.parse((await readStdin()).toString("utf8") || "{}") as Record<string, any>;
    if (!evt || typeof evt !== "object") return;
    if (evt.hook_event_name === "SubagentStop") await report(evt);
    else await decide(evt);
  } catch { /* fail-open: the spawn runs as proposed */ }
}
