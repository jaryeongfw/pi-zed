/** ACP server: Zed spawns pi-zed and talks ACP JSON-RPC over stdio. */
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AuthMethod, ContentBlock, SessionInfo } from "@agentclientprotocol/sdk";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Host, supportsTerminalAuth } from "./host.js";
import { PiAcpSession } from "./pi-session.js";
import { createPiSession } from "./session-factory.js";

// stdout belongs to the ACP protocol; send any stray logs to stderr.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const VERSION = "0.3.0";
const LIST_PAGE_SIZE = 50;
const LOGIN_METHOD_ID = "pi-login";

const sessions = new Map<string, PiAcpSession>();
const host: Host = { client: undefined as unknown as Host["client"], caps: {} };

function getSession(sessionId: string): PiAcpSession {
	const entry = sessions.get(sessionId);
	if (!entry) throw RequestError.resourceNotFound(sessionId);
	return entry;
}

function uriToPath(uri: string): string {
	try {
		return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
	} catch {
		return uri;
	}
}

function promptText(blocks: ContentBlock[]): string {
	return blocks
		.map((b) => {
			if (b.type === "text") return b.text;
			if (b.type === "resource_link") return `@${uriToPath(b.uri)}`;
			if (b.type === "resource" && "text" in b.resource) {
				return `<context uri="${b.resource.uri}">\n${b.resource.text}\n</context>`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function promptImages(blocks: ContentBlock[]) {
	return blocks.flatMap((b) => (b.type === "image" ? [{ type: "image" as const, data: b.data, mimeType: b.mimeType }] : []));
}

function authMethods(): AuthMethod[] {
	if (!supportsTerminalAuth(host)) return [];
	return [
		{
			type: "terminal",
			id: LOGIN_METHOD_ID,
			name: "Log in with pi",
			description: "Opens pi in a terminal. Run /login there, choose a provider, then quit pi.",
			args: ["--pi"],
		},
	];
}

/** Registers a session; for session/new, updates start once the response has been delivered. */
function register(entry: PiAcpSession) {
	const previous = sessions.get(entry.id);
	if (previous && previous !== entry) previous.dispose();
	sessions.set(entry.id, entry);
	setTimeout(() => {
		entry.activate();
		void entry.sendAvailableCommands();
		void entry.sendUsage();
	}, 0);
}

async function findSessionFile(cwd: string | undefined, sessionId: string): Promise<string | undefined> {
	const local = cwd ? SessionManager.findById(cwd, sessionId) : undefined;
	if (local) return local;
	return (await SessionManager.listAll()).find((s) => s.id === sessionId)?.path;
}

/** Same as pi's session selector: move to the trash when the `trash` CLI exists, else unlink. */
async function deleteSessionFile(file: string) {
	const trashed = spawnSync("trash", [file.startsWith("-") ? `./${file}` : file], { stdio: "ignore" });
	if (trashed.status === 0) return;
	await fsp.unlink(file).catch((err) => {
		if (err?.code !== "ENOENT") throw err;
	});
}

const app = agent({ name: "pi-zed" })
	.onRequest(methods.agent.initialize, ({ params }) => {
		host.caps = params.clientCapabilities ?? {};
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { embeddedContext: true, image: true, audio: false },
				mcpCapabilities: { http: true, sse: false },
				sessionCapabilities: { list: {}, close: {}, delete: {} },
			},
			agentInfo: { name: "pi-zed", title: "pi", version: VERSION },
			authMethods: authMethods(),
		};
	})
	// Terminal login runs in Zed's terminal; there is nothing to do agent-side.
	.onRequest(methods.agent.authenticate, () => ({}))
	.onRequest(methods.agent.session.new, async ({ params }) => {
		const { session } = await createPiSession(host, { cwd: params.cwd, mcpServers: params.mcpServers });
		// Without credentials pi falls back to a placeholder model and no model is available.
		const noModels = session.modelRuntime.getAvailableSnapshot().length === 0;
		if (noModels && authMethods().length > 0) {
			session.dispose();
			throw RequestError.authRequired(undefined, "No model is available. Log in to a provider with pi (/login).");
		}
		const entry = await PiAcpSession.create(session, params.cwd, host);
		register(entry);
		return { sessionId: entry.id, configOptions: entry.configOptions() };
	})
	.onRequest(methods.agent.session.load, async ({ params }) => {
		let entry = sessions.get(params.sessionId);
		if (!entry) {
			const file = await findSessionFile(params.cwd, params.sessionId);
			if (!file) throw RequestError.resourceNotFound(params.sessionId);
			const { session } = await createPiSession(host, {
				cwd: params.cwd,
				mcpServers: params.mcpServers,
				sessionManager: SessionManager.open(file, undefined, params.cwd),
			});
			entry = await PiAcpSession.create(session, params.cwd, host);
		}
		// ACP: the whole conversation is streamed back before the load response.
		entry.activate();
		await entry.replayHistory();
		register(entry);
		return { configOptions: entry.configOptions() };
	})
	.onRequest(methods.agent.session.list, async ({ params }) => {
		const all = params.cwd ? await SessionManager.list(params.cwd) : await SessionManager.listAll();
		all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		const offset = Number(params.cursor ?? 0) || 0;
		const page = all.slice(offset, offset + LIST_PAGE_SIZE);
		const result: SessionInfo[] = page.map((s) => ({
			sessionId: s.id,
			cwd: s.cwd || params.cwd || "",
			title: s.name || s.firstMessage.replace(/\s+/g, " ").trim().slice(0, 100) || null,
			updatedAt: s.modified.toISOString(),
		}));
		const next = offset + LIST_PAGE_SIZE;
		return { sessions: result, nextCursor: next < all.length ? String(next) : null };
	})
	.onRequest(methods.agent.session.delete, async ({ params }) => {
		const open = sessions.get(params.sessionId);
		const file = open?.session.sessionManager.getSessionFile() ?? (await findSessionFile(undefined, params.sessionId));
		open?.dispose();
		sessions.delete(params.sessionId);
		if (file) await deleteSessionFile(file);
		return {};
	})
	.onRequest(methods.agent.session.close, async ({ params }) => {
		sessions.get(params.sessionId)?.dispose();
		sessions.delete(params.sessionId);
		return {};
	})
	.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
		const configOptions = await getSession(params.sessionId).setConfigOption(params.configId, params.value);
		return { configOptions };
	})
	.onRequest(methods.agent.session.prompt, async ({ params }) => {
		const entry = getSession(params.sessionId);
		const stopReason = await entry.prompt(promptText(params.prompt), promptImages(params.prompt));
		return { stopReason };
	})
	.onNotification(methods.agent.session.cancel, async ({ params }) => {
		await sessions.get(params.sessionId)?.cancel();
	});

const stream = ndJsonStream(
	Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
	Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = app.connect(stream);
host.client = connection.client;

const shutdown = () => {
	for (const entry of sessions.values()) entry.dispose();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
connection.closed.then(shutdown);
