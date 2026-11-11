# pi-zed

In-process ACP adapter for [pi](https://github.com/earendil-works/pi). Zed spawns this as an external agent; pi runs inside the same Node process via the SDK (no `pi --mode rpc` child).

```
Zed ──ACP (stdio JSON-RPC)──▶ pi-zed (Node) ──import──▶ @earendil-works/pi-coding-agent SDK
```

## Build

```bash
npm install
npm run build
node scripts/smoke.mjs "hello"   # ACP smoke test without Zed
```

## Zed setup

`~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "pi-zed": {
      "type": "custom",
      "command": "node",
      "args": ["/Users/choi/Private/pi-zed/dist/index.js"]
    }
  }
}
```

Open the Agent panel → `+` → **pi-zed**.

## Status (MVP)

- [x] initialize / session/new / session/prompt / session/cancel
- [x] text + thinking streaming
- [x] tool_call / tool_call_update (with file locations)
- [ ] edit diffs (structured `diff` content)
- [ ] session/load (resume pi sessions)
- [ ] slash commands / skills (`available_commands_update`)
- [ ] permission requests, image prompts, model selection

## One-shot setup

```bash
./scripts/setup.sh              # install → build → smoke test → register in Zed
./scripts/setup.sh --skip-test  # skip the smoke test
./scripts/setup.sh --uninstall  # remove from Zed settings
```

- Edits `~/.config/zed/settings.json` in place (comments preserved) and writes a timestamped `.bak-*` first.
- Uses the absolute `node` path, since Zed (GUI app) may not see nvm's PATH. Re-run after switching Node versions.
- Override target file with `ZED_SETTINGS=/path/to/settings.json`.
