import { spawn } from "node:child_process";
import { DAEMON_PORT, daemonHealthy, postEvent, postPrompt, spawnDecision } from "@caveman-ai/router-client";
import { statuslineHook } from "./claude-code.js";
import { repoProfile } from "./repo-profile.js";

// The caveman-routerd side of the Claude Code hook. The daemon is the proxy
// Claude Code talks to; these hooks feed it what the proxy cannot see (prompt
// ids, tool outcomes, the statusline) and steer children. Every call is capped
// by the client and every failure is silence: the harness never waits on us.

const HARNESS = "claude-code";
const PROMPT_EXCERPT_CHARS = 500;
// Claude Code's Agent tool takes a family alias, never a model id.
const ALIASES = new Set(["opus", "sonnet", "haiku", "fable", "inherit"]);

export const DAEMON_DOWN_LINE = `Caveman routing is off: caveman-routerd is not answering, so requests to 127.0.0.1:${DAEMON_PORT} will fail. Restart it with \`caveman-routerd install-service\`, or undo with \`caveman-router teardown\`.`;

type Evt = Record<string, any>;
const session = (evt: Evt): string => (typeof evt.session_id === "string" ? evt.session_id : "");
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A daemon model as something the Agent tool accepts, or "" when it is not
 * one: a non-Claude id would fail the spawn, so it is never written. */
export function agentAlias(model: string): string {
  const name = model.trim().toLowerCase();
  if (ALIASES.has(name)) return name;
  return /claude-(opus|sonnet|haiku|fable)/.exec(name)?.[1] ?? "";
}

export async function sessionStart(evt: Evt): Promise<void> {
  if (!(await daemonHealthy())) {
    process.stdout.write(JSON.stringify({ systemMessage: DAEMON_DOWN_LINE }));
    return;
  }
  const repo = await repoProfile(evt.cwd, 1000);
  if (repo) await postEvent(HARNESS, session(evt), "repo_profile", repo);
}

/** The daemon needs a prompt id to key the prefetch and the excerpt to decide
 * on; without an id there is nothing to prefetch (it answers 400). */
export async function userPromptSubmit(evt: Evt): Promise<void> {
  if (!text(evt.prompt_id)) return;
  await postPrompt(HARNESS, session(evt), {
    prompt_id: evt.prompt_id,
    ...(text(evt.cwd) ? { cwd: evt.cwd } : {}),
    ...(text(evt.transcript_path) ? { transcript_path: evt.transcript_path } : {}),
    ...(text(evt.prompt) ? { prompt_excerpt: (evt.prompt as string).slice(0, PROMPT_EXCERPT_CHARS) } : {}),
  });
}

/** True when the daemon answered — its answer stands, even "leave it". False
 * sends the caller to the hosted fallback. */
export async function spawnViaDaemon(evt: Evt, input: Record<string, unknown>, parentModel: string, modelDeclared: boolean): Promise<boolean> {
  const decision = await spawnDecision(HARNESS, session(evt), {
    tool: "Agent",
    // model_declared tells the daemon the model came from the agent
    // definition's frontmatter; it never goes back to Claude Code.
    tool_input: { ...input, model_declared: modelDeclared },
    parent: parentModel ? { model: parentModel } : {},
    ...(text(evt.cwd) ? { cwd: evt.cwd } : {}),
  });
  if (!decision) return false;
  const next = decision.model ? agentAlias(decision.model) : "";
  const current = typeof input.model === "string" ? input.model.trim().toLowerCase() : "";
  const out: Record<string, unknown> = {};
  if (next && next !== current) {
    out.hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input, model: next } };
  }
  if (decision.line) out.systemMessage = decision.line;
  if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
  return true;
}

/** PostToolUse, registered for Agent only: Claude Code's tool results reach
 * the daemon on the proxied request itself, so only the child's outcome is
 * sent from here. */
export async function postToolUse(evt: Evt): Promise<void> {
  const tool = text(evt.tool_name) ?? "";
  if (tool !== "Agent" && tool !== "Task") return;
  const response = record(evt.tool_response);
  const input = record(evt.tool_input);
  await postEvent(HARNESS, session(evt), "subagent_done", {
    agent_id: text(response.agentId) ?? text(response.agent_id) ?? null,
    requested_model: text(input.model) ?? null,
    resolved_model: text(response.resolvedModel) ?? null,
    usage: response.usage ?? null,
    duration_ms: num(response.totalDurationMs) ?? null,
    tool_count: num(response.totalToolUseCount) ?? null,
  });
}

export async function stopEvent(evt: Evt): Promise<void> {
  await postEvent(HARNESS, session(evt), "stop", {});
}

export const STATUSLINE_EVENT_MS = 20;

/** The statusline wrapper: hands the JSON to the daemon (≤20 ms, fire and
 * forget) and runs the user's previous statusline command on the same stdin,
 * its output and exit code untouched. No previous command: the router line. */
export async function statuslineChain(stdin: string, previous: string | undefined): Promise<number> {
  let event: unknown;
  try { event = JSON.parse(stdin || "null"); } catch { event = undefined; }
  const sent = event && typeof event === "object"
    ? postEvent(HARNESS, session(event as Evt), "statusline", event, STATUSLINE_EVENT_MS)
    : Promise.resolve(false);
  if (!previous) {
    let line = "";
    try { line = await statuslineHook(stdin); } catch { /* an empty line beats a broken bar */ }
    process.stdout.write(`${line}\n`);
    await sent;
    return 0;
  }
  const code = await new Promise<number>((resolve) => {
    const child = spawn(previous, { shell: true, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => resolve(0));
    child.on("close", (status) => resolve(status ?? 0));
    child.stdin.on("error", () => { /* a command that ignores stdin closes it early */ });
    child.stdin.end(stdin);
  });
  await sent;
  return code;
}
