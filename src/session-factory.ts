/**
 * Builds pi AgentSessions the way the pi CLI does (built-in MCP / codemode / tool-search
 * extensions), plus Zed integrations: MCP servers configured in Zed, and read/write/edit
 * routed through Zed's buffers.
 */
import fsp from "node:fs/promises";
import type { McpServer } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import {
	createAgentSession,
	createCodemodeExtension,
	createEditToolDefinition,
	createMcpExtension,
	createReadToolDefinition,
	createToolSearchExtension,
	createWriteToolDefinition,
	DefaultResourceLoader,
	detectSupportedImageMimeTypeFromFile,
	getAgentDir,
	type InlineExtension,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Host, useClientFs } from "./host.js";

// Same built-ins the pi CLI loads (llama.cpp is not exported by the SDK).
const BUILTIN_EXTENSIONS: InlineExtension[] = [
	{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
	{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
	{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];

// ------------------------------------------------------------------ Zed MCP servers

type PiMcpConfig = { command: string; args?: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> };

function toPiMcpConfig(server: McpServer): PiMcpConfig | undefined {
	const pairs = (list?: Array<{ name: string; value: string }>) =>
		list?.length ? Object.fromEntries(list.map((h) => [h.name, h.value])) : undefined;
	if ("type" in server && server.type === "http") return { url: server.url, headers: pairs(server.headers) };
	if ("type" in server && server.type === "sse") return undefined; // pi supports stdio and streamable HTTP only
	if ("command" in server) return { command: server.command, args: server.args, env: pairs(server.env) };
	return undefined;
}

function zedMcpExtension(servers: McpServer[]): InlineExtension | undefined {
	const configs = servers.flatMap((s) => {
		const config = toPiMcpConfig(s);
		return config ? [[s.name, config] as const] : [];
	});
	if (configs.length === 0) return undefined;
	return {
		name: "zed-mcp",
		hidden: true,
		// pi's own mcp.json wins over registered servers with the same name.
		factory: (pi) => {
			for (const [name, config] of configs) pi.registerMcpServer(name, config as any);
		},
	};
}

// ------------------------------------------------------------------ Zed-backed file tools

function zedFs(host: Host, sessionId: string) {
	return {
		async read(absPath: string): Promise<Buffer> {
			// Missing files must fail like a local read (Zed would open an empty buffer).
			await fsp.access(absPath);
			try {
				const res = await host.client.request(methods.client.fs.readTextFile, { sessionId, path: absPath });
				return Buffer.from(res.content, "utf8");
			} catch {
				return fsp.readFile(absPath); // outside the project, binary, …
			}
		},
		async write(absPath: string, content: string): Promise<void> {
			try {
				await host.client.request(methods.client.fs.writeTextFile, { sessionId, path: absPath, content });
			} catch {
				await fsp.writeFile(absPath, content, "utf8");
			}
		},
	};
}

/**
 * Overrides of the built-in read/write/edit tools whose file access goes through Zed:
 * reads see unsaved buffers, writes land in Zed's buffers (review / keep / reject UI).
 * Each is `replaceable`, so an extension that overrides the same tool takes precedence.
 */
function zedFileToolExtensions(host: Host, cwd: string, settings: SettingsManager): InlineExtension[] {
	if (!useClientFs(host)) return [];
	const autoResizeImages = settings.getImageAutoResize();
	return [
		{
			name: "zed-fs-read",
			hidden: true,
			replaceable: true,
			factory: (pi) => {
				pi.registerTool({
					...createReadToolDefinition(cwd, { autoResizeImages }),
					execute(id, params, signal, onUpdate, ctx) {
						const io = zedFs(host, ctx.sessionManager.getSessionId());
						const images = new Set<string>();
						return createReadToolDefinition(ctx.cwd, {
							autoResizeImages,
							operations: {
								access: (p) => fsp.access(p, fsp.constants.R_OK),
								detectImageMimeType: async (p) => {
									const mime = await detectSupportedImageMimeTypeFromFile(p);
									if (mime) images.add(p);
									return mime;
								},
								readFile: (p) => (images.has(p) ? fsp.readFile(p) : io.read(p)),
							},
						}).execute(id, params, signal, onUpdate, ctx);
					},
				});
			},
		},
		{
			name: "zed-fs-write",
			hidden: true,
			replaceable: true,
			factory: (pi) => {
				pi.registerTool({
					...createWriteToolDefinition(cwd),
					execute(id, params, signal, onUpdate, ctx) {
						const io = zedFs(host, ctx.sessionManager.getSessionId());
						return createWriteToolDefinition(ctx.cwd, {
							operations: {
								mkdir: (dir) => fsp.mkdir(dir, { recursive: true }).then(() => {}),
								writeFile: io.write,
							},
						}).execute(id, params, signal, onUpdate, ctx);
					},
				});
			},
		},
		{
			name: "zed-fs-edit",
			hidden: true,
			replaceable: true,
			factory: (pi) => {
				pi.registerTool({
					...createEditToolDefinition(cwd),
					execute(id, params, signal, onUpdate, ctx) {
						const io = zedFs(host, ctx.sessionManager.getSessionId());
						return createEditToolDefinition(ctx.cwd, {
							operations: {
								access: (p) => fsp.access(p, fsp.constants.R_OK | fsp.constants.W_OK),
								readFile: io.read,
								writeFile: io.write,
							},
						}).execute(id, params, signal, onUpdate, ctx);
					},
				});
			},
		},
	];
}

// ------------------------------------------------------------------ factory

export interface CreatePiSessionOptions {
	cwd: string;
	mcpServers?: McpServer[];
	sessionManager?: SessionManager;
}

export async function createPiSession(host: Host, options: CreatePiSessionOptions) {
	const { cwd } = options;
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const mcp = zedMcpExtension(options.mcpServers ?? []);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [...BUILTIN_EXTENSIONS, ...zedFileToolExtensions(host, cwd, settingsManager), ...(mcp ? [mcp] : [])],
	});
	await resourceLoader.reload();
	return createAgentSession({ cwd, settingsManager, resourceLoader, sessionManager: options.sessionManager });
}
