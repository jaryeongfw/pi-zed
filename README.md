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
| `node scripts/configure-zed.mjs --dry-run` | Print the resulting settings without writing |
| `node scripts/smoke.mjs "prompt"` | ACP smoke test without Zed (sends a real prompt if given) |

Notes:

- Edits `~/.config/zed/settings.json` in place (comments/formatting preserved) and writes a timestamped `settings.json.bak-*` first. Idempotent; uninstall also drops an empty `agent_servers`.
- Registers the absolute `node` path, since Zed (a GUI app) may not see nvm's PATH. **Re-run after switching Node versions.**
- Target another settings file with `ZED_SETTINGS=/path/to/settings.json`.

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
- **No model / auth errors** → run `pi` in a terminal once and configure a provider

## Status (MVP)

- [x] initialize / session/new / session/prompt / session/cancel
- [x] text + thinking streaming
- [x] tool_call / tool_call_update (with file locations)
- [ ] edit diffs (structured `diff` content)
- [ ] session/load (resume pi sessions)
- [ ] slash commands / skills (`available_commands_update`)
- [ ] permission requests, image prompts, model selection

## License

MIT — see [LICENSE](LICENSE).
