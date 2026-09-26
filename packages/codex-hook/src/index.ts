import { DAEMON_PORT, daemonHealthy, postEvent, postPrompt, spawnDecision } from "@caveman-ai/router-client";

// Codex CLI hooks for caveman-routerd (config: ~/.codex/hooks.json, written by
// `caveman-router setup`). One command for every event; Codex tells us which on
// stdin as `hook_event_name`. Every failure path exits 0 with nothing on
// stdout, which Codex reads as "carry on unchanged".
//
// Only sessions on the `caveman` profile (model "auto") are touched: the hooks
// file is user-wide, and steering a child of a session that does not go
// through the daemon would name a model that session's catalog lacks.

const HARNESS = "codex";
const PROMPT_EXCERPT_CHARS = 500;
const ROUTED_MODELS = new Set(["auto", "caveman/auto"]);
// Codex accepts any effort string (unknown ones are model-defined), but not
// whitespace or JSON: anything else is dropped rather than sent to a spawn.
const EFFORT_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const DAEMON_DOWN_LINE = `Caveman routing is off: caveman-routerd is not answering, so the caveman profile's requests to 127.0.0.1:${DAEMON_PORT} will fail. Restart it with \`caveman-routerd install-service\`, or run Codex without \`--profile caveman\`.`;

type Evt = Record<string, any>;
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function routed(evt: Evt): boolean {
  return typeof evt.model === "string" && ROUTED_MODELS.has(evt.model);
}

async function preToolUse(evt: Evt, session: string): Promise<void> {
  if (evt.tool_name !== "spawn_agent") return;
  const input = record(evt.tool_input);
  const decision = await spawnDecision(HARNESS, session, {
    tool: "spawn_agent",
    tool_input: input,
    parent: { model: evt.model },
    ...(text(evt.cwd) ? { cwd: evt.cwd } : {}),
  });
  if (!decision) return;
  const updated: Record<string, unknown> = { ...input };
  if (decision.model && decision.model !== input.model) updated.model = decision.model;
  if (decision.effort && EFFORT_RE.test(decision.effort) && decision.effort !== input.reasoning_effort) updated.reasoning_effort = decision.effort;
  const changed = updated.model !== input.model || updated.reasoning_effort !== input.reasoning_effort;
  const out: Record<string, unknown> = {};
  // spawn_agent's arguments are deny_unknown_fields: only model and
  // reasoning_effort ever change, everything else is passed back as it came.
  if (changed) out.hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: updated };
  if (decision.line) out.systemMessage = decision.line;
  if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
}

async function postToolUse(evt: Evt, session: string): Promise<void> {
  const response = record(evt.tool_response);
  const exitCode = num(response.exit_code) ?? num(response.exitCode);
  const isError = response.is_error === true || response.success === false;
  await postEvent(HARNESS, session, "tool_result", {
    tool: text(evt.tool_name) ?? "",
    ok: !isError && (exitCode === undefined || exitCode === 0),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(isError ? { is_error: true } : {}),
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export async function codexHook(): Promise<void> {
  try {
    const evt = JSON.parse((await readStdin()) || "{}") as Evt;
    if (!evt || typeof evt !== "object" || !routed(evt)) return;
    const session = text(evt.session_id) ?? "";
    switch (evt.hook_event_name) {
      case "SessionStart":
        if (!(await daemonHealthy())) process.stdout.write(JSON.stringify({ systemMessage: DAEMON_DOWN_LINE }));
        break;
      case "UserPromptSubmit":
        await postPrompt(HARNESS, session, {
          ...(text(evt.turn_id) ? { prompt_id: evt.turn_id } : {}),
          ...(text(evt.cwd) ? { cwd: evt.cwd } : {}),
          ...(text(evt.transcript_path) ? { transcript_path: evt.transcript_path } : {}),
          ...(text(evt.prompt) ? { prompt_excerpt: (evt.prompt as string).slice(0, PROMPT_EXCERPT_CHARS) } : {}),
        });
        break;
      case "PreToolUse": await preToolUse(evt, session); break;
      case "PostToolUse": await postToolUse(evt, session); break;
      case "SubagentStop":
        await postEvent(HARNESS, session, "subagent_done", { agent_id: text(evt.agent_id) ?? null, agent_type: text(evt.agent_type) ?? null });
        break;
      case "Stop": await postEvent(HARNESS, session, "stop", {}); break;
      case "Interrupt": await postEvent(HARNESS, session, "interrupt", {}); break;
    }
  } catch { /* fail open */ }
}
