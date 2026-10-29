#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CONFIG_FILE = path.join(HOME, ".agent-bridge", "config.json");
const RELAY_HTTP = process.env.RELAY_HTTP || "https://bridge.krow.top/mcp";

let deviceToken = "";
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    deviceToken = cfg.deviceToken || "";
  } catch {}
}

if (!deviceToken) {
  console.log("\n⚠️ 未检测到已配置的设备凭证。请先执行一次一键部署：\n   npm run auto-setup\n");
  process.exit(1);
}

const mcpUrl = `${RELAY_HTTP}/${deviceToken}`;
const desktopZip = path.join(HOME, "Desktop", "agent-bridge-plugin.zip");

// If --raw flag is passed, print only the URL for easy script piping / copy
if (process.argv.includes("--raw") || process.argv.includes("-r")) {
  console.log(mcpUrl);
  process.exit(0);
}

console.log("\n===============================================================");
console.log("  📡 Agent Bridge 本机专属 MCP 接入信息");
console.log("===============================================================");
console.log(`🔑 本机专属识别码:   \x1b[32m\x1b[1m${deviceToken}\x1b[0m`);
console.log(`📡 本机专属 MCP 地址: \x1b[36m\x1b[1m${mcpUrl}\x1b[0m`);
if (fs.existsSync(desktopZip)) {
  console.log(`📦 本机专属插件包:   \x1b[35m\x1b[1m${desktopZip}\x1b[0m`);
}
console.log("---------------------------------------------------------------");
console.log("💡 使用方法 (在 ChatGPT 中):");
console.log("   • 方式 A (最简): 打开 ChatGPT -> 设置 -> Connectors/MCP -> 上传桌面上的 agent-bridge-plugin.zip");
console.log(`   • 方式 B (手动): MCP URL 填入上面的地址，身份验证选「无 (None)」`);
console.log("===============================================================\n");
