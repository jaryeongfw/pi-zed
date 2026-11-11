// Minimal ACP client smoke test: node scripts/smoke.mjs [prompt]
import { spawn } from "node:child_process";
import readline from "node:readline";
const t0 = Date.now();
const child = spawn("node", [new URL("../dist/index.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let id = 0;
const rpc = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
readline.createInterface({ input: child.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "session/update") { const u = m.params.update; process.stdout.write(u.sessionUpdate === "agent_message_chunk" ? u.content.text : `\n[${u.sessionUpdate}] ${u.title ?? u.status ?? ""}\n`); }
  else console.log("<<", l.slice(0, 200));
});
const log = (k, v) => console.log(`+${Date.now() - t0}ms ${k}:`, JSON.stringify(v).slice(0, 200));
log("initialize", await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} }));
const s = await rpc("session/new", { cwd: process.cwd(), mcpServers: [] });
log("session/new", s);
if (process.argv[2]) log("\nprompt", await rpc("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: process.argv[2] }] }));
child.kill();
