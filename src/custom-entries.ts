/**
 * Extension entry renderers (pi.registerEntryRenderer) are TUI components. In Zed they are drawn
 * with a plain-text theme and shown as a session notice, e.g. llm-router's per-query card.
 * Custom entries never reach the model, so this is display only.
 *
 * Each card is labelled with a short preview of the user query it answers, taken from the branch at
 * display time. Extensions such as llm-router deliberately keep query text out of their entries, so
 * the preview is never stored, and it is shown for every query, sensitive ones included.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Host, supportsNotices } from "./host.js";
import { userText } from "./replay.js";
import { plainTheme } from "./ui-context.js";

const RENDER_WIDTH = 100;
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;
const PREVIEW_CHARS = 40;

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join(" ");
}

/** One-line preview of the last user message before `branch[index]`, or undefined when there is none. */
export function queryPreview(branch: readonly SessionEntry[], index: number): string | undefined {
	for (let i = index - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "message" || (e.message as any).role !== "user") continue;
		const text = userText(messageText((e.message as any).content)).replace(/\s+/g, " ").trim();
		if (!text) return undefined;
		const chars = [...text];
		return `"${chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : text}"`;
	}
	return undefined;
}

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
export function customEntryUpdate(
	host: Host,
	session: AgentSession,
	entry: SessionEntry,
	preview?: string,
): SessionUpdate | undefined {
	const rendered = renderCustomEntry(session, entry);
	if (!rendered) return undefined;
	const lines = preview ? [`${rendered[0].trimEnd()}  › ${preview}`, ...rendered.slice(1)] : rendered;
	if (supportsNotices(host)) {
		const [title, ...rest] = lines;
		const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), Infinity);
		const description = rest.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n").trim();
		return { sessionUpdate: "notice", severity: "info", title: title.trim(), description: description || null };
	}
	return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n\n` } };
}
