/** One ACP session backed by one in-process pi AgentSession. */
import type {
	AvailableCommand,
	SessionConfigOption,
	SessionConfigSelectGroup,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { customEntryUpdate } from "./custom-entries.js";
import { type Host, supportsCompaction, supportsNotices, useTerminalDisplay } from "./host.js";
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
import { createUiContext, type UiSession } from "./ui-context.js";

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

/** Meaning of the thinking levels of virtual models, which are inputs to the router rather than reasoning budgets. */
const VIRTUAL_THINKING_LABELS: Record<string, Record<string, string>> = {
	"router/auto": { low: "Low · economy", medium: "Medium · balanced", high: "High · quality" },
};

const UPDATE_THROTTLE_MS = 250;

const modelKey = (m: Pick<Model, "provider" | "id">) => `${m.provider}/${m.id}`;

/** Virtual models are catalog entries with api "pi-virtual" that route each request to a physical model. */
const isVirtual = (m: Pick<Model, "api">) => m.api === "pi-virtual";
const isVirtualGroup = (group: SessionConfigSelectGroup, models: readonly Model[]) =>
	models.some((m) => m.provider === group.group && isVirtual(m));

/** Bytes already written to a display-only Zed terminal for a bash tool call. */
interface TerminalState {
	sent: string;
}

const CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";
const toTerminal = (text: string) => text.replace(/\r?\n/g, "\r\n");

export class PiAcpSession implements UiSession {
	readonly id: string;
	readonly statuses = new Map<string, string>();
	readonly ready: Promise<void>;
	private markReady!: () => void;
	private isReady = false;
	private cancelRequested = false;
	private snapshots = new Map<string, FileSnapshot>();
	private terminals = new Map<string, TerminalState>();
	private lastPartialUpdate = new Map<string, number>();
	private compactionSeq = 0;
	private compactionId: string | undefined;
	/** Custom entries (extension cards) already shown, by entry id. */
	private shownEntries = new Set<string>();
	private unsubscribe: () => void;

	private constructor(
		readonly session: AgentSession,
		readonly cwd: string,
		private readonly host: Host,
	) {
		this.id = session.sessionId;
		this.ready = new Promise((resolve) => (this.markReady = resolve));
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
	}

	static async create(session: AgentSession, cwd: string, host: Host): Promise<PiAcpSession> {
		const entry = new PiAcpSession(session, cwd, host);
		await session.bindExtensions({
			uiContext: createUiContext(host, entry),
			mode: "rpc",
			onError: (err) => console.error(`[pi-zed] extension error (${err.extensionPath}, ${err.event}): ${err.error}`),
		});
		return entry;
	}

	/**
	 * Zed accepts session/update only once it knows the session id: after the session/new
	 * response, or right away for session/load. Dialogs and notices wait for this.
	 */
	activate() {
		this.isReady = true;
		this.markReady();
	}

	send(update: SessionUpdate): Promise<void> {
		if (!this.isReady) return this.ready.then(() => this.send(update));
		return this.host.client.notify(methods.client.session.update, { sessionId: this.id, update }).catch((err) => {
			console.error("[pi-zed] failed to send session/update:", err);
		});
	}

	private message(text: string) {
		return this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
	}

	private notice(severity: "info" | "warning" | "error", title: string, description?: string) {
		if (supportsNotices(this.host)) return this.send({ sessionUpdate: "notice", severity, title, description: description ?? null });
		const text = `${title}${description ? ` — ${description}` : ""}`;
		return this.message(severity === "info" ? `\n\n_${text}_\n\n` : `\n\n**${text}**\n\n`);
	}

	/** Streams new bash output into the display-only terminal (clears it when the tail was truncated). */
	private terminalOutput(toolCallId: string, text: string) {
		const term = this.terminals.get(toolCallId);
		if (!term || text === term.sent) return;
		const data = text.startsWith(term.sent) ? text.slice(term.sent.length) : CLEAR_TERMINAL + text;
		term.sent = text;
		return this.send({
			sessionUpdate: "tool_call_update",
			toolCallId,
			_meta: { terminal_output: { terminal_id: toolCallId, data: toTerminal(data) } },
		});
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
				const { toolCallId, toolName, args } = event;
				const mutation = isFileMutation(toolName, args);
				// Listeners run synchronously before the tool executes: snapshot the original file now.
				if (mutation) {
					const snapshot = snapshotFile(args, this.cwd);
					if (snapshot) this.snapshots.set(toolCallId, snapshot);
				}
				const terminal = toolName === "bash" && useTerminalDisplay(this.host);
				if (terminal) this.terminals.set(toolCallId, { sent: "" });
				const title = toolTitle(toolName, args, this.cwd);
				void this.send({
					sessionUpdate: "tool_call",
					toolCallId,
					// Nested calls (codemode scripts, ctx.executeTool) are shown inline under their parent.
					title: event.parentToolCallId ? `↳ ${title}` : title,
					kind: toolKind(toolName),
					status: "in_progress",
					rawInput: args,
					locations: toolLocations(args, this.cwd),
					content: mutation
						? argsDiff(toolName, args, this.cwd)
						: terminal
							? [{ type: "terminal", terminalId: toolCallId }]
							: undefined,
					_meta: terminal ? { terminal_info: { terminal_id: toolCallId, cwd: this.cwd } } : undefined,
				});
				break;
			}
			case "tool_execution_update": {
				const text = resultText(event.partialResult);
				if (this.terminals.has(event.toolCallId)) {
					void this.terminalOutput(event.toolCallId, text);
					break;
				}
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
				const { toolCallId, toolName, isError, result } = event;
				const snapshot = this.snapshots.get(toolCallId);
				this.snapshots.delete(toolCallId);
				this.lastPartialUpdate.delete(toolCallId);
				if (this.terminals.has(toolCallId)) {
					void this.terminalOutput(toolCallId, resultText(result));
					this.terminals.delete(toolCallId);
					const exitCode = result?.structuredContent?.exit_code;
					void this.send({
						sessionUpdate: "tool_call_update",
						toolCallId,
						status: isError ? "failed" : "completed",
						rawOutput: result?.details,
						_meta: {
							terminal_exit: {
								terminal_id: toolCallId,
								exit_code: typeof exitCode === "number" ? exitCode : isError ? 1 : 0,
								signal: null,
							},
						},
					});
					break;
				}
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
				if (supportsCompaction(this.host)) {
					this.compactionId = `compaction-${Date.now()}-${++this.compactionSeq}`;
					void this.send({ sessionUpdate: "compaction_update", compactionId: this.compactionId, status: "in_progress" });
				} else {
					void this.message(`\n\n_Compacting context (${event.reason})…_\n\n`);
				}
				break;
			case "compaction_end":
				if (this.compactionId) {
					const compactionId = this.compactionId;
					this.compactionId = undefined;
					if (event.aborted) {
						void this.send({ sessionUpdate: "compaction_update", compactionId, status: "cancelled" });
					} else if (event.errorMessage || !event.result) {
						void this.send({ sessionUpdate: "compaction_update", compactionId, status: "failed", error: event.errorMessage ?? null });
					} else {
						void this.send({
							sessionUpdate: "compaction_update",
							compactionId,
							status: "completed",
							summary: [{ type: "text", text: event.result.summary }],
						});
					}
				} else if (event.errorMessage) {
					void this.message(`\n\n**Compaction failed:** ${event.errorMessage}\n\n`);
				} else if (event.result) {
					void this.message(`_Context compacted (${event.result.tokensBefore} tokens summarized)._\n\n`);
				}
				void this.sendUsage();
				break;
			case "auto_retry_start":
				void this.notice("warning", `Retrying (${event.attempt}/${event.maxAttempts})`, event.errorMessage);
				break;
			case "agent_settled":
				void this.sendUsage();
				// Extensions append their cards in their own agent_settled handlers, which may run after this one.
				setTimeout(() => this.flushCustomEntries(), 0);
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
		this.flushCustomEntries();
		// Extension commands may have changed resources, model or thinking level.
		if (text.startsWith("/")) {
			void this.sendAvailableCommands();
			void this.sendConfigOptions();
		}
		return this.cancelRequested ? ("cancelled" as const) : ("end_turn" as const);
	}

	/** Shows custom entries added to the branch since the last call (e.g. llm-router's query card). */
	private flushCustomEntries() {
		for (const entry of this.session.sessionManager.getBranch()) {
			if (entry.type !== "custom" || this.shownEntries.has(entry.id)) continue;
			this.shownEntries.add(entry.id);
			const update = customEntryUpdate(this.host, this.session, entry);
			if (update) void this.send(update);
		}
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
				const seq = this.compactionSeq;
				try {
					await this.session.compact(args || undefined);
				} catch (err: any) {
					// A compaction that started already reported its failure through compaction_update.
					const reported = supportsCompaction(this.host) && this.compactionSeq !== seq;
					if (!this.cancelRequested && !reported) {
						await this.message(`**Compaction failed:** ${err?.message ?? err}`);
					}
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
		const routed = this.session.routedModel;
		const routedLabel = routed ? ` → \`${modelKey(routed.model)}\`${routed.thinkingLevel ? ` · ${routed.thinkingLevel}` : ""}` : "";
		const lines = [
			`**Session** \`${s.sessionId}\`${this.session.sessionName ? ` — ${this.session.sessionName}` : ""}`,
			s.sessionFile ? `- File: \`${s.sessionFile}\`` : "- File: (in memory)",
			`- Model: ${model ? `\`${modelKey(model)}\`` : "none"} · thinking: ${this.session.thinkingLevel}${routedLabel}`,
			`- Messages: ${s.userMessages} user, ${s.assistantMessages} assistant, ${s.toolCalls} tool calls`,
			`- Tokens: ${s.tokens.input.toLocaleString()} in, ${s.tokens.output.toLocaleString()} out, ${s.tokens.cacheRead.toLocaleString()} cache read, ${s.tokens.cacheWrite.toLocaleString()} cache write`,
			`- Cost: $${s.cost.toFixed(4)}`,
		];
		if (usage) {
			const pct = usage.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
			lines.push(`- Context: ${usage.tokens?.toLocaleString() ?? "?"} / ${usage.contextWindow.toLocaleString()} (${pct})`);
		}
		if (this.statuses.size > 0) {
			lines.push("", "**Extension status**");
			for (const [key, text] of this.statuses) lines.push(`- ${key}: ${text}`);
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
				// Virtual models (e.g. router/auto) come first: they are the ones that choose a model for you.
				options: [...groups.values()].sort((a, b) => Number(isVirtualGroup(b, models)) - Number(isVirtualGroup(a, models))),
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
				options: levels.map((level) => ({
					value: level,
					name: (current && VIRTUAL_THINKING_LABELS[modelKey(current)]?.[level]) ?? THINKING_LABELS[level] ?? level,
				})),
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
		return replayBranch(this.session.sessionManager.getBranch(), this.cwd, (update) => this.send(update), {
			compactionUpdates: supportsCompaction(this.host),
			customEntry: (entry) => {
				this.shownEntries.add(entry.id);
				return customEntryUpdate(this.host, this.session, entry);
			},
		});
	}

	dispose() {
		this.unsubscribe();
		this.session.dispose();
	}
}
