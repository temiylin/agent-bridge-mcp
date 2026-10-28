#!/usr/bin/env node
/**
 * One-Click Automated Setup for Agent Bridge
 * Designed to be executed directly by Codex or a user:
 * 1. Generates or loads persistent unique Device Token
 * 2. Builds project binaries
 * 3. Registers MCP server into local Codex automatically (codex mcp add)
 * 4. Configures background auto-start daemon (macOS LaunchAgent)
 * 5. Packages personalized agent-bridge-plugin.zip onto Desktop for ChatGPT
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".agent-bridge");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const RELAY_SERVER = process.env.RELAY_SERVER || "wss://bridge.krow.top/ws";
const RELAY_HTTP = process.env.RELAY_HTTP || "https://bridge.krow.top/mcp";

async function main() {
  console.log("\n===============================================================");
  console.log("  🚀 Agent Bridge 智能全自动部署向导 (Codex 自动执行专用)");
  console.log("===============================================================\n");

  // 1. 确保构建产物存在
  console.log("[1/5] 正在构建本地核心程序...");
  if (!fs.existsSync(path.join(PROJECT_ROOT, "node_modules"))) {
    console.log("安装依赖中 (npm install)...");
    execSync("npm install", { cwd: PROJECT_ROOT, stdio: "inherit" });
  }
  execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
  console.log("✅ 核心程序构建完成！\n");

  // 2. 生成或读取本台电脑的专属永久设备识别码 (Device Token)
  console.log("[2/5] 正在配置专属设备识别凭证...");
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let deviceToken = "";
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      deviceToken = cfg.deviceToken || "";
    } catch {}
  }

  if (!deviceToken) {
    const rawHost = os.hostname().replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "device";
    const rand = randomBytes(3).toString("hex");
    deviceToken = `dev_${rawHost}_${rand}`;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceToken, createdAt: new Date().toISOString() }, null, 2));
  }
  console.log(`✅ 设备识别码已锁定: \x1b[32m\x1b[1m${deviceToken}\x1b[0m\n`);

  // 3. 自动将 MCP 注册到 Codex 中
  console.log("[3/5] 正在自动挂载到本地 Codex 系统...");
  try {
    const hasCodex = spawnSync("which", ["codex"]).status === 0;
    if (hasCodex) {
      // 先尝试移除旧的，再添加新的
      try {
        execSync("codex mcp remove agent-bridge", { stdio: "pipe" });
      } catch {}
      execSync(`codex mcp add agent-bridge --url "${RELAY_HTTP}/${deviceToken}"`, { stdio: "inherit" });
      console.log("✅ 已成功挂载到 Codex！在 Codex 中已可直接调用。");
    } else {
      console.log("ℹ️ 未检测到 codex CLI 命令行工具，跳过 CLI 挂载。");
    }
  } catch (err) {
    console.warn("⚠️ 自动挂载 Codex 遇到提示 (可稍后手动重试):", err.message);
  }
  console.log();

  // 4. 配置 macOS LaunchAgent 后台开机自动运行
  console.log("[4/5] 正在配置系统后台开机自启连接...");
  if (os.platform() === "darwin") {
    const launchAgentsDir = path.join(HOME, "Library", "LaunchAgents");
    if (!fs.existsSync(launchAgentsDir)) {
      fs.mkdirSync(launchAgentsDir, { recursive: true });
    }

    const plistPath = path.join(launchAgentsDir, "com.agent-bridge.relay.plist");
    const nodeBin = process.execPath;
    const clientScript = path.join(PROJECT_ROOT, "dist", "index.js");

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-bridge.relay</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${clientScript}</string>
        <string>--connect</string>
        <string>--server</string>
        <string>${RELAY_SERVER}</string>
        <string>--token</string>
        <string>${deviceToken}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(CONFIG_DIR, "client.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(CONFIG_DIR, "client.err")}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plistContent, "utf-8");

    // 重新加载后台服务
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { stdio: "pipe" });
      execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
      console.log(`✅ 后台守护服务已安装并激活！开机自动在后台连接云端网关。`);
    } catch (err) {
      console.warn("⚠️ 激活 LaunchAgent 提示:", err.message);
    }
  } else {
    console.log("ℹ️ 非 macOS 系统，请使用 'npm run connect' 在后台运行客户端。");
  }
  console.log();

  // 5. 为 ChatGPT 生成定制的一键安装包 (放在桌面)
  console.log("[5/5] 正在为 ChatGPT 生成专属一键插件包...");
  const tempPackDir = path.join(CONFIG_DIR, "temp-plugin");
  if (fs.existsSync(tempPackDir)) {
    fs.rmSync(tempPackDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(tempPackDir, "skills", "agent-bridge"), { recursive: true });

  // 写入 plugin.json
  const pluginJson = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "agent-bridge",
    version: "1.0.0",
    description: "Directly inspect, monitor, and dispatch tasks to your local Mac/PC from ChatGPT.",
  };
  fs.writeFileSync(path.join(tempPackDir, "plugin.json"), JSON.stringify(pluginJson, null, 2));

  // 写入绑定当前专属设备码的 mcp.json
  const mcpJson = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      "agent-bridge": {
        type: "streamable-http",
        url: `${RELAY_HTTP}/${deviceToken}`,
      },
    },
  };
  fs.writeFileSync(path.join(tempPackDir, "mcp.json"), JSON.stringify(mcpJson, null, 2));

  // 复制 SKILL.md
  const skillSrc = path.join(PROJECT_ROOT, "plugin-package", "skills", "agent-bridge", "SKILL.md");
  if (fs.existsSync(skillSrc)) {
    fs.copyFileSync(skillSrc, path.join(tempPackDir, "skills", "agent-bridge", "SKILL.md"));
  }

  // 打包到桌面
  const desktopZip = path.join(HOME, "Desktop", "agent-bridge-plugin.zip");
  try {
    execSync(`cd "${tempPackDir}" && zip -r "${desktopZip}" .`, { stdio: "pipe" });
    console.log(`✅ 专属插件包已生成在桌面: \x1b[36m\x1b[1m${desktopZip}\x1b[0m\n`);
  } catch (err) {
    console.warn("⚠️ 打包 zip 提示:", err.message);
  }

  console.log("===============================================================");
  console.log("🎉 全部部署大功告成！你现在拥有了完整的双重访问能力：");
  console.log("===============================================================");
  console.log("1️⃣  【在 Codex 中】:");
  console.log("    现在直接在 Codex 窗口提问，即可自动调用本地工具！无需任何多余操作。");
  console.log();
  console.log("2️⃣  【在 ChatGPT 普通聊天窗口中】:");
  console.log("    打开 ChatGPT -> 设置 -> Connectors/MCP ->「上传插件压缩包」");
  console.log("    直接选择你桌面上的「agent-bridge-plugin.zip」即可！");
  console.log("===============================================================\n");
}

main().catch((err) => {
  console.error("部署失败:", err);
  process.exit(1);
});
