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
import { execSync, spawnSync, spawn } from "node:child_process";
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

  if (process.platform === "win32") {
    const args = [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(__dirname, "setup-windows.ps1"), "-Action", "Install",
    ];
    // The installer preserves configured endpoints unless explicitly overridden.
    if (process.env.RELAY_SERVER) args.push("-RelayServer", process.env.RELAY_SERVER);
    if (process.env.RELAY_HTTP) args.push("-RelayHttp", process.env.RELAY_HTTP);
    if (process.env.AGENT_BRIDGE_ROOT) args.push("-DataPath", process.env.AGENT_BRIDGE_ROOT);
    if (process.env.AGENT_BRIDGE_OUTPUTS) args.push("-OutputsPath", process.env.AGENT_BRIDGE_OUTPUTS);
    const result = spawnSync("powershell.exe", args, {
      cwd: PROJECT_ROOT, stdio: "inherit", shell: false, windowsHide: true,
      env: {
        ...process.env,
        PSModulePath: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"),
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Windows setup exited with ${result.status}`);
    return;
  }

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

  // 校验 Token 强度：长度必须 >= 40 字符且不含主机名暴露。若属于旧版弱 Token，则平滑升级为 24 字节高强加密串 (192-bit 熵值)
  if (!deviceToken || deviceToken.length < 40 || !deviceToken.startsWith("dev_")) {
    const rand = randomBytes(24).toString("hex");
    deviceToken = `dev_${rand}`;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceToken, createdAt: new Date().toISOString() }, null, 2));
    console.log(`🔒 设备凭证已升级为高强随机加密串 (192-bit 熵值)`);
  }
  console.log(`✅ 设备识别码已锁定: \x1b[32m\x1b[1m${deviceToken}\x1b[0m\n`);

  // 确保 ~/agent-bridge/agents.json 存在默认的 codex 与 agy 执行配置
  const bridgeDataDir = path.join(HOME, "agent-bridge");
  const agentsJsonFile = path.join(bridgeDataDir, "agents.json");
  if (!fs.existsSync(bridgeDataDir)) {
    fs.mkdirSync(bridgeDataDir, { recursive: true });
  }
  if (!fs.existsSync(agentsJsonFile)) {
    const defaultAgents = {
      codex: {
        command: "codex",
        args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"],
        input: "stdin",
      },
      agy: {
        command: "agy",
        args: ["--dangerously-skip-permissions"],
        input: "stdin",
      },
    };
    fs.writeFileSync(agentsJsonFile, JSON.stringify(defaultAgents, null, 2), "utf8");
    console.log("✅ 已自动配置默认本地执行代理: codex 与 agy\n");
  }

  // 确保 ~/agent-bridge/routing.json 存在基础调度配置文件（留空由用户在网页端自主设置）
  const routingJsonFile = path.join(bridgeDataDir, "routing.json");
  if (!fs.existsSync(routingJsonFile)) {
    const defaultRouting = {
      defaultAgent: "codex",
      instructions: "",
      rules: [],
    };
    fs.writeFileSync(routingJsonFile, JSON.stringify(defaultRouting, null, 2), "utf8");
    console.log("✅ 已初始化场景调度配置 (留空由用户在控制台网页端自主设置)\n");
  }

  // 3. 自动将 MCP 注册到本地 AI 客户端 (Codex / Antigravity AGY)
  console.log("[3/5] 正在自动挂载到本地 AI 客户端 (Codex / AGY)...");
  const isWin = process.platform === "win32";
  const lookupCmd = isWin ? "where" : "which";
  let mountedAny = false;
  try {
    const hasCodex = spawnSync(lookupCmd, ["codex"]).status === 0;
    if (hasCodex) {
      try {
        execSync("codex mcp remove agent-bridge", { stdio: "pipe" });
      } catch {}
      execSync(`codex mcp add agent-bridge --url "${RELAY_HTTP}/${deviceToken}"`, { stdio: "inherit" });
      console.log("✅ 已成功挂载到 Codex！在 Codex 中已可直接调用。");
      mountedAny = true;
    }
  } catch (err) {
    console.warn("⚠️ 挂载 Codex 提示:", err.message);
  }

  try {
    const hasAgy = spawnSync(lookupCmd, ["agy"]).status === 0;
    if (hasAgy) {
      try {
        execSync("agy mcp remove agent-bridge", { stdio: "pipe" });
      } catch {}
      execSync(`agy mcp add agent-bridge "${RELAY_HTTP}/${deviceToken}"`, { stdio: "inherit" });
      console.log("✅ 已成功挂载到 Antigravity (AGY)！在 AGY 中已可直接调用。");
      mountedAny = true;
    }
  } catch (err) {
    console.warn("⚠️ 挂载 AGY 提示:", err.message);
  }

  if (!mountedAny) {
    console.log("ℹ️ 未检测到 codex 或 agy 命令行工具，跳过本地 CLI 挂载。");
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
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
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
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>AGENT_BRIDGE_REPO</key>
        <string>${PROJECT_ROOT}</string>
    </dict>
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
  } else if (isWin) {
    const startupDir = path.join(
      process.env.APPDATA || path.join(HOME, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup"
    );
    const vbsPath = path.join(startupDir, "agent-bridge.vbs");
    const nodeBin = process.execPath;
    const clientScript = path.join(PROJECT_ROOT, "dist", "index.js");
    const logPath = path.join(CONFIG_DIR, "client.log");

    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run """${nodeBin}"" """${clientScript}""" --connect --server "${RELAY_SERVER}" --token "${deviceToken}""", 0, False`,
      'Set WshShell = Nothing',
      '',
    ].join("\r\n");

    try {
      if (!fs.existsSync(startupDir)) {
        fs.mkdirSync(startupDir, { recursive: true });
      }
      fs.writeFileSync(vbsPath, vbsContent, "utf8");
      console.log(`✅ Windows 开机后台自启脚本已安装至 Startup 文件夹:`);
      console.log(`   ${vbsPath}`);

      // 立即在后台静默启动当前进程
      const outFd = fs.openSync(logPath, "a");
      const child = spawn(nodeBin, [clientScript, "--connect", "--server", RELAY_SERVER, "--token", deviceToken], {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", outFd, outFd],
        detached: true,
        shell: false,
        windowsHide: true,
      });
      child.unref();
      fs.closeSync(outFd);
      console.log(`✅ 后台守护服务已激活并启动！开机自动在后台连接云端网关。`);
    } catch (err) {
      console.warn("⚠️ 激活 Windows 自启提示:", err.message);
    }
  } else {
    console.log("ℹ️ 非 macOS/Windows 系统，请使用 'npm run connect' 在后台运行客户端。");
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
    author: {
      name: "temiylin",
    },
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
    if (isWin) {
      const psCmd = `Compress-Archive -Path '${tempPackDir}\\*' -DestinationPath '${desktopZip}' -Force`;
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: "pipe" });
    } else {
      execSync(`cd "${tempPackDir}" && zip -r "${desktopZip}" .`, { stdio: "pipe" });
    }
    console.log(`✅ 专属插件包已生成在桌面: \x1b[36m\x1b[1m${desktopZip}\x1b[0m\n`);
  } catch (err) {
    console.warn("⚠️ 打包 zip 提示:", err.message);
  }

  const deviceUrl = `${RELAY_HTTP}/${deviceToken}`;
  const localPort = process.env.AGENT_BRIDGE_PORT || process.env.PORT || 38080;
  const localDashboardUrl = `http://localhost:${localPort}`;

  console.log("===============================================================");
  console.log("🎉 全部部署大功告成！已为当前设备生成专属配置：");
  console.log("===============================================================");
  console.log(`🔑 本机专属识别码:   \x1b[32m\x1b[1m${deviceToken}\x1b[0m`);
  console.log(`📡 本机专属 MCP 地址: \x1b[36m\x1b[1m${deviceUrl}\x1b[0m`);
  console.log(`🖥️ 本地配置网页端:   \x1b[35m\x1b[1m${localDashboardUrl}\x1b[0m (可视化自定义 Agent 调度与场景规则)`);
  console.log(`📦 本机专属插件包:   \x1b[33m\x1b[1m${desktopZip}\x1b[0m`);
  console.log("---------------------------------------------------------------");
  console.log("1️⃣  【在本地配置网页端中 (可视化调节)】:");
  console.log(`    打开浏览器访问: \x1b[35m\x1b[1m${localDashboardUrl}\x1b[0m`);
  console.log("    可由您自主设置本地 Agent 调度规则与说明（默认留空，全由您自定义）。");
  console.log();
  console.log("2️⃣  【在本地 AI 客户端 (Codex / Antigravity AGY) 中】:");
  console.log("    直接在 Codex 或 AGY 对话窗口提问，即可自动调用本地工具！无需任何多余操作。");
  console.log();
  console.log("3️⃣  【在云端 ChatGPT 普通聊天窗口中】(任选一种方式):");
  console.log("    方式 A (最推荐 - 一键免配置):");
  console.log("      打开 ChatGPT -> 设置 -> Connectors/MCP -> 点击左下角「上传插件压缩包」");
  console.log("      选择桌面上的「agent-bridge-plugin.zip」即可！");
  console.log();
  console.log("    方式 B (手动输入 URL):");
  console.log(`      MCP 服务器 URL 填入: ${deviceUrl}`);
  console.log("      身份验证选择: 无 (None)");
  console.log("===============================================================\n");
}

main().catch((err) => {
  console.error("部署失败:", err);
  process.exit(1);
});
