// Minimal ACP client smoke test: node scripts/smoke.mjs [prompt]
// Advertises Zed-like client capabilities and answers fs/* and elicitation requests.
//   SMOKE_CAPS=none  → advertise no client capabilities
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const t0 = Date.now();
setTimeout(() => { console.error("✗ timeout"); process.exit(1); }, Number(process.env.SMOKE_TIMEOUT_MS ?? 120000)).unref();
const child = spawn("node", [new URL("../dist/index.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let id = 0;
const write = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const rpc = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); write({ id: i, method, params }); });
const log = (k, v) => console.log(`+${Date.now() - t0}ms ${k}:`, JSON.stringify(v).slice(0, 300));

const zedCaps = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: true },
  session: { configOptions: { boolean: {} }, compaction: {}, notices: {} },
  elicitation: { form: {}, url: {} },
  _meta: { terminal_output: true, "terminal-auth": true },
};

function handleRequest(m) {
  const p = m.params ?? {};
  switch (m.method) {
    case "fs/read_text_file":
      log("← fs/read_text_file", p.path);
      try { return write({ id: m.id, result: { content: fs.readFileSync(p.path, "utf8") } }); }
      catch (e) { return write({ id: m.id, error: { code: -32002, message: String(e) } }); }
    case "fs/write_text_file":
      log("← fs/write_text_file", { path: p.path, bytes: p.content.length });
      fs.writeFileSync(p.path, p.content);
      return write({ id: m.id, result: {} });
    case "elicitation/create": {
      log("← elicitation/create", { message: p.message, schema: p.requestedSchema });
      const props = p.requestedSchema?.properties ?? {};
      const content = {};
      for (const [k, s] of Object.entries(props)) content[k] = s.oneOf?.[0]?.const ?? s.enum?.[0] ?? s.default ?? "smoke";
      return write({ id: m.id, result: { action: "accept", content } });
    }
    default:
      log("← unhandled request", m.method);
      return write({ id: m.id, error: { code: -32601, message: "not supported" } });
  }
}

readline.createInterface({ input: child.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id != null && m.method) return handleRequest(m);
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "session/update") {
    const u = m.params.update;
    if (u.sessionUpdate === "agent_message_chunk") return process.stdout.write(u.content.text ?? "");
    const brief = { ...u };
    delete brief.sessionUpdate;
    if (brief.availableCommands) brief.availableCommands = `${brief.availableCommands.length} commands`;
    if (brief.configOptions) brief.configOptions = `${brief.configOptions.length} options`;
    return console.log(`\n[${u.sessionUpdate}] ${JSON.stringify(brief).slice(0, 240)}`);
  }
  console.log("<<", l.slice(0, 200));
});

const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: process.env.SMOKE_CAPS === "none" ? {} : zedCaps });
log("initialize", init);
const s = await rpc("session/new", { cwd: process.cwd(), mcpServers: JSON.parse(process.env.SMOKE_MCP ?? "[]") });
log("session/new", s);
for (const prompt of process.argv.slice(2)) {
  log("\nprompt", await rpc("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: prompt }] }));
}
child.kill();
process.exit(0);
