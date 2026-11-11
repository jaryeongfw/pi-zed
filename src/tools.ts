/** Mapping pi tool calls onto ACP tool_call / tool_call_update payloads. */
import fs from "node:fs";
import path from "node:path";
import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

const TOOL_KINDS: Record<string, ToolKind> = {
	read: "read",
	ls: "read",
	edit: "edit",
	write: "edit",
	bash: "execute",
	grep: "search",
	find: "search",
};

/** Files bigger than this are not snapshotted for full-file diffs. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function toolKind(name: string): ToolKind {
	return TOOL_KINDS[name] ?? "other";
}

function displayPath(p: string, cwd: string): string {
	const rel = path.relative(cwd, path.resolve(cwd, p));
	return rel && !rel.startsWith("..") ? rel : p;
}

export function toolTitle(name: string, args: any, cwd: string): string {
	if (typeof args?.path === "string") {
		const target = displayPath(args.path, cwd);
		if (name === "read" && typeof args.offset === "number") {
			const end = typeof args.limit === "number" ? args.offset + args.limit - 1 : "";
			return `read ${target}:${args.offset}-${end}`;
		}
		if (name === "grep" || name === "find") {
			const pattern = args.pattern ?? "";
			return `${name} ${JSON.stringify(String(pattern).slice(0, 80))} in ${target}`;
		}
		return `${name} ${target}`;
	}
	const target = args?.command ?? args?.pattern;
	return target ? `${name}: ${String(target).slice(0, 120)}` : name;
}

export function toolLocations(args: any, cwd: string): ToolCallLocation[] | undefined {
	if (typeof args?.path !== "string") return undefined;
	const location: ToolCallLocation = { path: path.resolve(cwd, args.path) };
	if (typeof args.offset === "number") location.line = args.offset;
	return [location];
}

export function resultText(result: any): string {
	const content = result?.content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return typeof result === "string" ? result : "";
}

/** Markdown code fence that cannot be closed by the wrapped text. */
export function fence(text: string, lang = ""): string {
	let ticks = "```";
	while (text.includes(ticks)) ticks += "`";
	return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

export function textContent(name: string, text: string): ToolCallContent[] {
	if (!text) return [];
	const body = name === "bash" ? fence(text, "console") : text;
	return [{ type: "content", content: { type: "text", text: body } }];
}

/** Whether a tool call mutates a file whose before/after state should be shown as a diff. */
export function isFileMutation(name: string, args: any): boolean {
	return (name === "edit" || name === "write") && typeof args?.path === "string";
}

export interface FileSnapshot {
	path: string;
	/** null when the file did not exist before the call. */
	oldText: string | null;
}

function readTextIfSmall(absPath: string): string | null | undefined {
	try {
		const stat = fs.statSync(absPath);
		if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined;
		return fs.readFileSync(absPath, "utf8");
	} catch (err: any) {
		return err?.code === "ENOENT" ? null : undefined;
	}
}

/**
 * Captures the file content before an edit/write runs. Session listeners are
 * invoked synchronously from `tool_execution_start`, before the tool executes.
 */
export function snapshotFile(args: any, cwd: string): FileSnapshot | undefined {
	const abs = path.resolve(cwd, args.path);
	const oldText = readTextIfSmall(abs);
	return oldText === undefined ? undefined : { path: abs, oldText };
}

/** Full-file diff from a pre-execution snapshot and the current file content. */
export function snapshotDiff(snapshot: FileSnapshot): ToolCallContent[] | undefined {
	const newText = readTextIfSmall(snapshot.path);
	if (typeof newText !== "string") return undefined;
	return [{ type: "diff", path: snapshot.path, oldText: snapshot.oldText, newText }];
}

/** Diff reconstructed from the tool arguments alone (used for previews and history replay). */
export function argsDiff(name: string, args: any, cwd: string): ToolCallContent[] {
	const abs = path.resolve(cwd, args.path);
	if (name === "write" && typeof args.content === "string") {
		return [{ type: "diff", path: abs, oldText: null, newText: args.content }];
	}
	if (name === "edit" && Array.isArray(args.edits)) {
		return args.edits
			.filter((e: any) => typeof e?.oldText === "string" && typeof e?.newText === "string")
			.map((e: any) => ({ type: "diff", path: abs, oldText: e.oldText, newText: e.newText }));
	}
	return [];
}
