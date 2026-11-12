/**
 * pi extension UI (ctx.ui.*) backed by ACP: dialogs become Zed elicitation forms,
 * notifications become session notices. TUI-only features are no-ops.
 */
import type { CreateElicitationRequest, ElicitationSchema, SessionUpdate } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { type Host, supportsElicitation, supportsNotices } from "./host.js";

export interface UiSession {
	readonly id: string;
	/** Resolves once Zed knows the session id (after the session/new response). */
	readonly ready: Promise<void>;
	send(update: SessionUpdate): Promise<void>;
	readonly statuses: Map<string, string>;
}

type FormContent = Record<string, unknown> | undefined;

/** Plain-text stand-in for pi's TUI theme: every styling method returns its text unchanged. */
export const plainTheme: any = new Proxy(
	{},
	{
		get: (_target, prop) => {
			if (prop === "name") return "plain";
			if (prop === Symbol.toPrimitive || prop === "then") return undefined;
			return (...args: unknown[]) => {
				const text = args.findLast((a) => typeof a === "string");
				return text ?? "";
			};
		},
	},
);

export function createUiContext(host: Host, session: UiSession): ExtensionUIContext {
	/** Shows an elicitation form; resolves to the submitted content, or undefined when declined/cancelled/unavailable. */
	async function form(message: string, requestedSchema: ElicitationSchema, opts?: ExtensionUIDialogOptions): Promise<FormContent> {
		if (!supportsElicitation(host) || opts?.signal?.aborted) return undefined;
		await session.ready;
		const controller = new AbortController();
		const signals = [controller.signal, opts?.signal, opts?.timeout ? AbortSignal.timeout(opts.timeout) : undefined].filter(
			(s): s is AbortSignal => !!s,
		);
		const signal = AbortSignal.any(signals);
		const aborted = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
		const params: CreateElicitationRequest = { mode: "form", sessionId: session.id, message, requestedSchema };
		const request = host.client
			.request(methods.client.elicitation.create, params, { cancellationSignal: signal })
			.then((res: any) => (res?.action === "accept" ? ((res.content ?? {}) as Record<string, unknown>) : undefined))
			.catch((err) => {
				if (!signal.aborted) console.error("[pi-zed] elicitation failed:", err);
				return undefined;
			});
		try {
			return await Promise.race([request, aborted]);
		} finally {
			controller.abort();
		}
	}

	const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
		const [first = "", ...rest] = message.trim().split("\n");
		if (!first) return;
		if (supportsNotices(host)) {
			void session.ready.then(() =>
				session.send({ sessionUpdate: "notice", severity: type, title: first, description: rest.join("\n").trim() || null }),
			);
			return;
		}
		const prefix = type === "error" ? "**Error:** " : type === "warning" ? "**Warning:** " : "";
		void session.ready.then(() =>
			session.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${prefix}${message}\n\n` } }),
		);
	};

	const ui: Omit<ExtensionUIContext, "theme"> & { readonly theme: any } = {
		async select(title, options, opts) {
			if (options.length === 0) return undefined;
			const content = await form(
				title,
				{
					type: "object",
					properties: {
						choice: { type: "string", title: "Choice", oneOf: options.map((o, i) => ({ const: String(i), title: o })) },
					},
					required: ["choice"],
				},
				opts,
			);
			const index = Number(content?.choice);
			return Number.isInteger(index) ? options[index] : undefined;
		},
		async confirm(title, message, opts) {
			const content = await form(message ? `${title}\n\n${message}` : title, { type: "object", properties: {} }, opts);
			return content !== undefined;
		},
		async input(title, placeholder, opts) {
			const content = await form(
				title,
				{ type: "object", properties: { value: { type: "string", title: placeholder || "Value" } }, required: ["value"] },
				opts,
			);
			return typeof content?.value === "string" ? content.value : undefined;
		},
		async editor(title, prefill) {
			const content = await form(title, {
				type: "object",
				properties: { value: { type: "string", title: "Text", default: prefill ?? null } },
				required: ["value"],
			});
			return typeof content?.value === "string" ? content.value : undefined;
		},
		notify,
		setStatus(key, text) {
			if (text === undefined) session.statuses.delete(key);
			else session.statuses.set(key, text);
		},
		onTerminalInput: () => () => {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		async custom() {
			return undefined as never;
		},
		pasteToEditor() {},
		setEditorText() {},
		getEditorText: () => "",
		addAutocompleteProvider() {},
		setEditorComponent() {},
		getEditorComponent: () => undefined,
		get theme() {
			return plainTheme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Themes are not supported in Zed" }),
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	};
	return ui as ExtensionUIContext;
}
