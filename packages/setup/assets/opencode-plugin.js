// caveman-router OpenCode plugin, installed by `caveman-router setup` and
// removed by `caveman-router teardown`. Self-contained on purpose: OpenCode
// loads this file directly, with no access to the npm packages.
//
// Only sessions on the `caveman` provider are touched:
// - chat.headers: the local token and the session id caveman-routerd keys on;
// - chat.message: prefetches the routing decision for the ask. EXPERIMENTAL,
//   off unless CAVEMAN_OPENCODE_SET_MODEL=1: waits up to 2 s for a model from
//   the daemon and sets it on the user message (inferred from OpenCode's
//   source, not verified against a running OpenCode);
// - tool.execute.after: tool outcomes.
// Every daemon call is capped (50 ms, 2 s for the experimental one) and every
// failure is ignored: the plugin never blocks or breaks a turn.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "caveman";
const HARNESS = "opencode";
const CONTROL_PORT = 47822;

function token() {
  try { return readFileSync(join(homedir(), ".caveman", "routerd.token"), "utf8").trim(); } catch { return ""; }
}

function send(path, body, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    try {
      const payload = JSON.stringify(body);
      const windows = process.platform === "win32";
      const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
      if (windows) headers["x-caveman-local-token"] = token();
      const req = request({
        method: "POST", path, headers, agent: false,
        ...(windows ? { host: "127.0.0.1", port: CONTROL_PORT } : { socketPath: join(homedir(), ".caveman", "routerd.sock") }),
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => { try { finish(text ? JSON.parse(text) : undefined); } catch { finish(undefined); } });
        res.on("error", () => finish(undefined));
      });
      timer = setTimeout(() => { req.destroy(); finish(undefined); }, timeoutMs);
      req.on("error", () => finish(undefined));
      req.end(payload);
    } catch {
      finish(undefined);
    }
  });
}

export const CavemanRouter = async ({ directory }) => {
  const sessions = new Set();
  return {
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return;
      sessions.add(input.sessionID);
      output.headers["x-caveman-session"] = input.sessionID;
      if (!output.headers["x-caveman-local-token"]) output.headers["x-caveman-local-token"] = token();
    },
    "chat.message": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER) return;
      sessions.add(input.sessionID);
      // The daemon keys the prefetch on the message id and decides on the text.
      const promptId = input.messageID || output?.message?.id;
      if (!promptId) return;
      const text = (Array.isArray(output?.parts) ? output.parts : [])
        .filter((part) => part?.type === "text" && typeof part.text === "string" && !part.synthetic)
        .map((part) => part.text).join("\n").slice(0, 500);
      const body = { harness: HARNESS, session_id: input.sessionID, prompt_id: promptId, cwd: directory, ...(text ? { prompt_excerpt: text } : {}) };
      if (process.env.CAVEMAN_OPENCODE_SET_MODEL !== "1") {
        void send("/hook/prompt", body, 50);
        return;
      }
      // Experimental: the routerd contract answers /hook/prompt with 204; a
      // daemon that returns {"model": "<id>"} gets it applied to this turn.
      const reply = await send("/hook/prompt", body, 2000);
      const model = reply && typeof reply.model === "string" ? reply.model : "";
      if (model && output?.message) output.message.model = { providerID: PROVIDER, modelID: model };
    },
    "tool.execute.after": async (input, output) => {
      if (!sessions.has(input?.sessionID)) return;
      const meta = output?.metadata && typeof output.metadata === "object" ? output.metadata : {};
      const exitCode = typeof meta.exit === "number" ? meta.exit : undefined;
      const isError = meta.error === true;
      void send("/hook/event", {
        harness: HARNESS, session_id: input.sessionID, kind: "tool_result",
        data: { tool: input.tool, ok: !isError && (exitCode === undefined || exitCode === 0), ...(exitCode !== undefined ? { exit_code: exitCode } : {}), ...(isError ? { is_error: true } : {}) },
      }, 50);
    },
  };
};
