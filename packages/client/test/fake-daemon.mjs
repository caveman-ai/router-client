// A fake caveman-routerd control socket for tests in every package: it listens
// on <home>/.caveman/routerd.sock, records each request and answers with the
// handler's reply. `hang: true` accepts and never answers (a stuck daemon).
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Short: macOS caps a unix socket path at 104 bytes.
export function tempHome(prefix = "rd-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function fakeDaemon(home, handler = () => ({ status: 204 }), { hang = false } = {}) {
  mkdirSync(join(home, ".caveman"), { recursive: true });
  const seen = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
      const entry = { method: req.method, path: req.url, headers: req.headers, body: parsed };
      seen.push(entry);
      if (hang) return;
      const reply = handler(entry) ?? { status: 204 };
      res.writeHead(reply.status ?? 200, reply.body === undefined ? {} : { "content-type": "application/json" });
      res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(join(home, ".caveman", "routerd.sock"), resolve));
  return {
    seen,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

/** The daemon's usual answers: healthy, 204 for hooks, a spawn decision. */
export function daemonReplies(spawn = { model: null, effort: null, line: null, decision_id: null }) {
  return ({ path }) => {
    if (path === "/health") return { status: 200, body: { ok: true, version: "test" } };
    if (path === "/hook/spawn") return { status: 200, body: spawn };
    return { status: 204 };
  };
}
