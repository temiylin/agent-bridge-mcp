#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const dataRoot = process.env.AGENT_BRIDGE_ROOT
  ? path.resolve(process.env.AGENT_BRIDGE_ROOT)
  : path.join(os.homedir(), "agent-bridge");

const logsDir = path.join(dataRoot, "logs");
const pidFile = path.join(logsDir, "worker.pid");
const stdoutLogFile = path.join(logsDir, "worker-stdout.log");
const workerJsPath = path.join(projectRoot, "dist", "worker.js");
const indexJsPath = path.join(projectRoot, "dist", "index.js");

function getClaudeConfigPath() {
  if (process.env.CLAUDE_CONFIG_PATH) {
    return path.resolve(process.env.CLAUDE_CONFIG_PATH);
  }
  // win32 (未实测): 使用 %APPDATA%\Claude\claude_desktop_config.json
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

function isPidAlive(pid) {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function getStoredPid() {
  if (!fs.existsSync(pidFile)) return null;
  try {
    const content = fs.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
    cp.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command '${cmd} ${args.join(" ")}' failed with exit code ${code}`));
    });
    cp.on("error", reject);
  });
}

function areConfigsEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function handleSetup(isDryRun) {
  console.log("=================================================");
  console.log("  agent-bridge-mcp Cross-Platform Setup");
  console.log("=================================================");
  if (isDryRun) {
    console.log("[DRY-RUN MODE] Previewing changes only. No files will be written.\n");
  }

  // 9a. Check node version >= 18
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 18) {
    console.error(`Error: Node.js version 18 or higher is required. Current version: ${process.version}`);
    process.exit(1);
  }
  console.log(`[1/6] Node.js version check passed: ${process.version} (>= 18.0.0)`);

  // 9b. npm install & npm run build in projectRoot
  // win32 (未实测): Windows 上使用 npm.cmd
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  if (isDryRun) {
    console.log(`[2/6] [dry-run] Would execute: ${npmCmd} install && ${npmCmd} run build in ${projectRoot}`);
  } else {
    console.log(`[2/6] Building project in ${projectRoot}...`);
    await runCommand(npmCmd, ["install"], projectRoot);
    await runCommand(npmCmd, ["run", "build"], projectRoot);
    console.log("Build completed successfully.");
  }

  // 9c. Create tasks, results, logs, workdir
  const subdirs = ["tasks", "results", "logs", "workdir"];
  if (isDryRun) {
    console.log(`[3/6] [dry-run] Would ensure directories in data root (${dataRoot}): ${subdirs.join(", ")}`);
  } else {
    for (const sub of subdirs) {
      const dirPath = path.join(dataRoot, sub);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`Created directory: ${dirPath}`);
      } else {
        console.log(`Directory already exists: ${dirPath}`);
      }
    }
  }

  // 9d. agents.json template
  const agentsJsonPath = path.join(dataRoot, "agents.json");
  const defaultAgents = {
    codex: {
      command: "codex",
      args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"],
      input: "stdin",
    },
  };

  if (fs.existsSync(agentsJsonPath)) {
    console.log(`[4/6] agents.json already exists at ${agentsJsonPath} (preserved, not overwritten).`);
  } else {
    if (isDryRun) {
      console.log(`[4/6] [dry-run] Would create template ${agentsJsonPath} with codex configuration`);
    } else {
      fs.writeFileSync(agentsJsonPath, JSON.stringify(defaultAgents, null, 2), "utf8");
      console.log(`[4/6] Created agents template at ${agentsJsonPath}`);
    }
  }

  // 9e. Detect codex in PATH
  // win32 (未实测): Windows 上使用 where，darwin/linux 使用 which
  const lookupCmd = process.platform === "win32" ? "where" : "which";
  try {
    const lookupRes = spawnSync(lookupCmd, ["codex"], { shell: false });
    if (lookupRes.status === 0) {
      const codexPath = lookupRes.stdout.toString("utf8").trim().split(/\r?\n/)[0];
      console.log(`[5/6] Detected 'codex' in PATH: ${codexPath}`);
    } else {
      console.log("[5/6] Notice: 'codex' command not found in system PATH.");
      console.log("      Please install Codex CLI and ensure it is available in PATH when using codex agents.");
    }
  } catch (err) {
    console.log(`[5/6] Notice: Could not check PATH for codex (${err?.message || String(err)})`);
  }

  // 9f. Merge Claude Desktop configuration
  const configPath = getClaudeConfigPath();
  const targetBridgeConfig = {
    command: process.execPath,
    args: [indexJsPath],
    env: {
      AGENT_BRIDGE_ROOT: dataRoot,
    },
  };

  console.log(`[6/6] Checking Claude Desktop configuration at: ${configPath}`);
  if (!fs.existsSync(configPath)) {
    console.log(`Notice: Claude Desktop configuration file does not exist at: ${configPath}`);
    console.log("        Please launch Claude Desktop once to initialize its configuration, then re-run setup.");
  } else {
    let rawContent;
    let configObj;
    try {
      rawContent = fs.readFileSync(configPath, "utf8");
      configObj = JSON.parse(rawContent);
    } catch (err) {
      console.error(`Error: Failed to parse Claude Desktop configuration at ${configPath}: ${err.message}`);
      process.exit(1);
    }

    if (
      configObj.mcpServers &&
      configObj.mcpServers["agent-bridge"] &&
      areConfigsEqual(configObj.mcpServers["agent-bridge"], targetBridgeConfig)
    ) {
      console.log("Claude Desktop configuration: already configured (no changes needed).");
    } else {
      if (isDryRun) {
        console.log("[dry-run] Would backup and update Claude Desktop configuration:");
        console.log(`[dry-run] Target file: ${configPath}`);
        console.log(`[dry-run] Backup destination: ${configPath}.bak-<timestamp>`);
        console.log("[dry-run] Would set mcpServers['agent-bridge'] to:\n" + JSON.stringify(targetBridgeConfig, null, 2));
      } else {
        const timestamp = Date.now();
        const backupPath = `${configPath}.bak-${timestamp}`;
        fs.writeFileSync(backupPath, rawContent, "utf8");
        console.log(`Created backup of Claude config: ${backupPath}`);

        configObj.mcpServers = configObj.mcpServers || {};
        configObj.mcpServers["agent-bridge"] = targetBridgeConfig;

        fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2), "utf8");
        console.log("Updated Claude Desktop configuration successfully.");
      }
    }
  }

  // 9g. Output next steps
  console.log("\n-------------------------------------------------");
  console.log("Setup completed successfully!");
  console.log("Next steps:");
  console.log("1. Start the worker service:");
  console.log("   node scripts/setup.mjs start");
  console.log("2. Restart Claude Desktop completely to load the agent-bridge MCP server.");
  console.log("3. Note: The worker runs in background as requested and does NOT configure auto-start on boot (开机自启).");
  console.log("-------------------------------------------------");
}

async function handleStart() {
  const existingPid = getStoredPid();
  if (existingPid && isPidAlive(existingPid)) {
    console.log(`already running (PID ${existingPid})`);
    process.exit(0);
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const workdir = path.join(dataRoot, "workdir");
  fs.mkdirSync(workdir, { recursive: true });

  if (!fs.existsSync(workerJsPath)) {
    console.error(`Error: worker script not found at ${workerJsPath}. Please run setup or build first.`);
    process.exit(1);
  }

  const outFd = fs.openSync(stdoutLogFile, "a");

  const child = spawn(process.execPath, [workerJsPath], {
    cwd: workdir,
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: dataRoot,
    },
    stdio: ["ignore", outFd, outFd],
    detached: true,
    shell: false,
    windowsHide: true,
  });

  const pid = child.pid;
  fs.writeFileSync(pidFile, String(pid), "utf8");
  child.unref();
  fs.closeSync(outFd);

  // Wait 2 seconds to confirm process is running
  await new Promise((r) => setTimeout(r, 2000));

  if (isPidAlive(pid)) {
    console.log(`started (PID ${pid})`);
    process.exit(0);
  } else {
    console.error(`Error: worker process failed to start or exited immediately.`);
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    process.exit(1);
  }
}

async function handleStop() {
  const pid = getStoredPid();
  if (!pid || !isPidAlive(pid)) {
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    console.log("not running");
    process.exit(0);
  }

  // win32 (未实测): Windows 上使用 taskkill /T /PID pid（不加 /F）
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/PID", String(pid)], { shell: false, windowsHide: true });
    } catch (err) {
      console.warn(`Warning: taskkill invocation failed: ${err?.message || String(err)}`);
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if (err.code !== "ESRCH") {
        console.warn(`Warning: sending SIGTERM failed: ${err.message}`);
      }
    }
  }

  let waited = 0;
  while (isPidAlive(pid) && waited < 15) {
    await new Promise((r) => setTimeout(r, 1000));
    waited++;
  }

  if (isPidAlive(pid)) {
    console.warn(`Warning: worker (PID ${pid}) did not exit within 15 seconds.`);
    process.exit(1);
  } else {
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    console.log(`stopped (PID ${pid})`);
    process.exit(0);
  }
}

async function handleStatus() {
  const pid = getStoredPid();
  if (pid && isPidAlive(pid)) {
    console.log(`running (PID ${pid})`);
    process.exit(0);
  } else {
    console.log("not running");
    process.exit(1);
  }
}

function printUsageAndExit() {
  console.log("Usage: node scripts/setup.mjs <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  setup [--dry-run]  Build project, create directories, configure Claude Desktop");
  console.log("  start              Start worker in background");
  console.log("  stop               Stop running worker gracefully");
  console.log("  status             Show worker running status");
  console.log("");
  console.log("Options:");
  console.log("  --dry-run          Preview setup changes without modifying files (setup only)");
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsageAndExit();
  }

  const cmd = args[0];
  const subArgs = args.slice(1);

  switch (cmd) {
    case "setup": {
      const isDryRun = subArgs.includes("--dry-run");
      const invalidArgs = subArgs.filter((a) => a !== "--dry-run");
      if (invalidArgs.length > 0) {
        printUsageAndExit();
      }
      await handleSetup(isDryRun);
      break;
    }
    case "start": {
      if (subArgs.length > 0) printUsageAndExit();
      await handleStart();
      break;
    }
    case "stop": {
      if (subArgs.length > 0) printUsageAndExit();
      await handleStop();
      break;
    }
    case "status": {
      if (subArgs.length > 0) printUsageAndExit();
      await handleStatus();
      break;
    }
    default:
      printUsageAndExit();
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err?.message || String(err)}`);
  process.exit(1);
});
