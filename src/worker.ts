#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBridgeRoot, ensureBridgeDirectories } from "./config.js";
import { isValidTaskId } from "./validator.js";
import { loadAgents, AgentRegistry, AgentConfig } from "./agents.js";
import { writeStatus } from "./status.js";
import { audit } from "./audit.js";

// Configuration from environment variables
const rootDir = resolveBridgeRoot();
const pollIntervalMs = parseInt(process.env.AGENT_BRIDGE_POLL_MS || "3000", 10);
const taskTimeoutMs = parseInt(process.env.AGENT_BRIDGE_TIMEOUT_MS || "1800000", 10);

const { tasksDir, resultsDir, logsDir } = ensureBridgeDirectories(rootDir);
const workerLogFile = path.join(logsDir, "worker.log");
const processedFilePath = path.join(logsDir, "processed.json");

// Track warned invalid filenames to avoid repetitive logging in the polling loop
const warnedInvalidFiles = new Set<string>();

// Logger utility
export function logWorker(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(workerLogFile, formatted, "utf8");
  } catch {
    // Ignore logging failure to disk
  }
  process.stderr.write(formatted);
}

/**
 * Constructs the argument array for osascript notification.
 */
export function buildNotifyArgs(title: string, message: string): string[] {
  return [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    message,
    title,
  ];
}

/**
 * Sends a native macOS desktop notification using osascript.
 * Skipped on win32/linux or if AGENT_BRIDGE_NOTIFY === "0".
 */
export function notify(title: string, message: string): void {
  if (process.platform !== "darwin") {
    logWorker("INFO", `Notification skipped on platform ${process.platform}: [${title}] ${message}`);
    return;
  }

  if (process.env.AGENT_BRIDGE_NOTIFY === "0") {
    logWorker("INFO", `Notification disabled by AGENT_BRIDGE_NOTIFY=0: [${title}] ${message}`);
    return;
  }

  try {
    const args = buildNotifyArgs(title, message);
    const child = spawn("osascript", args, { shell: false });

    child.on("error", (err) => {
      logWorker("WARN", `Notification failed to spawn osascript: ${err.message}`);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        logWorker("WARN", `osascript exited with code ${code}`);
      } else {
        logWorker("INFO", `Notification sent successfully: [${title}] ${message}`);
      }
    });
  } catch (err: any) {
    logWorker("WARN", `Notification error: ${err?.message || String(err)}`);
  }
}

// Processed tasks tracker
function loadProcessedTasks(): Record<string, string> {
  if (fs.existsSync(processedFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(processedFilePath, "utf8"));
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        return data as Record<string, string>;
      }
    } catch (e: any) {
      logWorker("WARN", `Failed to parse processed.json: ${e?.message || String(e)}`);
    }
  }
  return {};
}

function saveProcessedTask(processedMap: Record<string, string>, taskId: string, finishedAt: string): void {
  processedMap[taskId] = finishedAt;
  try {
    fs.writeFileSync(processedFilePath, JSON.stringify(processedMap, null, 2), "utf8");
  } catch (e: any) {
    logWorker("ERROR", `Failed to save processed.json: ${e?.message || String(e)}`);
  }
}

