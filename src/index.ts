#!/usr/bin/env node
/**
 * pi-zed: in-process ACP adapter for pi.
 *
 * Zed spawns this process (agent_servers) and talks ACP JSON-RPC over stdio.
 * pi runs inside this same process through the SDK, so no `pi --mode rpc` child.
 *
 * `pi-zed --pi [pi args…]` runs the regular pi TUI instead. Zed uses it as the
 * terminal login method (run `/login` there, then quit).
 */
const argv = process.argv.slice(2);

if (argv[0] === "--pi") {
	const { main } = await import("@earendil-works/pi-coding-agent");
	await main(argv.slice(1));
} else {
	await import("./server.js");
}
