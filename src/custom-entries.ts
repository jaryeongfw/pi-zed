/**
 * Extension entry renderers (pi.registerEntryRenderer) are TUI components. In Zed they are drawn
 * with a plain-text theme and shown as a session notice, e.g. llm-router's per-query card.
 * Custom entries never reach the model, so this is display only.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Host, supportsNotices } from "./host.js";
import { plainTheme } from "./ui-context.js";

const RENDER_WIDTH = 100;
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

/** Plain-text lines of a custom entry, or undefined when no extension renders its type. */
export function renderCustomEntry(session: AgentSession, entry: SessionEntry, expanded = false): string[] | undefined {
	if (entry.type !== "custom") return undefined;
	const renderer = session.extensionRunner.getEntryRenderer(entry.customType);
	if (!renderer) return undefined;
	try {
		const component = renderer(entry, { expanded, keyText: () => "", keyHint: () => "" }, plainTheme);
		const lines = (component?.render(RENDER_WIDTH) ?? []).map((l) => l.replace(ANSI, "").trimEnd());
		while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
		return lines.length > 0 ? lines : undefined;
	} catch (err) {
		console.error(`[pi-zed] entry renderer failed (${entry.customType}):`, err);
		return undefined;
	}
}

/** Turns a custom entry into a notice (or a fenced message when the client has no notices). */
export function customEntryUpdate(host: Host, session: AgentSession, entry: SessionEntry): SessionUpdate | undefined {
	const lines = renderCustomEntry(session, entry);
	if (!lines) return undefined;
	if (supportsNotices(host)) {
		const [title, ...rest] = lines;
		const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), Infinity);
		const description = rest.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n").trim();
		return { sessionUpdate: "notice", severity: "info", title: title.trim(), description: description || null };
	}
	return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n\n` } };
}