// Task file parser
export function parseTaskFile(content: string): {
  agentName: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  continueSession?: boolean;
  sessionId?: string;
} {
  const agentMatch = content.match(/^-[ \t]*\*\*Agent\*\*:[ \t]*([^\r\n]*)$/m);
  const agentName = agentMatch ? agentMatch[1].trim() : "";

  const modelMatch = content.match(/^-[ \t]*\*\*Model\*\*:[ \t]*([^\r\n]*)$/m);
  const model = modelMatch ? modelMatch[1].trim() : "";

  const effortMatch = content.match(/^-[ \t]*\*\*Reasoning Effort\*\*:[ \t]*([^\r\n]*)$/m);
  const reasoningEffort = effortMatch ? effortMatch[1].trim() : "";

  const continueMatch = content.match(/^-[ \t]*\*\*Continue Session\*\*:[ \t]*([^\r\n]*)$/m);
  const continueSession = continueMatch ? continueMatch[1].trim().toLowerCase() === "true" : false;

  const sessionMatch = content.match(/^-[ \t]*\*\*Session ID\*\*:[ \t]*([^\r\n]*)$/m);
  const sessionId = sessionMatch ? sessionMatch[1].trim() : "";

  const promptHeaderIdx = content.indexOf("## Prompt");
  let prompt = "";
  if (promptHeaderIdx !== -1) {
    prompt = content.slice(promptHeaderIdx + "## Prompt".length).replace(/^[\r\n]+/, "");
  } else {
    const dividerIdx = content.indexOf("---");
    if (dividerIdx !== -1) {
      prompt = content.slice(dividerIdx + 3).trim();
    } else {
      prompt = content.trim();
    }
  }

  return {
    agentName,
    prompt,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(continueSession ? { continueSession: true } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

// Atomic result writer
export function writeResultFile(
  resultsDir: string,
  taskId: string,
  status: string,
  agentName: string,
  startedAt: string,
  finishedAt: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  model?: string,
  reasoningEffort?: string
): string {
  const finalResultPath = path.join(resultsDir, `${taskId}.md`);
  const tmpResultPath = path.join(resultsDir, `${taskId}.md.tmp`);

  let metaLines = `- **Status**: ${status}\n- **Agent**: ${agentName || "(none)"}\n`;
  if (model) metaLines += `- **Model**: ${model}\n`;
  if (reasoningEffort) metaLines += `- **Reasoning Effort**: ${reasoningEffort}\n`;
  metaLines += `- **Started At**: ${startedAt}\n- **Finished At**: ${finishedAt}\n- **Exit Code**: ${exitCode !== null ? exitCode : "(none)"}\n`;

  let content = `# Execution Result for ${taskId}

${metaLines}
## Output

${stdout}
`;

  if (status.startsWith("failed")) {
    const truncatedStderr = stderr.slice(0, 4000);
    content += `\n## Error Details\n\n${truncatedStderr || "(no stderr output)"}\n`;
  }

  // Write to .tmp first, then rename atomically
  fs.writeFileSync(tmpResultPath, content, "utf8");
  fs.renameSync(tmpResultPath, finalResultPath);

  return finalResultPath;
}

// Process a single task file
export async function processTaskFile(
  taskFileName: string,
  tasksDir: string,
  resultsDir: string,
  processedMap: Record<string, string>,
  registry: AgentRegistry | null,
  timeoutMs: number = taskTimeoutMs,
  rootDirParam: string = path.dirname(tasksDir)
): Promise<boolean> {
  const currentRoot = rootDirParam;
  // Rule 1: Only *.md files
  if (!taskFileName.endsWith(".md")) {
    return false;
  }

  const taskId = taskFileName.slice(0, -3);

  // Rule 2: Whitelist validation
  if (!isValidTaskId(taskId)) {
    if (!warnedInvalidFiles.has(taskFileName)) {
      warnedInvalidFiles.add(taskFileName);
      logWorker("WARN", `Skipping invalid task file: "${taskFileName}" (failed task_id whitelist check)`);
    }
    return false;
  }

  // Rule 3: Anti-duplicate check (Defense 1: processed.json record, Defense 2: existing result file)
  if (taskId in processedMap) {
    return false;
  }

  const finalResultPath = path.join(resultsDir, `${taskId}.md`);
  if (fs.existsSync(finalResultPath)) {
    try {
      processedMap[taskId] = fs.statSync(finalResultPath).mtime.toISOString();
    } catch {
      processedMap[taskId] = new Date().toISOString();
    }
    return false;
  }

  const taskFilePath = path.join(tasksDir, taskFileName);
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(taskFilePath, "utf8");
  } catch (err: any) {
    logWorker("ERROR", `Failed to read task file "${taskFilePath}": ${err?.message || String(err)}`);
    return false;
  }

  const startedAt = new Date().toISOString();
  const { agentName, prompt, model, reasoningEffort, continueSession, sessionId } = parseTaskFile(fileContent);

  // Check cancellation before start
  const controlDir = path.join(currentRoot, "control");
  const cancelFilePath = path.join(controlDir, `${taskId}.cancel`);
  if (fs.existsSync(cancelFilePath)) {
    try {
      fs.unlinkSync(cancelFilePath);
    } catch {}
    const finishedAt = new Date().toISOString();
    writeResultFile(
      resultsDir,
      taskId,
      "cancelled (cancelled by request)",
      agentName,
      startedAt,
      finishedAt,
      1,
      "",
      "Task was cancelled by request before execution started."
    );
    writeStatus(currentRoot, taskId, {
      state: "cancelled",
      agent: agentName,
      startedAt,
      finishedAt,
      exitCode: 1,
      reason: "cancelled by request",
    });
    saveProcessedTask(processedMap, taskId, finishedAt);
    audit(currentRoot, { tool: "worker", taskId, agent: agentName, state: "cancelled", exitCode: 1 });
    logWorker("INFO", `Task ${taskId} cancelled before start by request`);
    notify("agent-bridge", `Task ${taskId} cancelled (cancelled by request) [${agentName || "(none)"}]`);
    return true;
  }

  logWorker("INFO", `Processing task: taskId=${taskId}, agent="${agentName}"`);

  // Rule 4: If agents.json missing or agent not registered, mark failed without executing command
  if (!registry) {
    const finishedAt = new Date().toISOString();
    writeResultFile(
      resultsDir,
      taskId,
      "failed (agents.json not found)",
      agentName,
      startedAt,
      finishedAt,
      1,
      "",
      "agents.json does not exist. Worker refused execution."
    );
    writeStatus(currentRoot, taskId, {
      state: "failed",
      agent: agentName,
      startedAt,
      finishedAt,
      exitCode: 1,
      reason: "agents.json not found",
    });
    saveProcessedTask(processedMap, taskId, finishedAt);
    audit(currentRoot, { tool: "worker", taskId, agent: agentName, state: "failed", exitCode: 1 });
    logWorker("ERROR", `Task ${taskId} failed: agents.json not found`);
    notify("agent-bridge", `Task ${taskId} failed [${agentName || "(none)"}]`);
    return true;
  }

  if (!agentName || !(agentName in registry)) {
    const finishedAt = new Date().toISOString();
    const available = Object.keys(registry).join(", ") || "(none)";
    const errorMsg = !agentName
      ? `Task missing required Agent field. Available agents: [${available}]`
      : `Agent "${agentName}" not registered in agents.json. Available agents: [${available}]`;

    writeResultFile(
      resultsDir,
      taskId,
      "failed (agent not registered)",
      agentName,
      startedAt,
      finishedAt,
      1,
      "",
      errorMsg
    );
    writeStatus(currentRoot, taskId, {
      state: "failed",
      agent: agentName,
      startedAt,
      finishedAt,
      exitCode: 1,
      reason: !agentName ? "missing agent" : "agent not registered",
    });
    saveProcessedTask(processedMap, taskId, finishedAt);
    audit(currentRoot, { tool: "worker", taskId, agent: agentName, state: "failed", exitCode: 1 });
    logWorker("WARN", `Task ${taskId} failed: ${errorMsg}`);
    notify("agent-bridge", `Task ${taskId} failed [${agentName || "(none)"}]`);
    return true;
  }

  // Write running status and audit as execution begins
  writeStatus(currentRoot, taskId, {
    state: "running",
    agent: agentName,
    model,
    reasoningEffort,
    startedAt,
  });
  audit(currentRoot, { tool: "worker", taskId, agent: agentName, state: "running" });

  // Execute agent command
  const agentConfig: AgentConfig = registry[agentName];
  const command = agentConfig.command;
  const args = [...agentConfig.args];

  // Dynamically handle session resumption / continuation
  if (continueSession || sessionId) {
    if (command.includes("codex") || agentName === "codex") {
      const execIdx = args.indexOf("exec");
      if (execIdx !== -1) {
        if (sessionId) {
          args.splice(execIdx + 1, 0, "resume", sessionId);
        } else {
          args.splice(execIdx + 1, 0, "resume", "--last");
        }
      } else {
        if (sessionId) {
          args.unshift("resume", sessionId);
        } else {
          args.unshift("resume", "--last");
        }
      }
    } else if (command.includes("agy") || agentName === "agy") {
      if (sessionId) {
        args.push("--conversation", sessionId);
      } else {
        args.push("--continue");
      }
    }
  }

  // Dynamically inject model parameter if specified
  if (model) {
    if (command.includes("codex") || agentName === "codex") {
      args.push("-m", model);
    } else if (command.includes("agy") || agentName === "agy") {
      args.push("--model", model);
    } else {
      args.push("--model", model);
    }
  }

  // Dynamically inject reasoning effort if specified
  if (reasoningEffort) {
    if (command.includes("codex") || agentName === "codex") {
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    } else if (command.includes("agy") || agentName === "agy") {
      args.push("--effort", reasoningEffort);
    }
  }

  if (agentConfig.input === "arg") {
    args.push(prompt);
  }

  let stdoutData = "";
  let stderrData = "";
  let child: ChildProcess | null = null;
  let isTimeout = false;
  let isCancelled = false;
  let exitCode: number | null = null;

  // Prepare incremental stdout file in logs/<task_id>.out
  const taskLogsDir = path.join(currentRoot, "logs");
  const taskOutFilePath = path.join(taskLogsDir, `${taskId}.out`);
  try {
    if (!fs.existsSync(taskLogsDir)) fs.mkdirSync(taskLogsDir, { recursive: true });
    fs.writeFileSync(taskOutFilePath, "", "utf8");
  } catch {}

  try {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let cancelCheckInterval: NodeJS.Timeout | null = null;

      const isWin = process.platform === "win32";
      const killChild = (sig: "SIGTERM" | "SIGKILL") => {
        const activeChild = child as ChildProcess | null;
        if (activeChild && activeChild.pid !== undefined && activeChild.exitCode === null && activeChild.signalCode === null) {
          if (isWin) {
            try {
              const killArgs = ["/T", "/PID", String(activeChild.pid)];
              if (sig === "SIGKILL") killArgs.push("/F");
              spawnSync("taskkill", killArgs, { shell: false, windowsHide: true });
            } catch {}
          } else {
            try {
              activeChild.kill(sig);
            } catch {}
          }
        }
      };

      try {
        const pathSep = isWin ? ";" : ":";
        const extraPaths = isWin
          ? [
              path.join(process.env.APPDATA || "", "npm"),
              path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
              path.join(os.homedir(), ".cargo", "bin"),
            ].filter((p) => p && fs.existsSync(p))
          : [
              "/opt/homebrew/bin",
              "/usr/local/bin",
              path.join(os.homedir(), ".local", "bin"),
              path.join(os.homedir(), ".cargo", "bin"),
            ].filter((p) => fs.existsSync(p));

        const currentPath = process.env.PATH || (isWin ? "" : "/usr/bin:/bin:/usr/sbin:/sbin");
        const combinedPath = Array.from(new Set([...extraPaths, ...currentPath.split(pathSep)].filter(Boolean))).join(pathSep);

        child = spawn(command, args, {
          shell: isWin,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PATH: combinedPath,
            HOME: process.env.HOME || os.homedir(),
          },
        });
      } catch (spawnErr: any) {
        return reject(spawnErr);
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          isTimeout = true;
          logWorker("WARN", `Task ${taskId} timed out after ${timeoutMs}ms. Sending SIGTERM to process.`);
          killChild("SIGTERM");
          killTimer = setTimeout(() => {
            logWorker("WARN", `Task ${taskId} process still running after 5s. Sending SIGKILL.`);
            killChild("SIGKILL");
          }, 5000);
        }, timeoutMs);
      }

      // Check for control/<taskId>.cancel every 1 second
      cancelCheckInterval = setInterval(() => {
        if (fs.existsSync(cancelFilePath)) {
          try {
            fs.unlinkSync(cancelFilePath);
          } catch {}
          isCancelled = true;
          logWorker("WARN", `Task ${taskId} cancellation requested. Sending SIGTERM to process.`);
          killChild("SIGTERM");
          killTimer = setTimeout(() => {
            logWorker("WARN", `Task ${taskId} process still running after 5s of cancellation. Sending SIGKILL.`);
            killChild("SIGKILL");
          }, 5000);
        }
      }, 1000);

      if (agentConfig.input === "stdin" && child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stdoutData += text;
        try {
          fs.appendFileSync(taskOutFilePath, text, "utf8");
        } catch {}
      });

      child.stderr?.on("data", (chunk) => {
        stderrData += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (cancelCheckInterval) clearInterval(cancelCheckInterval);
        reject(err);
      });

      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (cancelCheckInterval) clearInterval(cancelCheckInterval);
        exitCode = code !== null ? code : (signal ? 1 : 0);
        resolve();
      });
    });
  } catch (err: any) {
    stderrData += `\nExecution error: ${err?.message || String(err)}`;
    if (exitCode === null) exitCode = 1;
  }

  const finishedAt = new Date().toISOString();
  let status = "completed";
  let state: "completed" | "failed" | "cancelled" = "completed";
  let reason: string | undefined = undefined;

  if (isCancelled) {
    status = "cancelled (cancelled by request)";
    state = "cancelled";
    reason = "cancelled by request";
  } else if (isTimeout) {
    status = "failed (timeout)";
    state = "failed";
    reason = "timeout";
  } else if (exitCode !== 0) {
    status = "failed";
    state = "failed";
  }

  writeResultFile(
    resultsDir,
    taskId,
    status,
    agentName,
    startedAt,
    finishedAt,
    exitCode,
    stdoutData,
    stderrData,
    model,
    reasoningEffort
  );

  writeStatus(currentRoot, taskId, {
    state,
    agent: agentName,
    model,
    reasoningEffort,
    startedAt,
    finishedAt,
    exitCode,
    ...(reason ? { reason } : {}),
  });

  saveProcessedTask(processedMap, taskId, finishedAt);
  audit(currentRoot, { tool: "worker", taskId, agent: agentName, state, exitCode });
  logWorker("INFO", `Task ${taskId} finished with status "${status}" (exitCode=${exitCode})`);
  notify("agent-bridge", `Task ${taskId} ${status} [${agentName}]`);
  return true;
}

