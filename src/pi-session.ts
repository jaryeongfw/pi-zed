/** One ACP session backed by one in-process pi AgentSession. */
import type {
	AgentContext,
	AvailableCommand,
	SessionConfigOption,
	SessionConfigSelectGroup,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { replayBranch } from "./replay.js";
import {
	argsDiff,
	type FileSnapshot,
	isFileMutation,
	resultText,
	snapshotDiff,
	snapshotFile,
	textContent,
	toolKind,
	toolLocations,
	toolTitle,
} from "./tools.js";

type ThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];
type Model = NonNullable<AgentSession["model"]>;

export const MODEL_CONFIG_ID = "model";
export const THINKING_CONFIG_ID = "thinking";

const THINKING_LABELS: Record<string, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** Commands implemented by the adapter (pi's TUI built-ins are not available through prompt()). */
const BUILTIN_COMMANDS: AvailableCommand[] = [
	{ name: "compact", description: "Compact the conversation context", input: { hint: "optional instructions" } },
	{ name: "name", description: "Set the session display name", input: { hint: "session name" } },
	{ name: "session", description: "Show session info and token usage" },
	{ name: "reload", description: "Reload extensions, skills, prompt templates and context files" },
];

const UPDATE_THROTTLE_MS = 250;

const modelKey = (m: Pick<Model, "provider" | "id">) => `${m.provider}/${m.id}`;

export class PiAcpSession {
	readonly id: string;
	private cancelRequested = false;
	private snapshots = new Map<string, FileSnapshot>();
	private lastPartialUpdate = new Map<string, number>();
	private unsubscribe: () => void;

	constructor(
		readonly session: AgentSession,
		readonly cwd: string,
		private readonly client: AgentContext,
	) {
		this.id = session.sessionId;
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
	}

	static async create(session: AgentSession, cwd: string, client: AgentContext): Promise<PiAcpSession> {
		await session.bindExtensions({
			mode: "rpc",
			onError: (err) => console.error(`[pi-zed] extension error (${err.extensionPath}, ${err.event}): ${err.error}`),
		});
		return new PiAcpSession(session, cwd, client);
	}

	send(update: SessionUpdate): Promise<void> {
		return this.client.notify(methods.client.session.update, { sessionId: this.id, update }).catch((err) => {
			console.error("[pi-zed] failed to send session/update:", err);
		});
	}

	private message(text: string) {
		return this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
	}

	// ---------------------------------------------------------------- events

	private onEvent(event: AgentSessionEvent) {
		switch (event.type) {
			case "message_update": {
				const e = event.assistantMessageEvent;
				if (e.type === "text_delta") {
					void this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta } });
				} else if (e.type === "thinking_delta") {
					void this.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.delta } });
				}
				break;
			}
			case "message_end": {
				const msg: any = event.message;
				if (msg.role === "assistant" && msg.stopReason === "error" && msg.errorMessage) {
					void this.message(`\n\n**Error:** ${msg.errorMessage}`);
				} else if (msg.role === "custom" && msg.display) {
					const text = resultText(msg) || (typeof msg.content === "string" ? msg.content : "");
					if (text) void this.message(`\n\n${text}\n\n`);
				}
				break;
			}
			case "tool_execution_start": {
				if (event.parentToolCallId) break;
				const { toolCallId, toolName, args } = event;
				const mutation = isFileMutation(toolName, args);
				// Listeners run synchronously before the tool executes: snapshot the original file now.
				if (mutation) {
					const snapshot = snapshotFile(args, this.cwd);
					if (snapshot) this.snapshots.set(toolCallId, snapshot);
				}
				void this.send({
					sessionUpdate: "tool_call",
					toolCallId,
					title: toolTitle(toolName, args, this.cwd),
					kind: toolKind(toolName),
					status: "in_progress",
					rawInput: args,
					locations: toolLocations(args, this.cwd),
					content: mutation ? argsDiff(toolName, args, this.cwd) : undefined,
				});
				break;
			}
			case "tool_execution_update": {
				if (event.parentToolCallId) break;
				const text = resultText(event.partialResult);
				if (!text || isFileMutation(event.toolName, event.args)) break;
				const now = Date.now();
				if (now - (this.lastPartialUpdate.get(event.toolCallId) ?? 0) < UPDATE_THROTTLE_MS) break;
				this.lastPartialUpdate.set(event.toolCallId, now);
				void this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					content: textContent(event.toolName, text),
				});
				break;
			}
			case "tool_execution_end": {
				if (event.parentToolCallId) break;
				const { toolCallId, toolName, isError, result } = event;
				const snapshot = this.snapshots.get(toolCallId);
				this.snapshots.delete(toolCallId);
				this.lastPartialUpdate.delete(toolCallId);
				const diff = !isError && snapshot ? snapshotDiff(snapshot) : undefined;
				void this.send({
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: isError ? "failed" : "completed",
					content: diff ?? textContent(toolName, resultText(result)),
					rawOutput: result?.details,
				});
				break;
			}
			case "thinking_level_changed":
				void this.sendConfigOptions();
				break;
			case "session_info_changed":
				void this.send({ sessionUpdate: "session_info_update", title: event.name ?? null });
				break;
			case "compaction_start":
				void this.message(`\n\n_Compacting context (${event.reason})…_\n\n`);
				break;
			case "compaction_end":
				if (event.errorMessage) void this.message(`\n\n**Compaction failed:** ${event.errorMessage}\n\n`);
				else if (event.result) void this.message(`_Context compacted (${event.result.tokensBefore} tokens summarized)._\n\n`);
				void this.sendUsage();
				break;
			case "auto_retry_start":
				void this.message(`\n\n_Retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}_\n\n`);
				break;
			case "agent_settled":
				void this.sendUsage();
				break;
		}
	}

	// ---------------------------------------------------------------- prompt

	async prompt(text: string, images: Array<{ type: "image"; data: string; mimeType: string }>) {
		this.cancelRequested = false;
		if (images.length === 0 && (await this.runBuiltinCommand(text))) return "end_turn" as const;
		try {
			await this.session.prompt(text, {
				images: images.length ? images : undefined,
				source: "rpc",
				streamingBehavior: this.session.isStreaming ? "followUp" : undefined,
			});
			await this.session.waitForIdle();
		} catch (err) {
			if (!this.cancelRequested) throw err;
		}
		// Extension commands may have changed resources, model or thinking level.
		if (text.startsWith("/")) {
			void this.sendAvailableCommands();
			void this.sendConfigOptions();
		}
		return this.cancelRequested ? ("cancelled" as const) : ("end_turn" as const);
	}

	async cancel() {
		this.cancelRequested = true;
		this.session.clearQueue();
		await this.session.abort();
	}

	private async runBuiltinCommand(text: string): Promise<boolean> {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!match) return false;
		const [, name, rest = ""] = match;
		const args = rest.trim();
		switch (name) {
			case "compact": {
				try {
					await this.session.compact(args || undefined);
				} catch (err: any) {
					if (!this.cancelRequested) await this.message(`**Compaction failed:** ${err?.message ?? err}`);
				}
				return true;
			}
			case "name":
				if (!args) {
					await this.message(this.session.sessionName ? `Session name: **${this.session.sessionName}**` : "Usage: `/name <name>`");
				} else {
					this.session.setSessionName(args);
					await this.message(`Session renamed to **${args}**.`);
				}
				return true;
			case "session": {
				await this.message(this.sessionInfo());
				return true;
			}
			case "reload":
				await this.session.reload();
				await this.sendAvailableCommands();
				await this.sendConfigOptions();
				await this.message("Reloaded extensions, skills, prompt templates and context files.");
				return true;
			default:
				return false;
		}
	}

	private sessionInfo(): string {
		const s = this.session.getSessionStats();
		const usage = s.contextUsage;
		const model = this.session.model;
		const lines = [
			`**Session** \`${s.sessionId}\`${this.session.sessionName ? ` — ${this.session.sessionName}` : ""}`,
			s.sessionFile ? `- File: \`${s.sessionFile}\`` : "- File: (in memory)",
			`- Model: ${model ? `\`${modelKey(model)}\`` : "none"} · thinking: ${this.session.thinkingLevel}`,
			`- Messages: ${s.userMessages} user, ${s.assistantMessages} assistant, ${s.toolCalls} tool calls`,
			`- Tokens: ${s.tokens.input.toLocaleString()} in, ${s.tokens.output.toLocaleString()} out, ${s.tokens.cacheRead.toLocaleString()} cache read, ${s.tokens.cacheWrite.toLocaleString()} cache write`,
			`- Cost: $${s.cost.toFixed(4)}`,
		];
		if (usage) {
			const pct = usage.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
			lines.push(`- Context: ${usage.tokens?.toLocaleString() ?? "?"} / ${usage.contextWindow.toLocaleString()} (${pct})`);
		}
		return lines.join("\n");
	}

	// ---------------------------------------------------------------- commands

	availableCommands(): AvailableCommand[] {
		const commands: AvailableCommand[] = [...BUILTIN_COMMANDS];
		const seen = new Set(commands.map((c) => c.name));
		const add = (cmd: AvailableCommand) => {
			if (seen.has(cmd.name)) return;
			seen.add(cmd.name);
			commands.push(cmd);
		};
		for (const cmd of this.session.extensionRunner.getRegisteredCommands()) {
			add({ name: cmd.invocationName, description: cmd.description ?? "Extension command", input: { hint: "arguments" } });
		}
		for (const template of this.session.promptTemplates) {
			add({
				name: template.name,
				description: template.description || "Prompt template",
				input: { hint: template.argumentHint || "arguments" },
			});
		}
		if (this.session.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				add({ name: `skill:${skill.name}`, description: skill.description || "Skill", input: { hint: "optional request" } });
			}
		}
		return commands;
	}

	sendAvailableCommands() {
		return this.send({ sessionUpdate: "available_commands_update", availableCommands: this.availableCommands() });
	}

	// ---------------------------------------------------------------- config options (model / thinking)

	configOptions(): SessionConfigOption[] {
		const options: SessionConfigOption[] = [];
		const current = this.session.model;
		if (current) {
			const models = [...this.session.modelRuntime.getAvailableSnapshot()];
			if (!models.some((m) => modelKey(m) === modelKey(current))) models.unshift(current);
			const groups = new Map<string, SessionConfigSelectGroup>();
			for (const m of models) {
				let group = groups.get(m.provider);
				if (!group) {
					group = { group: m.provider, name: m.provider, options: [] };
					groups.set(m.provider, group);
				}
				group.options.push({ value: modelKey(m), name: m.name || m.id, description: modelKey(m) });
			}
			options.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: modelKey(current),
				options: [...groups.values()],
			});
		}
		const levels = this.session.supportsThinking() ? this.session.getAvailableThinkingLevels() : [];
		if (levels.length > 0) {
			options.push({
				id: THINKING_CONFIG_ID,
				name: "Thinking",
				category: "thought_level",
				type: "select",
				currentValue: this.session.thinkingLevel,
				options: levels.map((level) => ({ value: level, name: THINKING_LABELS[level] ?? level })),
			});
		}
		return options;
	}

	sendConfigOptions() {
		return this.send({ sessionUpdate: "config_option_update", configOptions: this.configOptions() });
	}

	async setConfigOption(configId: string, value: unknown): Promise<SessionConfigOption[]> {
		if (configId === MODEL_CONFIG_ID) {
			const model = this.session.modelRuntime.getAvailableSnapshot().find((m) => modelKey(m) === value);
			if (!model) throw new Error(`Unknown model: ${String(value)}`);
			await this.session.setModel(model, { persist: true });
		} else if (configId === THINKING_CONFIG_ID) {
			const levels: string[] = this.session.getAvailableThinkingLevels();
			if (typeof value !== "string" || !levels.includes(value)) throw new Error(`Unsupported thinking level: ${String(value)}`);
			this.session.setThinkingLevel(value as ThinkingLevel, { persist: true });
		} else {
			throw new Error(`Unknown config option: ${configId}`);
		}
		void this.sendUsage();
		return this.configOptions();
	}

	// ---------------------------------------------------------------- usage / history

	sendUsage() {
		const usage = this.session.getContextUsage();
		if (!usage) return Promise.resolve();
		const cost = this.session.getSessionStats().cost;
		return this.send({
			sessionUpdate: "usage_update",
			used: usage.tokens ?? 0,
			size: usage.contextWindow,
			cost: { amount: cost, currency: "USD" },
		});
	}

	replayHistory() {
		return replayBranch(this.session.sessionManager.getBranch(), this.cwd, (update) => this.send(update));
	}

	dispose() {
		this.unsubscribe();
		this.session.dispose();
	}
}
