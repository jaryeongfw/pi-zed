/** What the adapter knows about the connected ACP client (Zed). */
import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";

export interface Host {
	client: AgentContext;
	caps: ClientCapabilities;
}

const envOff = (name: string) => /^(0|false|off|no)$/i.test(process.env[name] ?? "");

/** Route read/write/edit through Zed's buffers (unsaved changes, review UI). Opt out: PI_ZED_FS=0. */
export function useClientFs(host: Host): boolean {
	return !envOff("PI_ZED_FS") && !!host.caps.fs?.readTextFile && !!host.caps.fs?.writeTextFile;
}

/** Show bash output in a display-only Zed terminal. Opt out: PI_ZED_TERMINAL=0. */
export function useTerminalDisplay(host: Host): boolean {
	return !envOff("PI_ZED_TERMINAL") && host.caps._meta?.terminal_output === true;
}

export const supportsNotices = (host: Host) => !!host.caps.session?.notices;
export const supportsCompaction = (host: Host) => !!host.caps.session?.compaction;
export const supportsElicitation = (host: Host) => !!host.caps.elicitation?.form;
export const supportsTerminalAuth = (host: Host) => !!host.caps.auth?.terminal;
