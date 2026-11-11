// Registers (or removes) pi-zed in Zed's settings.json, preserving comments/formatting.
// Usage: node scripts/configure-zed.mjs [--uninstall] [--dry-run]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

const NAME = "pi-zed";
const args = new Set(process.argv.slice(2));
const uninstall = args.has("--uninstall");
const dryRun = args.has("--dry-run");

const settingsPath = process.env.ZED_SETTINGS ?? path.join(os.homedir(), ".config", "zed", "settings.json");
const entry = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "index.js");

const original = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "{}\n";
const errors = [];
parse(original, errors, { allowTrailingComma: true });
if (errors.length) {
	console.error(`✗ ${settingsPath} 파싱 실패 (JSONC 오류 ${errors.length}개). 수동으로 확인해주세요.`);
	process.exit(1);
}

// Zed는 GUI 앱이라 nvm PATH를 못 볼 수 있으므로 node 절대경로를 사용한다.
const value = uninstall
	? undefined
	: { type: "custom", command: process.execPath, args: [entry], env: {} };

const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
let updated = applyEdits(original, modify(original, ["agent_servers", NAME], value, fmt));
// 제거 후 agent_servers가 비었으면 키 자체를 정리
const servers = parse(updated, [], { allowTrailingComma: true })?.agent_servers;
if (uninstall && servers && Object.keys(servers).length === 0) {
	updated = applyEdits(updated, modify(updated, ["agent_servers"], undefined, fmt));
}

if (updated === original) {
	console.log(`• 변경 없음 (${settingsPath})`);
	process.exit(0);
}
if (dryRun) {
	console.log(updated);
	process.exit(0);
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
if (fs.existsSync(settingsPath)) {
	const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	fs.copyFileSync(settingsPath, backup);
	console.log(`• 백업: ${backup}`);
}
fs.writeFileSync(settingsPath, updated);
console.log(uninstall ? `✓ agent_servers.${NAME} 제거됨` : `✓ agent_servers.${NAME} 등록됨 → ${process.execPath} ${entry}`);