// Worker service loop
export class WorkerService {
  private isRunning = false;
  private isShuttingDown = false;
  private processedMap: Record<string, string>;
  private sleepResolve: (() => void) | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;

  constructor(
    private root: string = rootDir,
    private pollInterval: number = pollIntervalMs,
    private timeout: number = taskTimeoutMs
  ) {
    this.processedMap = loadProcessedTasks();
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepResolve = null;
        this.sleepTimer = null;
        resolve();
      }, ms);
    });
  }

  public async scanOnce(): Promise<number> {
    let registry: AgentRegistry | null = null;
    try {
      registry = loadAgents(this.root);
    } catch (err: any) {
      logWorker("WARN", `Could not load agent registry: ${err?.message || String(err)}`);
    }

    const { tasksDir, resultsDir } = ensureBridgeDirectories(this.root);
    let files: string[] = [];
    try {
      files = fs.readdirSync(tasksDir);
    } catch (e: any) {
      logWorker("ERROR", `Failed to read tasks directory "${tasksDir}": ${e?.message || String(e)}`);
      return 0;
    }

    let processedCount = 0;
    for (const file of files) {
      if (this.isShuttingDown) break;
      try {
        const handled = await processTaskFile(
          file,
          tasksDir,
          resultsDir,
          this.processedMap,
          registry,
          this.timeout,
          this.root
        );
        if (handled) processedCount++;
      } catch (err: any) {
        logWorker("ERROR", `Unexpected error handling task file "${file}": ${err?.message || String(err)}`);
      }
    }

    return processedCount;
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    logWorker("INFO", `Worker started. Root=${this.root}, PollInterval=${this.pollInterval}ms, Timeout=${this.timeout}ms`);

    // Record worker.pid for worker_alive_summary diagnostics
    const pidPath = path.join(this.root, "logs", "worker.pid");
    try {
      const logsDir = path.dirname(pidPath);
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(pidPath, String(process.pid), "utf8");
    } catch {}

    while (this.isRunning && !this.isShuttingDown) {
      await this.scanOnce();
      if (!this.isRunning || this.isShuttingDown) break;
      await this.interruptibleSleep(this.pollInterval);
    }

    logWorker("INFO", "Worker loop exited cleanly.");
  }

  public stop(): void {
    this.isShuttingDown = true;
    this.isRunning = false;

    // Clean up worker.pid if it matches current process
    const pidPath = path.join(this.root, "logs", "worker.pid");
    try {
      if (fs.existsSync(pidPath)) {
        const stored = fs.readFileSync(pidPath, "utf8").trim();
        if (stored === String(process.pid)) {
          fs.unlinkSync(pidPath);
        }
      }
    } catch {}

    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    if (this.sleepResolve) {
      this.sleepResolve();
      this.sleepResolve = null;
    }
  }
}

// CLI entrypoint
async function main() {
  const worker = new WorkerService();

  process.on("SIGINT", () => {
    logWorker("INFO", "Received SIGINT, shutting down worker gracefully...");
    worker.stop();
  });

  process.on("SIGTERM", () => {
    logWorker("INFO", "Received SIGTERM, shutting down worker gracefully...");
    worker.stop();
  });

  await worker.start();
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    const realArgv1 = fs.realpathSync(process.argv[1]);
    const realImportUrl = fs.realpathSync(fileURLToPath(import.meta.url));
    return realArgv1 === realImportUrl;
  } catch {
    return (
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      path.basename(process.argv[1]).includes("worker")
    );
  }
};

if (isMainModule()) {
  main().catch((err) => {
    logWorker("ERROR", `Fatal worker error: ${err?.message || String(err)}`);
    process.exit(1);
  });
}
