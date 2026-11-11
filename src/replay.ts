/** Replays a persisted pi session branch as ACP session/update notifications (session/load). */
import type { ContentBlock, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { parseSkillBlock, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { argsDiff, fence, isFileMutation, resultText, textContent, toolKind, toolLocations, toolTitle } from "./tools.js";

type Send = (update: SessionUpdate) => Promise<void>;

function userText(text: string): string {
	const skill = parseSkillBlock(text);
	if (!skill) return text;
	return `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}`;
}

function contentBlocks(content: unknown, mapText: (t: string) => string = (t) => t): ContentBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: mapText(content) }] : [];
	if (!Array.isArray(content)) return [];
	return content.flatMap((c: any): ContentBlock[] => {
		if (c?.type === "text" && c.text) return [{ type: "text", text: mapText(c.text) }];
		if (c?.type === "image" && c.data) return [{ type: "image", data: c.data, mimeType: c.mimeType }];
		return [];
	});
}

export async function replayBranch(entries: SessionEntry[], cwd: string, send: Send): Promise<void> {
	// Tool calls seen in assistant messages, so results can be rendered with their arguments.
	const calls = new Map<string, { name: string; args: any }>();

	for (const entry of entries) {
		if (entry.type === "compaction") {
			await send({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `\n\n_— context compacted (${entry.tokensBefore} tokens summarized) —_\n\n` },
			});
			continue;
		}
		if (entry.type === "custom_message") {
			if (!entry.display) continue;
			for (const content of contentBlocks(entry.content)) await send({ sessionUpdate: "agent_message_chunk", content });
			continue;
		}
		if (entry.type !== "message") continue;

		const msg: any = entry.message;
		switch (msg.role) {
			case "user":
				for (const content of contentBlocks(msg.content, userText)) {
					await send({ sessionUpdate: "user_message_chunk", content });
				}
				break;
			case "assistant":
				for (const block of msg.content ?? []) {
					if (block.type === "thinking" && block.thinking) {
						await send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
					} else if (block.type === "text" && block.text) {
						await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
					} else if (block.type === "toolCall") {
						calls.set(block.id, { name: block.name, args: block.arguments });
						await send({
							sessionUpdate: "tool_call",
							toolCallId: block.id,
							title: toolTitle(block.name, block.arguments, cwd),
							kind: toolKind(block.name),
							status: "in_progress",
							rawInput: block.arguments,
							locations: toolLocations(block.arguments, cwd),
						});
					}
				}
				if (msg.stopReason === "error" && msg.errorMessage) {
					await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n**Error:** ${msg.errorMessage}` } });
				}
				break;
			case "toolResult": {
				const call = calls.get(msg.toolCallId);
				const name = call?.name ?? msg.toolName;
				let content: ToolCallContent[];
				if (!msg.isError && call && isFileMutation(name, call.args)) {
					content = argsDiff(name, call.args, cwd);
				} else {
					content = textContent(name, resultText(msg));
				}
				await send({
					sessionUpdate: "tool_call_update",
					toolCallId: msg.toolCallId,
					status: msg.isError ? "failed" : "completed",
					content,
				});
				break;
			}
			case "bashExecution":
				await send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: `\`!${msg.command}\`` } });
				if (msg.output) {
					await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${fence(msg.output, "console")}\n` } });
				}
				break;
			case "custom":
				if (!msg.display) break;
				for (const content of contentBlocks(msg.content)) await send({ sessionUpdate: "agent_message_chunk", content });
				break;
		}
	}
}
