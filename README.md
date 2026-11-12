# pi-zed

In-process ACP adapter for [pi](https://github.com/earendil-works/pi). Zed spawns this as an external agent; pi runs inside the same Node process via the SDK (no `pi --mode rpc` child).

```
Zed ──ACP (stdio JSON-RPC)──▶ pi-zed (Node) ──import──▶ @earendil-works/pi-coding-agent SDK
```

## Requirements

- Node.js 22+
- pi configured once in the terminal (models / API keys in `~/.pi/agent`)
- Zed with external agent (ACP) support

## Quick start

```bash
git clone https://github.com/jaryeongfw/pi-zed.git
cd pi-zed
./scripts/setup.sh
```

Then in Zed: Agent panel → `+` → **pi-zed**.

`setup.sh` does everything in one go:

1. Checks Node.js 22+ and pi config
2. `npm install` → `npm run build`
3. Smoke test (`initialize` + `session/new` only, no model call)
4. Registers `agent_servers.pi-zed` in Zed `settings.json`

| Command | Description |
|---|---|
| `./scripts/setup.sh` | Install → build → smoke test → register in Zed |
| `./scripts/setup.sh --skip-test` | Same, without the smoke test |
| `./scripts/setup.sh --uninstall` | Remove `pi-zed` from Zed settings |
| `./scripts/update.sh` | Update to the latest version (see [Updating](#updating)) |
| `node scripts/configure-zed.mjs --dry-run` | Print the resulting settings without writing |
| `node scripts/smoke.mjs "prompt"` | ACP smoke test without Zed, advertising Zed-like client capabilities (sends a real prompt if given; `SMOKE_CAPS=none` for a bare client) |
| `node dist/index.js --pi [args]` | Run the regular pi TUI (used by Zed's login flow) |

Notes:

- Edits `~/.config/zed/settings.json` in place (comments/formatting preserved) and writes a timestamped `settings.json.bak-*` first. Idempotent; uninstall also drops an empty `agent_servers`.
- Registers the absolute `node` path, since Zed (a GUI app) may not see nvm's PATH. **Re-run after switching Node versions.**
- Target another settings file with `ZED_SETTINGS=/path/to/settings.json`.

## Updating

```bash
./scripts/update.sh          # pull → deps (if changed) → build → smoke test → swap → re-register
./scripts/update.sh --check  # only show pending commits
./scripts/update.sh --force  # rebuild even when already up to date
```

No uninstall needed. The new build goes to `dist.next/` and only replaces `dist/` after it builds and passes the smoke test. If anything fails, the checkout and dependencies are rolled back and the current install keeps working. `npm install` only runs when `package.json` / `package-lock.json` changed. Refuses to run with uncommitted changes. Restart Zed afterwards (running pi-zed processes keep the old code).

## Manual setup

```bash
npm install && npm run build
```

Add to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "pi-zed": {
      "type": "custom",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pi-zed/dist/index.js"]
    }
  }
}
```

## Troubleshooting

- **Agent doesn't start / errors in panel** → Zed command palette: `dev: open acp logs`
- **`node` not found** → re-run `./scripts/setup.sh` (uses `which node` of the current shell)
- **No model / auth errors** → use **Log in with pi** in the agent panel (or run `pi` in a terminal) and `/login` to a provider
- **Edits behave oddly with format-on-save** → set `PI_ZED_FS=0` in the agent's `env` to write files directly instead of through Zed buffers

## Features

- initialize / session/new / session/prompt / session/cancel
- Text + thinking streaming, tool calls with file locations
- **Edit diffs** — `edit` / `write` show a full-file diff in Zed (file snapshotted right before the tool runs)
- **Zed buffers** — `read` / `write` / `edit` go through Zed (`fs/*`): reads see unsaved changes, writes show up in Zed's agent review (keep / reject). Falls back to disk outside the project. Opt out: `PI_ZED_FS=0`
- **Terminal output** — `bash` output streams into an embedded Zed terminal (ANSI colors, exit code). pi still runs the command (same shell, settings, timeouts). Opt out: `PI_ZED_TERMINAL=0`
- **Extension UI** — `ctx.ui.select` / `confirm` / `input` / `editor` become Zed forms (elicitation); `notify` and MCP/retry messages become notices; `setStatus` shows up in `/session`. TUI-only UI (widgets, custom components) is ignored
- **Login** — with no usable model, Zed offers **Log in with pi**, which opens the pi TUI in a terminal for `/login`
- **MCP** — pi's built-in MCP / codemode / tool-search extensions are loaded like in the CLI (`mcp.json`, `/mcp`), and MCP servers configured in Zed (stdio, HTTP) are passed to pi. Nested tool calls (codemode scripts) are shown as `↳` entries
- **Compaction** — shown with Zed's compaction UI (live and when replaying history)
- **Session history** — `session/list` + `session/load`: resume pi sessions (also ones started in the pi TUI) with the conversation replayed; deleting a thread in Zed deletes the pi session file (moved to the Trash when `trash` exists)
- **Slash commands** (`available_commands_update`): extension commands, prompt templates, `/skill:name`, plus adapter built-ins:
  `/compact [instructions]`, `/name <name>`, `/session`, `/reload`
- **Model & thinking selectors** in the agent panel footer (session config options); choices are saved as pi defaults like the TUI
- **Virtual models / llm-router** — virtual models such as `router/auto` ([llm-router](https://github.com/jaryeongfw/llm-router), installed with `pi install`) are listed first in the model selector, and their thinking levels carry the router's meaning (Low · economy / Medium · balanced / High · quality). `/session` shows the routed model next to the selection (`router/auto · thinking: low → provider/model · off`)
- **Extension cards** — custom entries drawn by an extension entry renderer (`pi.registerEntryRenderer`, e.g. llm-router's per-query card with tier, model, thinking and usage) are shown as a notice after the turn and when a session is loaded. `/router status` and `/router stats` work as notices; the status line appears in `/session`
- Context usage / cost (`usage_update`), image prompts

Not supported: tool permission prompts (pi runs tools without asking, as in the TUI), session fork / rename from Zed (Zed 1.27 doesn't send `session/fork` / `session/set_title` to external agents), ACP subagent threads (behind a Zed beta flag).

## License

MIT — see [LICENSE](LICENSE).
