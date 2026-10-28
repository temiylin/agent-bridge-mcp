#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { resolveBridgeRoot, ensureBridgeDirectories } from "./config.js";
import { isValidTaskId } from "./validator.js";
import { loadAgentRegistry, AgentRegistry, AgentConfig } from "./agents.js";

// Configuration from environment variables
const rootDir = resolveBridgeRoot();
const pollIntervalMs = parseInt(process.env.AGENT_BRIDGE_POLL_MS || "3000", 10);
const taskTimeoutMs = parseInt(process.env.AGENT_BRIDGE_TIMEOUT_MS || "1800000", 10);

const { tasksDir, resultsDir, logsDir } = ensureBridgeDirectories(rootDir);
const workerLogFile = path.join(logsDir, "worker.log");
const processedFilePath = path.join(logsDir, "processed.json");

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
export function parseTaskFile(content: string): { agentName: string; prompt: string } {
  const agentMatch = content.match(/^-[ \t]*\*\*Agent\*\*:[ \t]*([^\r\n]*)$/m);
  const agentName = agentMatch ? agentMatch[1].trim() : "";

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

  return { agentName, prompt };
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
  stderr: string
): string {
  const finalResultPath = path.join(resultsDir, `${taskId}.md`);
  const tmpResultPath = path.join(resultsDir, `${taskId}.md.tmp`);

  let content = `# Execution Result for ${taskId}

- **Status**: ${status}
- **Agent**: ${agentName || "(none)"}
- **Started At**: ${startedAt}
- **Finished At**: ${finishedAt}
- **Exit Code**: ${exitCode !== null ? exitCode : "(none)"}

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
  timeoutMs: number = taskTimeoutMs
): Promise<boolean> {
  // Rule 1: Only *.md files
  if (!taskFileName.endsWith(".md")) {
    return false;
  }

  const taskId = taskFileName.slice(0, -3);

  // Rule 2: Whitelist validation
  if (!isValidTaskId(taskId)) {
    logWorker("WARN", `Skipping invalid task filename: "${taskFileName}" (failed task_id whitelist check)`);
    return false;
  }

  // Rule 3: Skip already processed tasks
  if (taskId in processedMap) {
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
  const { agentName, prompt } = parseTaskFile(fileContent);

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
    saveProcessedTask(processedMap, taskId, finishedAt);
    logWorker("ERROR", `Task ${taskId} failed: agents.json not found`);
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
    saveProcessedTask(processedMap, taskId, finishedAt);
    logWorker("WARN", `Task ${taskId} failed: ${errorMsg}`);
    return true;
  }

  // Execute agent command
  const agentConfig: AgentConfig = registry[agentName];
  const command = agentConfig.command;
  const args = [...agentConfig.args];

  if (agentConfig.input === "arg") {
    args.push(prompt);
  }

  let stdoutData = "";
  let stderrData = "";
  let child: ChildProcess | null = null;
  let isTimeout = false;
  let exitCode: number | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      try {
        child = spawn(command, args, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (spawnErr: any) {
        return reject(spawnErr);
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          isTimeout = true;
          logWorker("WARN", `Task ${taskId} timed out after ${timeoutMs}ms. Killing child process.`);
          if (child && !child.killed) {
            child.kill("SIGTERM");
            setTimeout(() => {
              if (child && !child.killed) {
                child.kill("SIGKILL");
              }
            }, 2000);
          }
        }, timeoutMs);
      }

      if (agentConfig.input === "stdin" && child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      child.stdout?.on("data", (chunk) => {
        stdoutData += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk) => {
        stderrData += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        exitCode = code;
        resolve();
      });
    });
  } catch (err: any) {
    stderrData += `\nExecution error: ${err?.message || String(err)}`;
    if (exitCode === null) exitCode = 1;
  }

  const finishedAt = new Date().toISOString();
  let status = "completed";

  if (isTimeout) {
    status = "failed (timeout)";
  } else if (exitCode !== 0) {
    status = "failed";
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
    stderrData
  );

  saveProcessedTask(processedMap, taskId, finishedAt);
  logWorker("INFO", `Task ${taskId} finished with status "${status}" (exitCode=${exitCode})`);
  return true;
}

// Worker service loop
export class WorkerService {
  private isRunning = false;
  private isShuttingDown = false;
  private currentPromise: Promise<void> | null = null;
  private processedMap: Record<string, string>;

  constructor(
    private root: string = rootDir,
    private pollInterval: number = pollIntervalMs,
    private timeout: number = taskTimeoutMs
  ) {
    this.processedMap = loadProcessedTasks();
  }

  public async scanOnce(): Promise<number> {
    let registry: AgentRegistry | null = null;
    try {
      registry = loadAgentRegistry(this.root);
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
          this.timeout
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

    while (this.isRunning && !this.isShuttingDown) {
      await this.scanOnce();
      if (!this.isRunning || this.isShuttingDown) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }

    logWorker("INFO", "Worker loop exited cleanly.");
  }

  public stop(): void {
    this.isShuttingDown = true;
    this.isRunning = false;
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

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    logWorker("ERROR", `Fatal worker error: ${err?.message || String(err)}`);
    process.exit(1);
  });
}
