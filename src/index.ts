#!/usr/bin/env node
/**
 * pi-zed: in-process ACP adapter for pi.
 *
 * Zed spawns this process (agent_servers) and talks ACP JSON-RPC over stdio.
 * pi runs inside this same process through the SDK, so no `pi --mode rpc` child.
 */
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AgentContext, ContentBlock, SessionInfo } from "@agentclientprotocol/sdk";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiAcpSession } from "./pi-session.js";

// stdout belongs to the ACP protocol; send any stray logs to stderr.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const VERSION = "0.2.0";
const LIST_PAGE_SIZE = 50;

const sessions = new Map<string, PiAcpSession>();

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

/** Registers a session and announces its commands once Zed knows the session id. */
function register(entry: PiAcpSession) {
	sessions.get(entry.id)?.dispose();
	sessions.set(entry.id, entry);
	// Session updates are only accepted after the session/new response has been delivered.
	setTimeout(() => {
		void entry.sendAvailableCommands();
		void entry.sendUsage();
	}, 0);
}

async function findSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	const local = SessionManager.findById(cwd, sessionId);
	if (local) return local;
	return (await SessionManager.listAll()).find((s) => s.id === sessionId)?.path;
}

let client: AgentContext;

const app = agent({ name: "pi-zed" })
	.onRequest(methods.agent.initialize, () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: {
			loadSession: true,
			promptCapabilities: { embeddedContext: true, image: true, audio: false },
			sessionCapabilities: { list: {}, close: {} },
		},
		agentInfo: { name: "pi-zed", title: "pi", version: VERSION },
		authMethods: [],
	}))
	.onRequest(methods.agent.session.new, async ({ params }) => {
		const { session } = await createAgentSession({ cwd: params.cwd });
		const entry = await PiAcpSession.create(session, params.cwd, client);
		register(entry);
		return { sessionId: entry.id, configOptions: entry.configOptions() };
	})
	.onRequest(methods.agent.session.load, async ({ params }) => {
		let entry = sessions.get(params.sessionId);
		if (!entry) {
			const file = await findSessionFile(params.cwd, params.sessionId);
			if (!file) throw RequestError.resourceNotFound(params.sessionId);
			const { session } = await createAgentSession({
				cwd: params.cwd,
				sessionManager: SessionManager.open(file, undefined, params.cwd),
			});
			entry = await PiAcpSession.create(session, params.cwd, client);
		}
		// ACP: the whole conversation is streamed back before the load response.
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
client = connection.client;

const shutdown = () => {
	for (const entry of sessions.values()) entry.dispose();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
connection.closed.then(shutdown);
