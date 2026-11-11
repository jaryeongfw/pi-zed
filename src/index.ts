#!/usr/bin/env node
/**
 * pi-zed: in-process ACP adapter for pi.
 *
 * Zed spawns this process (agent_servers) and talks ACP JSON-RPC over stdio.
 * pi runs inside this same process through the SDK, so no `pi --mode rpc` child.
 */
import { Readable, Writable } from "node:stream";
import path from "node:path";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionUpdate, StopReason, ToolKind } from "@agentclientprotocol/sdk";
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";

// stdout belongs to the ACP protocol; send any stray logs to stderr.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

interface Entry {
	session: AgentSession;
	cwd: string;
}
const sessions = new Map<string, Entry>();

const TOOL_KINDS: Record<string, ToolKind> = {
	read: "read",
	ls: "read",
	edit: "edit",
	write: "edit",
	bash: "execute",
	grep: "search",
	find: "search",
};

function toolTitle(name: string, args: any): string {
	const target = args?.path ?? args?.command ?? args?.pattern;
	return target ? `${name}: ${String(target).slice(0, 120)}` : name;
}

function toolLocations(args: any, cwd: string) {
	if (typeof args?.path !== "string") return undefined;
	return [{ path: path.resolve(cwd, args.path) }];
}

function resultText(result: any): string {
	const content = result?.content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return typeof result === "string" ? result : "";
}

function promptText(blocks: Array<any>): string {
	return blocks
		.map((b) => {
			if (b.type === "text") return b.text;
			if (b.type === "resource_link") return `@${b.uri}`;
			if (b.type === "resource" && "text" in b.resource) {
				return `<context uri="${b.resource.uri}">\n${b.resource.text}\n</context>`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

const app = agent({ name: "pi-zed" })
	.onRequest(methods.agent.initialize, () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: {
			loadSession: false,
			promptCapabilities: { embeddedContext: true, image: false, audio: false },
		},
		agentInfo: { name: "pi-zed", version: "0.1.0" },
		authMethods: [],
	}))
	.onRequest(methods.agent.session.new, async ({ params }) => {
		const { session } = await createAgentSession({ cwd: params.cwd });
		const sessionId = session.sessionManager.getSessionId?.() ?? crypto.randomUUID();
		sessions.set(sessionId, { session, cwd: params.cwd });
		return { sessionId };
	})
	.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
		const entry = sessions.get(params.sessionId);
		if (!entry) throw new Error(`Unknown session: ${params.sessionId}`);
		const { session, cwd } = entry;

		const send = (update: SessionUpdate) =>
			client.notify(methods.client.session.update, { sessionId: params.sessionId, update });

		let cancelled = false;
		const unsubscribe = session.subscribe((event) => {
			switch (event.type) {
				case "message_update": {
					const e = event.assistantMessageEvent;
					if (e.type === "text_delta") {
						void send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta } });
					} else if (e.type === "thinking_delta") {
						void send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.delta } });
					}
					break;
				}
				case "tool_execution_start":
					void send({
						sessionUpdate: "tool_call",
						toolCallId: event.toolCallId,
						title: toolTitle(event.toolName, event.args),
						kind: TOOL_KINDS[event.toolName] ?? "other",
						status: "in_progress",
						rawInput: event.args,
						locations: toolLocations(event.args, cwd),
					});
					break;
				case "tool_execution_end":
					void send({
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: event.isError ? "failed" : "completed",
						content: [{ type: "content", content: { type: "text", text: resultText(event.result) } }],
					});
					break;
				case "agent_settled":
					cancelled ||= event.aborted;
					break;
			}
		});

		try {
			await session.prompt(promptText(params.prompt));
			await session.waitForIdle();
		} catch (err) {
			if (!cancelled) throw err;
		} finally {
			unsubscribe();
		}
		const stopReason: StopReason = cancelled ? "cancelled" : "end_turn";
		return { stopReason };
	})
	.onNotification(methods.agent.session.cancel, async ({ params }) => {
		await sessions.get(params.sessionId)?.session.abort();
	});

const stream = ndJsonStream(
	Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
	Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = app.connect(stream);

const shutdown = () => {
	for (const { session } of sessions.values()) session.dispose();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
connection.closed.then(shutdown);
