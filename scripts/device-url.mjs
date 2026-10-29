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
const localPort = process.env.AGENT_BRIDGE_PORT || process.env.PORT || 38080;
const localDashboardUrl = `http://localhost:${localPort}`;
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
console.log(`🖥️ 本地配置网页端:   \x1b[35m\x1b[1m${localDashboardUrl}\x1b[0m (可视化自定义 Agent 调度与场景规则)`);
if (fs.existsSync(desktopZip)) {
  console.log(`📦 本机专属插件包:   \x1b[33m\x1b[1m${desktopZip}\x1b[0m`);
}
console.log("---------------------------------------------------------------");
console.log("💡 使用方法:");
console.log(`   1. 浏览器打开本地配置页面: \x1b[35m\x1b[1m${localDashboardUrl}\x1b[0m`);
console.log("      由您自主配置本地 Agent 调度规则与场景说明（默认留空，按需设置）。");
console.log("   2. 在 ChatGPT 中使用 (任选一种):");
console.log("      • 方式 A (最简): 打开 ChatGPT -> 设置 -> Connectors/MCP -> 上传桌面上的 agent-bridge-plugin.zip");
console.log(`      • 方式 B (手动): MCP URL 填入上面的地址，身份验证选「无 (None)」`);
console.log("===============================================================\n");
