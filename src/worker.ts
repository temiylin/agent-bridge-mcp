#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBridgeRoot, ensureBridgeDirectories } from "./config.js";
import { isValidTaskId } from "./validator.js";
import { loadAgents, AgentRegistry, AgentConfig, agentSupportsEffort } from "./agents.js";
import {
  reconcileAllTasks,
  newestMtime,
  getStallThresholdMs,
  getDescendantPids,
  getProcessTreeCpuTime,
} from "./task-reconcile.js";
import { TaskSessionTracker } from "./session-tracker.js";
import { AgySdkStreamParser, capTailString, MAX_SDK_BUFFER_BYTES } from "./agy-sdk-stream.js";
import { writeStatus, readStatus } from "./status.js";
import { audit } from "./audit.js";
import { resolveSessionId, recordSession, extractSessionIdFromOutput } from "./sessions.js";
import { onTaskFinished, reconcileQueues, isConversationLaneBusy, conversationLaneKey } from "./queue-dispatcher.js";
import { triggerTaskWebhook } from "./webhook.js";
import { classifyAgentFailure, isLoginInvalidError, parseQuotaResetTime, stashQuotaTask } from "./session-quota.js";
import {
  recordTaskStartUnderProfile,
  handlePoolQuotaPaused,
  markProfileNeedsRelogin,
} from "./account-pool.js";
import {
  acquireDualPoolAccount,
  releaseSelection,
  pauseEmail,
  type AccountSelection,
} from "./dual-pool.js";
import { extractExecutionSummary, extractGitLinks } from "./redaction.js";
import { sendCompletionCallback, extractPrUrl } from "./callback.js";
import { setupGitWorktree } from "./worktree.js";
import { loadProjectsConfig, getProjectRepoPath } from "./project-router.js";
import {
  deriveStage,
  getTaskReportDir,
  buildReportJsonPromptInstruction,
  readOrFallbackTaskReport,
} from "./task-stage.js";
import {
  sendDesktopNotification,
  buildOsascriptNotifyArgs,
  NotificationLevel,
  NotificationChannel,
  dispatchTaskLifecycleNotification,
} from "./notifier.js";

// Configuration from environment variables
const rootDir = resolveBridgeRoot();
const pollIntervalMs = parseInt(process.env.AGENT_BRIDGE_POLL_MS || "3000", 10);
const taskTimeoutMs = parseInt(process.env.AGENT_BRIDGE_TIMEOUT_MS || "1800000", 10);
/** Minimum implicit hard-kill cap when send_task omits timeout_seconds (6 hours). */
export const HARD_KILL_SAFETY_CAP_MS = 6 * 60 * 60 * 1000;

export function resolveHardKillTimeoutMs(hardTimeoutSeconds: number | undefined, envTimeoutMs: number = taskTimeoutMs): number {
  if (hardTimeoutSeconds && hardTimeoutSeconds > 0) {
    return hardTimeoutSeconds * 1000;
  }
  return Math.max(envTimeoutMs, HARD_KILL_SAFETY_CAP_MS);
}

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
 * Backward compatible with legacy 2-argument signature.
 */
export function buildNotifyArgs(
  title: string,
  message: string,
  subtitle: string = "",
  soundName: string = ""
): string[] {
  return buildOsascriptNotifyArgs(title, message, subtitle, soundName);
}

/**
 * Sends a native desktop notification across platforms (macOS, Windows, Linux).
 * Skipped if AGENT_BRIDGE_NOTIFY === "0".
 */
export function notify(
  title: string,
  message: string,
  options?: {
    subtitle?: string;
    level?: NotificationLevel;
    sound?: boolean | string;
    channel?: NotificationChannel;
  }
): void {
  if (process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux") {
    logWorker("INFO", `Notification skipped on platform ${process.platform}: [${title}] ${message}`);
    return;
  }

  if (process.env.AGENT_BRIDGE_NOTIFY === "0") {
    logWorker("INFO", `Notification disabled by AGENT_BRIDGE_NOTIFY=0: [${title}] ${message}`);
    return;
  }

  try {
    const res = sendDesktopNotification({
      title,
      message,
      subtitle: options?.subtitle,
      level: options?.level || "info",
      sound: options?.sound !== undefined ? options?.sound : true,
      channel: options?.channel || "desktop",
    });

    if (res.disabled) {
      logWorker("INFO", `Notification disabled by AGENT_BRIDGE_NOTIFY=0: [${title}] ${message}`);
    } else if (res.success) {
      logWorker("INFO", `Notification sent successfully: [${title}] ${message}`);
    } else {
      logWorker("WARN", `Notification failed: [${title}] ${message} (${res.details || "unknown error"})`);
    }
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
  account?: string;
  notify?: boolean;
  notifyChannel?: NotificationChannel;
  notifySound?: boolean | string;
  notifyOn?: Set<string>;
  hardTimeoutSeconds?: number;
  notifyOverdueSeconds?: number;
  projectId?: string;
  projectName?: string;
  projectRepo?: string;
  projectDir?: string;
  slackChannel?: string;
  slackWebhookEnv?: string;
  callbackUrl?: string;
  callbackHeaders?: Record<string, string>;
  worktreeName?: string;
  worktreeBaseBranch?: string;
  onSuccess?: any;
} {
  const agentMatch = content.match(/^-[ \t]*\*\*Agent\*\*:[ \t]*([^\r\n]*)$/m);
  const agentName = agentMatch ? agentMatch[1].trim() : "";

  const projectIdMatch = content.match(/^-[ \t]*\*\*Project ID\*\*:[ \t]*([^\r\n]*)$/m);
  const projectId = projectIdMatch ? projectIdMatch[1].trim() : undefined;

  const projectNameMatch = content.match(/^-[ \t]*\*\*Project Name\*\*:[ \t]*([^\r\n]*)$/m);
  const projectName = projectNameMatch ? projectNameMatch[1].trim() : undefined;

  const projectRepoMatch = content.match(/^-[ \t]*\*\*Project Repo\*\*:[ \t]*([^\r\n]*)$/m);
  const projectRepo = projectRepoMatch ? projectRepoMatch[1].trim() : undefined;

  const projectDirMatch = content.match(/^-[ \t]*\*\*Project Dir\*\*:[ \t]*([^\r\n]*)$/m);
  const projectDir = projectDirMatch ? projectDirMatch[1].trim() : undefined;

  const slackChannelMatch = content.match(/^-[ \t]*\*\*Slack Channel\*\*:[ \t]*([^\r\n]*)$/m);
  const slackChannel = slackChannelMatch ? slackChannelMatch[1].trim() : undefined;

  const slackWebhookEnvMatch = content.match(/^-[ \t]*\*\*Slack Webhook Env\*\*:[ \t]*([^\r\n]*)$/m);
  const slackWebhookEnv = slackWebhookEnvMatch ? slackWebhookEnvMatch[1].trim() : undefined;

  const callbackUrlMatch = content.match(/^-[ \t]*\*\*Callback URL\*\*:[ \t]*([^\r\n]*)$/m);
  const callbackUrl = callbackUrlMatch ? callbackUrlMatch[1].trim() : undefined;

  const callbackHeadersMatch = content.match(/^-[ \t]*\*\*Callback Headers\*\*:[ \t]*([^\r\n]*)$/m);
  let callbackHeaders: Record<string, string> | undefined;
  if (callbackHeadersMatch) {
    try {
      callbackHeaders = JSON.parse(callbackHeadersMatch[1].trim());
    } catch {}
  }

  const worktreeNameMatch = content.match(/^-[ \t]*\*\*Worktree Name\*\*:[ \t]*([^\r\n]*)$/m);
  const worktreeName = worktreeNameMatch ? worktreeNameMatch[1].trim() : undefined;

  const worktreeBaseBranchMatch = content.match(/^-[ \t]*\*\*Worktree Base Branch\*\*:[ \t]*([^\r\n]*)$/m);
  const worktreeBaseBranch = worktreeBaseBranchMatch ? worktreeBaseBranchMatch[1].trim() : undefined;

  const onSuccessMatch = content.match(/^-[ \t]*\*\*On Success\*\*:[ \t]*([^\r\n]*)$/m);
  let onSuccess: any = undefined;
  if (onSuccessMatch) {
    try {
      onSuccess = JSON.parse(onSuccessMatch[1].trim());
    } catch {
      onSuccess = onSuccessMatch[1].trim();
    }
  }

  const modelMatch = content.match(/^-[ \t]*\*\*Model\*\*:[ \t]*([^\r\n]*)$/m);
  const model = modelMatch ? modelMatch[1].trim() : "";

  const effortMatch = content.match(/^-[ \t]*\*\*Reasoning Effort\*\*:[ \t]*([^\r\n]*)$/m);
  const reasoningEffort = effortMatch ? effortMatch[1].trim() : "";

  const continueMatch = content.match(/^-[ \t]*\*\*Continue Session\*\*:[ \t]*([^\r\n]*)$/m);
  const continueSession = continueMatch ? continueMatch[1].trim().toLowerCase() === "true" : false;

  const sessionMatch = content.match(/^-[ \t]*\*\*Session ID\*\*:[ \t]*([^\r\n]*)$/m);
  const sessionId = sessionMatch ? sessionMatch[1].trim() : "";

  const accountMatch = content.match(/^-[ \t]*\*\*Account\*\*:[ \t]*([^\r\n]*)$/m);
  const account = accountMatch ? accountMatch[1].trim() : undefined;

  const notifyMatch = content.match(/^-[ \t]*\*\*Notify\*\*:[ \t]*([^\r\n]*)$/m);
  const notify = notifyMatch ? notifyMatch[1].trim().toLowerCase() !== "false" : true;

  const notifyChannelMatch = content.match(/^-[ \t]*\*\*Notify Channel\*\*:[ \t]*([^\r\n]*)$/m);
  const notifyChannel = (notifyChannelMatch ? notifyChannelMatch[1].trim().toLowerCase() : "desktop") as NotificationChannel;

  const notifySoundMatch = content.match(/^-[ \t]*\*\*Notify Sound\*\*:[ \t]*([^\r\n]*)$/m);
  let notifySound: boolean | string = false;
  if (notifySoundMatch) {
    const rawSound = notifySoundMatch[1].trim();
    if (rawSound.toLowerCase() === "false") notifySound = false;
    else if (rawSound.toLowerCase() === "true") notifySound = true;
    else notifySound = rawSound;
  }

  const notifyOnMatch = content.match(/^-[ \t]*\*\*Notify On\*\*:[ \t]*([^\r\n]*)$/m);
  const notifyOn = notifyOnMatch
    ? new Set(notifyOnMatch[1].split(",").map((s) => s.trim().toLowerCase()))
    : new Set(["completed", "failed", "timeout", "stuck", "overdue"]);

  const hardTimeoutMatch = content.match(/^-[ \t]*\*\*Hard Timeout Seconds\*\*:[ \t]*([^\r\n]*)$/m);
  const hardTimeoutSeconds =
    hardTimeoutMatch && parseInt(hardTimeoutMatch[1], 10) > 0 ? parseInt(hardTimeoutMatch[1], 10) : undefined;

  const notifyOverdueMatch = content.match(/^-[ \t]*\*\*Notify Overdue Seconds\*\*:[ \t]*([^\r\n]*)$/m);
  let notifyOverdueSeconds =
    notifyOverdueMatch && parseInt(notifyOverdueMatch[1], 10) > 0 ? parseInt(notifyOverdueMatch[1], 10) : undefined;

  if (!notifyOverdueSeconds && !hardTimeoutSeconds) {
    const legacyTimeoutMatch = content.match(/^-[ \t]*\*\*Timeout(?: Seconds)?\*\*:[ \t]*([^\r\n]*)$/m);
    if (legacyTimeoutMatch && parseInt(legacyTimeoutMatch[1], 10) > 0) {
      notifyOverdueSeconds = parseInt(legacyTimeoutMatch[1], 10);
    }
  }

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
    account,
    notify,
    notifyChannel,
    notifySound,
    notifyOn,
    ...(hardTimeoutSeconds ? { hardTimeoutSeconds } : {}),
    ...(notifyOverdueSeconds ? { notifyOverdueSeconds } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(projectRepo ? { projectRepo } : {}),
    ...(projectDir ? { projectDir } : {}),
    ...(slackChannel ? { slackChannel } : {}),
    ...(slackWebhookEnv ? { slackWebhookEnv } : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
    ...(callbackHeaders ? { callbackHeaders } : {}),
    ...(worktreeName ? { worktreeName } : {}),
    ...(worktreeBaseBranch ? { worktreeBaseBranch } : {}),
    onSuccess,
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
  reasoningEffort?: string,
  sessionId?: string,
  accountUsed?: string
): string {
  const finalResultPath = path.join(resultsDir, `${taskId}.md`);
  const tmpResultPath = path.join(resultsDir, `${taskId}.md.tmp`);

  let metaLines = `- **Status**: ${status}\n- **Agent**: ${agentName || "(none)"}\n`;
  if (model) metaLines += `- **Model**: ${model}\n`;
  if (reasoningEffort) metaLines += `- **Reasoning Effort**: ${reasoningEffort}\n`;
  if (sessionId) metaLines += `- **Session ID**: ${sessionId}\n`;
  if (accountUsed) metaLines += `- **Account**: ${accountUsed}\n`;
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

  // Atomic task claim lock: prevents duplicate execution across multiple workers or processes
  const controlDir = path.join(currentRoot, "control");
  const lockFilePath = path.join(controlDir, `${taskId}.lock`);
  try {
    if (!fs.existsSync(controlDir)) {
      fs.mkdirSync(controlDir, { recursive: true });
    }
    // "wx" flag fails with EEXIST if another worker already claimed this task
    fs.writeFileSync(lockFilePath, String(process.pid), { flag: "wx" });
  } catch (lockErr: any) {
    if (lockErr?.code === "EEXIST") {
      return false;
    }
  }

  try {
    return await executeTaskFile(
      taskFileName,
      taskId,
      tasksDir,
      resultsDir,
      processedMap,
      registry,
      timeoutMs,
      currentRoot,
      controlDir
    );
  } finally {
    try {
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
      }
    } catch {}
  }
}

function agentConfigCommandIsAgy(registry: AgentRegistry | null, agentName: string): boolean {
  const cmd = registry?.[agentName]?.command || "";
  if (cmd) {
    const base = path.basename(cmd);
    if (base === "agy" || base.startsWith("agy.")) return true;
    return false;
  }
  return agentName === "agy" || agentName === "agy-sdk";
}

function isAgySdkStreamAgent(agentName: string, _command: string, args: string[]): boolean {
  if (agentName === "agy-sdk") return true;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--output-format" || args[i] === "-o") && args[i + 1] === "stream-json") return true;
    if (args[i] === "--output-format=stream-json") return true;
  }
  return false;
}

async function executeTaskFile(
  taskFileName: string,
  taskId: string,
  tasksDir: string,
  resultsDir: string,
  processedMap: Record<string, string>,
  registry: AgentRegistry | null,
  timeoutMs: number,
  currentRoot: string,
  controlDir: string
): Promise<boolean> {

  const taskFilePath = path.join(tasksDir, taskFileName);
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(taskFilePath, "utf8");
  } catch (err: any) {
    logWorker("ERROR", `Failed to read task file "${taskFilePath}": ${err?.message || String(err)}`);
    return false;
  }

  const startedAt = new Date().toISOString();

  // Clear any stale non-cancelled status file if the same taskId is being re-dispatched
  const existingStatusPath = path.join(currentRoot, "status", `${taskId}.json`);
  const cancelFilePathEarly = path.join(controlDir, `${taskId}.cancel`);
  if (fs.existsSync(existingStatusPath) && !fs.existsSync(cancelFilePathEarly)) {
    try {
      const prevSt = readStatus(currentRoot, taskId);
      if (prevSt && prevSt.state !== "cancelled" && prevSt.state !== "queued") {
        fs.unlinkSync(existingStatusPath);
      }
    } catch {}
  }
  const {
    agentName,
    prompt,
    model,
    reasoningEffort,
    continueSession,
    sessionId,
    notify: notifyOpt,
    notifyChannel,
    notifySound,
    notifyOn = new Set(["completed", "failed", "timeout", "stuck", "overdue"]),
    hardTimeoutSeconds,
    notifyOverdueSeconds,
    projectId,
    projectName,
    projectRepo,
    projectDir,
    slackChannel,
    slackWebhookEnv,
    callbackUrl,
    callbackHeaders,
    worktreeName,
    worktreeBaseBranch,
    onSuccess,
    account,
  } = parseTaskFile(fileContent);

  const effectiveHardTimeoutMs = resolveHardKillTimeoutMs(hardTimeoutSeconds, timeoutMs);
  const isNotifyEnabled = notifyOpt !== false && notifyChannel !== "none";

  // Check cancellation before start
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
    if (callbackUrl) {
      sendCompletionCallback({
        url: callbackUrl,
        headers: callbackHeaders,
        taskId,
        agent: agentName || "(none)",
        status: "cancelled",
        exitCode: 1,
        durationSeconds: 0,
        resultPath: path.join(resultsDir, `${taskId}.md`),
        logPath: path.join(logsDir, `${taskId}.out`),
        project: projectName || projectId,
        logger: logWorker,
      }).catch(() => {});
    }
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
    if (callbackUrl) {
      sendCompletionCallback({
        url: callbackUrl,
        headers: callbackHeaders,
        taskId,
        agent: agentName || "(none)",
        status: "failed",
        exitCode: 1,
        durationSeconds: 0,
        resultPath: path.join(resultsDir, `${taskId}.md`),
        logPath: path.join(logsDir, `${taskId}.out`),
        project: projectName || projectId,
        logger: logWorker,
      }).catch(() => {});
    }
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
    if (callbackUrl) {
      sendCompletionCallback({
        url: callbackUrl,
        headers: callbackHeaders,
        taskId,
        agent: agentName || "(none)",
        status: "failed",
        exitCode: 1,
        durationSeconds: 0,
        resultPath: path.join(resultsDir, `${taskId}.md`),
        logPath: path.join(logsDir, `${taskId}.out`),
        project: projectName || projectId,
        logger: logWorker,
      }).catch(() => {});
    }
    return true;
  }

  // 1. Task Started Lifecycle Notification (Slack only, desktop silent on start)
  let slackStartTs: string | undefined;
  if (isNotifyEnabled && (slackChannel || slackWebhookEnv)) {
    try {
      const notifyRes = await dispatchTaskLifecycleNotification(
        {
          taskId,
          event: "started",
          projectName,
          repo: projectRepo,
          slackChannel,
          slackWebhookEnv,
          agent: agentName,
          model,
          promptSummary: prompt,
          desktop: false,
        },
        logWorker
      );
      if (notifyRes && notifyRes.slackTs) {
        slackStartTs = notifyRes.slackTs;
      }
    } catch (startNotifyErr: any) {
      logWorker("WARN", `Error sending started notification: ${startNotifyErr?.message || String(startNotifyErr)}`);
    }
  }

  // Dynamically handle session resumption / continuation
  const targetSessionToResume = resolveSessionId(currentRoot, sessionId);
  const activeSessionId = targetSessionToResume || sessionId;

  const waitMaxMs = parseInt(process.env.AGENT_BRIDGE_ACCOUNT_WAIT_MS || String(6 * 3600 * 1000), 10);
  const waitPollMs = parseInt(process.env.AGENT_BRIDGE_ACCOUNT_POLL_MS || "30000", 10);
  const waitStart = Date.now();

  // Same session + project_dir (or continue_session) must not run concurrently.
  if (conversationLaneKey(activeSessionId, projectDir, continueSession)) {
    let loggedLaneWait = false;
    for (;;) {
      if (
        !isConversationLaneBusy(currentRoot, activeSessionId, projectDir, continueSession, taskId)
      ) {
        break;
      }
      if (fs.existsSync(path.join(controlDir, `${taskId}.cancel`)) || Date.now() - waitStart > waitMaxMs) {
        const reasonTxt = "conversation lane busy (same session/project); timed out or cancelled";
        writeStatus(currentRoot, taskId, {
          state: "failed",
          agent: agentName,
          model,
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: null,
          reason: reasonTxt,
        });
        saveProcessedTask(processedMap, taskId, new Date().toISOString());
        logWorker("ERROR", `Task ${taskId}: ${reasonTxt}`);
        return true;
      }
      if (!loggedLaneWait) {
        logWorker("WARN", `Task ${taskId} queued: waiting for conversation lane (session/project serial execution)...`);
        writeStatus(currentRoot, taskId, {
          state: "queued",
          agent: agentName,
          model,
          startedAt,
          reason: "waiting for conversation lane (same session/project)",
          workerPid: process.pid,
        });
        loggedLaneWait = true;
      }
      await new Promise((r) => setTimeout(r, waitPollMs));
    }
  }

  // Resolve account across the dual pool (agy only): custom Profiles first, then the
  // default pool (default HOME + Cockpit rotation). If nothing is available, wait (queued).
  const isAgyTask = agentConfigCommandIsAgy(registry, agentName);
  let accountSel: AccountSelection | undefined;
  if (isAgyTask) {
    let loggedWait = false;
    for (;;) {
      accountSel = await acquireDualPoolAccount(currentRoot, taskId, {
        session_id: activeSessionId,
        requestedAccount: account,
        logger: logWorker,
      });
      if (accountSel.pool !== "none") break;
      if (accountSel.kind === "no_quota") break; // tell the caller instead of hanging
      if (fs.existsSync(path.join(controlDir, `${taskId}.cancel`)) || Date.now() - waitStart > waitMaxMs) break;
      if (!loggedWait) {
        logWorker("WARN", `Task ${taskId} queued: no agy account available (${accountSel.reason}). Waiting...`);
        writeStatus(currentRoot, taskId, { state: "queued", agent: agentName, model, startedAt, reason: `waiting for account: ${accountSel.reason}`, workerPid: process.pid });
        loggedWait = true;
      }
      await new Promise((r) => setTimeout(r, waitPollMs));
    }
    if (accountSel.pool === "none" && accountSel.kind === "no_quota") {
      const fin = new Date().toISOString();
      const reasonTxt = `no_quota: ${accountSel.reason}. Task stashed; resume with resume_after_account_switch.`;
      try {
        stashQuotaTask(currentRoot, { taskId, session_id: sessionId, agent: agentName, model, reasoningEffort, prompt, errorSnippet: reasonTxt, pausedAt: fin });
      } catch {}
      writeResultFile(resultsDir, taskId, "no_quota", agentName, startedAt, fin, null,
        `No agy account has quota left (agent was NOT switched).\n\n${accountSel.reason}${accountSel.earliest_reset ? `\n\nearliest_reset: ${accountSel.earliest_reset}` : ""}`,
        "", model, reasoningEffort, sessionId);
      writeStatus(currentRoot, taskId, { state: "paused_quota", agent: agentName, model, startedAt, finishedAt: fin, exitCode: null, reason: reasonTxt });
      saveProcessedTask(processedMap, taskId, fin);
      logWorker("WARN", `Task ${taskId}: ${reasonTxt}`);
      try { onTaskFinished(currentRoot, taskId, "paused_quota", sessionId, reasonTxt); } catch {}
      return true;
    }
    if (accountSel.pool === "none") {
      const reasonTxt = `no agy account available: ${accountSel.reason}`;
      writeStatus(currentRoot, taskId, { state: "failed", agent: agentName, model, startedAt, finishedAt: new Date().toISOString(), exitCode: null, reason: reasonTxt });
      saveProcessedTask(processedMap, taskId, new Date().toISOString());
      logWorker("ERROR", `Task ${taskId}: ${reasonTxt}`);
      return true;
    }
  }
  const poolProfile = accountSel && accountSel.pool === "custom" ? accountSel : undefined;
  const accountEmail = accountSel && accountSel.pool !== "none" ? accountSel.email : undefined;
  const releaseAccount = () => releaseSelection(currentRoot, accountSel, taskId);
  process.once("exit", releaseAccount);

  const effectiveHome = poolProfile?.home || process.env.HOME || os.homedir();
  const effectiveAccountAlias = poolProfile?.alias
    || (accountSel?.pool === "default" && accountEmail ? `default:${accountEmail}` : undefined)
    || (account && account !== "auto" ? account : undefined);
  if (accountSel?.pool === "default") {
    logWorker("INFO", `Task ${taskId} assigned to default pool (HOME ${effectiveHome}${accountEmail ? `, Cockpit account ${accountEmail}` : ", legacy"})`);
  }

  if (poolProfile) {
    recordTaskStartUnderProfile(currentRoot, poolProfile.alias, taskId, activeSessionId);
    logWorker("INFO", `Task ${taskId} assigned to account pool profile "${poolProfile.alias}" (home: ${poolProfile.home})`);
  }

  // Write running status and audit as execution begins
  writeStatus(currentRoot, taskId, {
    state: "running",
    projectId,
    projectName,
    agent: agentName,
    model,
    reasoningEffort,
    account: effectiveAccountAlias,
    startedAt,
    workerPid: process.pid,
    ...(slackStartTs ? { slackMessageTs: slackStartTs } : {}),
  });
  audit(currentRoot, { tool: "worker", taskId, agent: agentName, state: "running" });

  // Execute agent command
  const agentConfig: AgentConfig = registry[agentName];
  const command = agentConfig.command;
  const args = [...agentConfig.args];
  const isAgyFamily = command.includes("agy") || agentName === "agy" || agentName === "agy-sdk";

  if (agentName === "agy-sdk") {
    const hasOutputFormat = args.some(
      (a) => a === "--output-format" || a === "-o" || a.startsWith("--output-format=")
    );
    if (!hasOutputFormat) {
      args.push("--output-format", "stream-json");
    }
  }
  const useSdkStreamParser = isAgySdkStreamAgent(agentName, command, args);

  if (targetSessionToResume || continueSession) {
    if (command.includes("codex") || agentName === "codex") {
      const execIdx = args.indexOf("exec");
      if (execIdx !== -1) {
        if (targetSessionToResume) {
          args.splice(execIdx + 1, 0, "resume", targetSessionToResume);
        } else if (continueSession) {
          args.splice(execIdx + 1, 0, "resume", "--last");
        }
      } else {
        if (targetSessionToResume) {
          args.unshift("resume", targetSessionToResume);
        } else if (continueSession) {
          args.unshift("resume", "--last");
        }
      }
    } else if (isAgyFamily) {
      if (targetSessionToResume) {
        const agyCliBase = process.env.GEMINI_CLI_HOME || path.join(effectiveHome, ".gemini", "antigravity-cli");
        const convDbPath = path.join(agyCliBase, "conversations", `${targetSessionToResume}.db`);
        const convBrainPath = path.join(agyCliBase, "brain", targetSessionToResume);
        const defaultCliBase = path.join(os.homedir(), ".gemini", "antigravity-cli");
        const existsInTargetHome = fs.existsSync(convDbPath) || fs.existsSync(convBrainPath);
        const existsInDefaultHome =
          fs.existsSync(path.join(defaultCliBase, "conversations", `${targetSessionToResume}.db`)) ||
          fs.existsSync(path.join(defaultCliBase, "brain", targetSessionToResume));

        if (!existsInTargetHome && existsInDefaultHome && effectiveHome !== os.homedir()) {
          logWorker(
            "WARN",
            `Task ${taskId}: conversation "${targetSessionToResume}" does not exist in switched profile HOME (${effectiveHome}); falling back to fresh conversation run.`
          );
        } else {
          args.push("--conversation", targetSessionToResume);
        }
      } else if (continueSession) {
        args.push("--continue");
      }
    }
  }

  // Prepare per-task structured report directory ($TASK_DIR) and ensure prompt instructs writing $TASK_DIR/report.json
  const taskReportDir = getTaskReportDir(currentRoot, taskId);
  try {
    if (!fs.existsSync(taskReportDir)) {
      fs.mkdirSync(taskReportDir, { recursive: true });
    }
  } catch {}
  const effectivePrompt = prompt.includes("[Structured Report Requirement]")
    ? prompt
    : `${prompt}${buildReportJsonPromptInstruction(taskReportDir)}`;

  // agy agent requirement: use --print mode for non-interactive runs
  // Prompt is attached directly to the flag (--print=<prompt>) or passed as a flag argument
  // to prevent consuming subsequent options like --dangerously-skip-permissions, --model, etc.
  if (isAgyFamily) {
    const hasPrintFlag = args.some(
      (a) => a === "--print" || a === "-p" || a.startsWith("--print=") || a.startsWith("-p=")
    );
    if (!hasPrintFlag) {
      args.push(`--print=${effectivePrompt}`);
    }
  }

  // Dynamically inject model parameter if specified
  if (model) {
    if (command.includes("codex") || agentName === "codex") {
      args.push("-m", model);
    } else if (isAgyFamily) {
      args.push("--model", model);
    } else {
      args.push("--model", model);
    }
  }

  // Dynamically inject reasoning effort if specified AND supported by agent/model capability
  if (reasoningEffort) {
    const isCodex = command.includes("codex") || agentName === "codex";
    const isAgy = isAgyFamily;
    const supportsEffort = isCodex || agentSupportsEffort(agentConfig, model);

    if (isCodex) {
      if (supportsEffort) {
        args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
      }
    } else if (isAgy) {
      // agy agent: never pass --effort/reasoning_effort unless the agent registry explicitly marks the model as supporting it
      if (supportsEffort) {
        args.push("--effort", reasoningEffort);
      }
    } else if (supportsEffort) {
      args.push("--effort", reasoningEffort);
    }
  }

  if (agentConfig.input === "arg" && !isAgyFamily) {
    args.push(effectivePrompt);
  }

  let stdoutData = "";
  let stderrData = "";
  let child: ChildProcess | null = null;
  let isTimeout = false;
  let isCancelled = false;
  let seenCancelRequested = false;
  let exitCode: number | null = null;

  // Prepare incremental stdout file in logs/<task_id>.out (and .events.jsonl for agy-sdk)
  const taskLogsDir = path.join(currentRoot, "logs");
  const taskOutFilePath = path.join(taskLogsDir, `${taskId}.out`);
  const taskEventsFilePath = path.join(taskLogsDir, `${taskId}.events.jsonl`);
  let sdkParser: AgySdkStreamParser | null = null as AgySdkStreamParser | null;
  let sessionTrackerRef: TaskSessionTracker | null = null as TaskSessionTracker | null;
  try {
    if (!fs.existsSync(taskLogsDir)) fs.mkdirSync(taskLogsDir, { recursive: true });
    fs.writeFileSync(taskOutFilePath, "", "utf8");
    if (useSdkStreamParser) {
      fs.writeFileSync(taskEventsFilePath, "", "utf8");
    }
  } catch {}

  let effectiveWorkingDir = projectDir && fs.existsSync(projectDir) ? projectDir : undefined;
  let matchedTaskProj = undefined as ReturnType<typeof loadProjectsConfig>["projects"][string] | undefined;
  try {
    const projConfig = loadProjectsConfig(currentRoot);
    matchedTaskProj = Object.values(projConfig.projects).find(
      (p) =>
        (projectId && p.id.toLowerCase() === projectId.toLowerCase()) ||
        (projectDir && (getProjectRepoPath(p) === projectDir || (p.paths && p.paths.includes(projectDir))))
    );
  } catch {}

  // Worktree setup if requested
  if (worktreeName) {
    if (!effectiveWorkingDir) {
      const errMsg = `Worktree requested ("${worktreeName}"), but no valid project directory or repository path was resolved (projectDir="${projectDir || ""}"). Cannot create worktree without base repo.`;
      const fin = new Date().toISOString();
      writeResultFile(resultsDir, taskId, "failed (worktree setup failed)", agentName, startedAt, fin, 1, "", errMsg);
      writeStatus(currentRoot, taskId, {
        state: "failed",
        agent: agentName,
        model,
        account: effectiveAccountAlias,
        startedAt,
        finishedAt: fin,
        exitCode: 1,
        reason: errMsg,
      });
      releaseAccount();
      process.removeListener("exit", releaseAccount);
      saveProcessedTask(processedMap, taskId, fin);
      audit(currentRoot, { tool: "worker", taskId, agent: agentName, state: "failed", exitCode: 1 });
      logWorker("ERROR", `Task ${taskId} failed: ${errMsg}`);
      notify("agent-bridge", `Task ${taskId} failed [${agentName || "(none)"}]`);
      if (callbackUrl) {
        sendCompletionCallback({
          url: callbackUrl,
          headers: callbackHeaders,
          allowedEnv: matchedTaskProj?.allowed_env,
          taskId,
          agent: agentName,
          status: "failed",
          exitCode: 1,
          durationSeconds: 0,
          resultPath: path.join(resultsDir, `${taskId}.md`),
          logPath: taskOutFilePath,
          project: projectName || projectId,
          logger: logWorker,
        }).catch(() => {});
      }
      try { onTaskFinished(currentRoot, taskId, "failed", activeSessionId || sessionId, errMsg); } catch {}
      try { triggerTaskWebhook(currentRoot, taskId, "failed", activeSessionId || sessionId, 0).catch(() => {}); } catch {}
      return true;
    }

    try {
      const projConfig = loadProjectsConfig(currentRoot);
      const matchedProj = Object.values(projConfig.projects).find(
        (p) =>
          (projectId && p.id.toLowerCase() === projectId.toLowerCase()) ||
          (projectDir && (getProjectRepoPath(p) === projectDir || (p.paths && p.paths.includes(projectDir))))
      );
      const wtRes = setupGitWorktree({
        repoDir: effectiveWorkingDir,
        worktreeName,
        baseBranch: worktreeBaseBranch || matchedProj?.default_base_branch,
        worktreeRoot: matchedProj?.worktree_root,
        symlinkDirs: matchedProj?.symlink_dirs,
        logger: logWorker,
      });
      effectiveWorkingDir = wtRes.worktreeDir;
      logWorker("INFO", `Task ${taskId} executing inside git worktree: ${effectiveWorkingDir}`);
    } catch (wtErr: any) {
      const errMsg = `Failed to setup git worktree "${worktreeName}": ${wtErr?.message || String(wtErr)}`;
      const fin = new Date().toISOString();
      writeResultFile(resultsDir, taskId, "failed (worktree setup failed)", agentName, startedAt, fin, 1, "", errMsg);
      writeStatus(currentRoot, taskId, {
        state: "failed",
        agent: agentName,
        model,
        account: effectiveAccountAlias,
        startedAt,
        finishedAt: fin,
        exitCode: 1,
        reason: errMsg,
      });
      releaseAccount();
      process.removeListener("exit", releaseAccount);
      saveProcessedTask(processedMap, taskId, fin);
      audit(currentRoot, { tool: "worker", taskId, agent: agentName, state: "failed", exitCode: 1 });
      logWorker("ERROR", `Task ${taskId} failed: ${errMsg}`);
      notify("agent-bridge", `Task ${taskId} failed [${agentName || "(none)"}]`);
      if (callbackUrl) {
        sendCompletionCallback({
          url: callbackUrl,
          headers: callbackHeaders,
          allowedEnv: matchedTaskProj?.allowed_env,
          taskId,
          agent: agentName,
          status: "failed",
          exitCode: 1,
          durationSeconds: 0,
          resultPath: path.join(resultsDir, `${taskId}.md`),
          logPath: taskOutFilePath,
          project: projectName || projectId,
          logger: logWorker,
        }).catch(() => {});
      }
      try { onTaskFinished(currentRoot, taskId, "failed", activeSessionId || sessionId, errMsg); } catch {}
      try { triggerTaskWebhook(currentRoot, taskId, "failed", activeSessionId || sessionId, 0).catch(() => {}); } catch {}
      return true;
    }
  }

  let gitHeadBefore: string | undefined;
  if (effectiveWorkingDir) {
    try {
      const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: effectiveWorkingDir, encoding: "utf8" });
      if (gitHead.status === 0 && gitHead.stdout) {
        gitHeadBefore = gitHead.stdout.trim();
      }
    } catch {}
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      let overdueTimer: NodeJS.Timeout | null = null;
      let overdueAlertFired = false;
      let killTimer: NodeJS.Timeout | null = null;
      let cancelCheckInterval: NodeJS.Timeout | null = null;

      const clearOverdueTimer = () => {
        if (overdueTimer) {
          clearTimeout(overdueTimer);
          overdueTimer = null;
        }
      };

      const fireOverdueAlert = () => {
        if (overdueAlertFired) return;
        overdueAlertFired = true;
        const elapsedMs = Date.now() - new Date(startedAt).getTime();
        const elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));
        logWorker("WARN", `Task ${taskId} overdue after ${elapsedSec}s (process still running; alert only)`);
        if (isNotifyEnabled && notifyOn.has("overdue")) {
          notify("agent-bridge", `Task ${taskId} overdue after ${elapsedSec}s (still running) [${agentName}]`, {
            subtitle: "任务超时告警（未终止）",
            level: "warning",
            channel: notifyChannel,
            sound: notifySound,
          });
        }
        if (callbackUrl) {
          sendCompletionCallback({
            url: callbackUrl,
            headers: callbackHeaders,
            allowedEnv: matchedTaskProj?.allowed_env,
            taskId,
            agent: agentName,
            status: "overdue",
            exitCode: null,
            durationSeconds: elapsedSec,
            resultPath: path.join(resultsDir, `${taskId}.md`),
            logPath: taskOutFilePath,
            outputLog: stdoutData + "\n" + stderrData,
            project: projectName || projectId,
            logger: logWorker,
          }).catch(() => {});
        }
        triggerTaskWebhook(currentRoot, taskId, "overdue", sessionId, elapsedMs).catch(() => {});
      };

      const isWin = process.platform === "win32";
      const killChild = (sig: "SIGTERM" | "SIGKILL") => {
        const activeChild = child as ChildProcess | null;
        if (activeChild && activeChild.pid !== undefined && activeChild.exitCode === null && activeChild.signalCode === null) {
          const childPid = activeChild.pid;
          if (isWin) {
            try {
              const killArgs = ["/T", "/PID", String(childPid)];
              if (sig === "SIGKILL") killArgs.push("/F");
              spawnSync("taskkill", killArgs, { shell: false, windowsHide: true });
            } catch {}
          } else {
            const allPids = [childPid, ...getDescendantPids(childPid)];
            for (const p of allPids) {
              try { process.kill(p, sig); } catch {}
            }
          }
        }
      };

      try {
        // Do not route native agents through cmd.exe: it reparses quoted model
        // settings, prompts, and metacharacters instead of preserving argv.
        // Batch launchers should be registered using their underlying native
        // executable (for example node.exe plus the CLI's JavaScript entrypoint).
        if (isWin && /\.(?:cmd|bat)$/i.test(command)) {
          throw new Error("Windows batch agent launchers are not supported directly. Register the native .exe, or node.exe with the CLI JavaScript entrypoint, to preserve task arguments.");
        }
        const pathSep = path.delimiter;
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

        // Windows environment names are case insensitive; passing both Path and
        // PATH causes Node to choose one, potentially dropping the added paths.
        const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") || "PATH";
        const currentPath = process.env[pathKey] || (isWin ? "" : "/usr/bin:/bin:/usr/sbin:/sbin");
        const combinedPath = Array.from(new Set([...extraPaths, ...currentPath.split(pathSep)].filter(Boolean))).join(pathSep);

        child = spawn(command, args, {
          cwd: effectiveWorkingDir,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            [pathKey]: combinedPath,
            HOME: effectiveHome,
            TASK_DIR: taskReportDir,
          },
        });
      } catch (spawnErr: any) {
        return reject(spawnErr);
      }

      // Initialize per-task session tracker for accurate stuck detection without global scans
      const sessionTracker = new TaskSessionTracker({
        taskId,
        agentName,
        command,
        workDir: effectiveWorkingDir,
        prompt,
        sessionId: useSdkStreamParser ? undefined : (targetSessionToResume || sessionId),
        profileHome: poolProfile?.home,
        startedAtMs: new Date(startedAt).getTime(),
      });
      sessionTrackerRef = sessionTracker;

      const statusThrottleMs = parseInt(process.env.AGENT_BRIDGE_SDK_STATUS_THROTTLE_MS || "5000", 10);
      let lastSdkStatusWriteMs = 0;
      let lastSdkWrittenState = "";
      let lastSdkWrittenConvId = "";
      let lastSdkEventTime = Date.now();

      if (useSdkStreamParser) {
        sdkParser = new AgySdkStreamParser({
          onEvent: (_ev, compactLine) => {
            try {
              fs.appendFileSync(taskEventsFilePath, `${compactLine}\n`, "utf8");
            } catch {}
          },
          onActivity: (update) => {
            if (isCancelled || seenCancelRequested) return;
            const now = Date.now();
            lastSdkEventTime = now;
            lastOutputTime = now;
            stuckWarned = false;
            clearStall();
            const act = sessionTracker.recordSdkEvent({
              conversationId: update.conversationId,
              source: update.source,
              timestampMs: now,
            });
            const curState = stallFlagged ? "suspected_stalled" : "running";
            const convChanged = Boolean(update.conversationId && update.conversationId !== lastSdkWrittenConvId);
            const stateChanged = curState !== lastSdkWrittenState;
            const shouldWriteNow =
              Boolean(update.immediate) ||
              convChanged ||
              stateChanged ||
              now - lastSdkStatusWriteMs >= statusThrottleMs;

            if (!shouldWriteNow) return;
            lastSdkStatusWriteMs = now;
            lastSdkWrittenState = curState;
            if (update.conversationId) lastSdkWrittenConvId = update.conversationId;

            try {
              writeStatus(currentRoot, taskId, {
                state: curState,
                agent: agentName,
                model,
                reasoningEffort,
                account: effectiveAccountAlias,
                startedAt,
                ...(slackStartTs ? { slackMessageTs: slackStartTs } : {}),
                ...(update.conversationId ? { sessionId: update.conversationId } : {}),
                pid: child?.pid,
                workerPid: process.pid,
                logPath: taskOutFilePath,
                workDir: effectiveWorkingDir,
                lastActivityAt: act.last_activity_at,
                activity: act.activity,
                last_activity_at: act.last_activity_at,
                idle_seconds: act.idle_seconds,
                activity_source: act.activity_source,
              });
            } catch {}
          },
        });
      }

      // Record child/worker pid, log path and work dir so status readers can detect ghosts.
      try {
        writeStatus(currentRoot, taskId, {
          state: "running",
          agent: agentName,
          model,
          reasoningEffort,
          account: effectiveAccountAlias,
          startedAt,
          ...(slackStartTs ? { slackMessageTs: slackStartTs } : {}),
          pid: child.pid,
          workerPid: process.pid,
          logPath: taskOutFilePath,
          workDir: effectiveWorkingDir,
          lastActivityAt: startedAt,
          activity: "active",
          last_activity_at: startedAt,
          idle_seconds: 0,
          activity_source: "none",
        });
      } catch {}

      if (notifyOverdueSeconds && notifyOverdueSeconds > 0) {
        overdueTimer = setTimeout(fireOverdueAlert, notifyOverdueSeconds * 1000);
      }

      if (effectiveHardTimeoutMs > 0) {
        timer = setTimeout(() => {
          isTimeout = true;
          logWorker("WARN", `Task ${taskId} hard timed out after ${effectiveHardTimeoutMs}ms. Sending SIGTERM to process.`);
          killChild("SIGTERM");
          killTimer = setTimeout(() => {
            logWorker("WARN", `Task ${taskId} process still running after 5s. Sending SIGKILL.`);
            killChild("SIGKILL");
          }, 5000);
        }, effectiveHardTimeoutMs);
      }

      // Stuck detection:
      // - For `useSdkStreamParser` (`agy-sdk`): default threshold is 600s (10 min), and activity is judged
      //   STRICTLY by structured event arrival time (`checkSdkEventOnlyActivity`), never by CPU or file scans.
      // - For standard CLI runners: default threshold is 180s, checking the 4 per-task signals.
      const defaultStuckMs = useSdkStreamParser ? "600000" : "180000";
      const stuckThresholdMs = parseInt(
        (useSdkStreamParser ? process.env.AGENT_BRIDGE_SDK_STUCK_MS : undefined) ||
          process.env.AGENT_BRIDGE_STUCK_MS ||
          defaultStuckMs,
        10
      );
      let lastOutputTime = Date.now();
      let stuckWarned = false;
      let stuckCheckInterval: NodeJS.Timeout | null = null;
      if (isNotifyEnabled && notifyOn.has("stuck")) {
        stuckCheckInterval = setInterval(() => {
          if (stuckWarned || isCancelled || seenCancelRequested) return;
          try {
            if (fs.existsSync(cancelFilePath) || readStatus(currentRoot, taskId)?.state === "cancelled") {
              seenCancelRequested = true;
              return;
            }
          } catch {}

          const act = useSdkStreamParser
            ? sessionTracker.checkSdkEventOnlyActivity(stuckThresholdMs)
            : sessionTracker.checkActivity({
                childPid: child?.pid,
                stdoutLen: stdoutData.length,
                stderrLen: stderrData.length,
                stuckThresholdMs,
              });

          // Update task status with compact activity fields
          try {
            writeStatus(currentRoot, taskId, {
              state: stallFlagged ? "suspected_stalled" : "running",
              agent: agentName,
              model,
              reasoningEffort,
              account: effectiveAccountAlias,
              startedAt,
              ...(slackStartTs ? { slackMessageTs: slackStartTs } : {}),
              ...(sdkParser?.getConversationId() ? { sessionId: sdkParser.getConversationId()! } : {}),
              pid: child?.pid,
              workerPid: process.pid,
              logPath: taskOutFilePath,
              workDir: effectiveWorkingDir,
              lastActivityAt: act.last_activity_at,
              activity: act.activity,
              last_activity_at: act.last_activity_at,
              idle_seconds: act.idle_seconds,
              activity_source: act.activity_source,
            });
          } catch {}

          // For SDK stream tasks: only check event idle time (`now - lastSdkEventTime >= stuckThresholdMs`).
          // For CLI tasks: check both output quiet time and 4-signal idle time.
          const now = Date.now();
          const isStuckNow = useSdkStreamParser
            ? now - lastSdkEventTime >= stuckThresholdMs && act.idle_seconds * 1000 >= stuckThresholdMs
            : now - lastOutputTime >= stuckThresholdMs && act.idle_seconds * 1000 >= stuckThresholdMs;

          if (isStuckNow) {
            stuckWarned = true;
            logWorker("WARN", `Task ${taskId} has produced no output or progress for ${Math.round(stuckThresholdMs / 1000)}s, possibly stuck.`);
            notify("agent-bridge", `Task ${taskId} 超过 ${Math.round(stuckThresholdMs / 1000)}s 无新输出或活动，可能已卡住 [${agentName}]`, {
              subtitle: "任务可能卡住",
              level: "warning",
              channel: notifyChannel,
              sound: notifySound,
            });
            if (callbackUrl) {
              const stuckDuration = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
              sendCompletionCallback({
                url: callbackUrl,
                headers: callbackHeaders,
                taskId,
                agent: agentName,
                status: "stuck",
                exitCode: null,
                durationSeconds: stuckDuration,
                resultPath: path.join(resultsDir, `${taskId}.md`),
                logPath: taskOutFilePath,
                outputLog: stdoutData + "\n" + stderrData,
                project: projectName || projectId,
                logger: logWorker,
              }).catch(() => {});
            }
          }
        }, Math.min(10000, Math.max(250, Math.floor(stuckThresholdMs / 4))));
      }

      // Stall detection: no log output AND no work-dir change for AGENT_BRIDGE_STALL_MINUTES.
      const stallMs = getStallThresholdMs();
      let stallFlagged = false;
      const stallCheckInterval: NodeJS.Timeout | null = stallMs > 0 ? setInterval(() => {
        if (stallFlagged || isCancelled || seenCancelRequested) return;
        try {
          if (fs.existsSync(cancelFilePath) || readStatus(currentRoot, taskId)?.state === "cancelled") {
            seenCancelRequested = true;
            return;
          }
        } catch {}
        const now = Date.now();
        if (now - lastOutputTime < stallMs) return;
        const dirMtime = newestMtime(effectiveWorkingDir);
        if (dirMtime && now - dirMtime < stallMs) return;
        stallFlagged = true;
        const mins = Math.round(stallMs / 60000);
        const reason = `suspected stall: no log output and no change in ${effectiveWorkingDir || "work dir"} for ${mins} min (process ${child?.pid} still alive)`;
        logWorker("WARN", `Task ${taskId} ${reason}`);
        try {
          writeStatus(currentRoot, taskId, {
            state: "suspected_stalled",
            agent: agentName, model, reasoningEffort, account: effectiveAccountAlias, startedAt,
            ...(slackStartTs ? { slackMessageTs: slackStartTs } : {}),
            pid: child?.pid, workerPid: process.pid, logPath: taskOutFilePath, workDir: effectiveWorkingDir,
            lastActivityAt: new Date(Math.max(lastOutputTime, dirMtime || 0)).toISOString(),
            reason,
            logTail: (stdoutData + (stderrData ? "\n[stderr]\n" + stderrData : "")).split(/\r?\n/).filter(l => l.trim()).slice(-15).join("\n").slice(-1500) || undefined,
          });
        } catch {}
        triggerTaskWebhook(currentRoot, taskId, "suspected_stalled", sessionId, now - new Date(startedAt).getTime()).catch(() => {});
      }, Math.min(30000, Math.max(1000, Math.floor(stallMs / 4)))) : null;
      const clearStall = () => {
        if (!stallFlagged || isCancelled || seenCancelRequested) return;
        stallFlagged = false;
        try {
          if (fs.existsSync(cancelFilePath) || readStatus(currentRoot, taskId)?.state === "cancelled") {
            seenCancelRequested = true;
            return;
          }
          writeStatus(currentRoot, taskId, {
            state: "running", agent: agentName, model, reasoningEffort, account: effectiveAccountAlias, startedAt,
            ...(slackStartTs ? { slackMessageTs: slackStartTs } : {}),
            pid: child?.pid, workerPid: process.pid, logPath: taskOutFilePath, workDir: effectiveWorkingDir,
            lastActivityAt: new Date().toISOString(),
          });
        } catch {}
      };

      let seenCancelRequested = false;
      // Check for control/<taskId>.cancel every 250ms (responsive cancellation)
      cancelCheckInterval = setInterval(() => {
        let cancelRequested = false;
        if (fs.existsSync(cancelFilePath)) {
          cancelRequested = true;
          try {
            fs.unlinkSync(cancelFilePath);
          } catch {}
        }
        if (!cancelRequested) {
          try {
            const currentSt = readStatus(currentRoot, taskId);
            if (currentSt?.state === "cancelled") {
              cancelRequested = true;
            }
          } catch {}
        }

        if (cancelRequested) {
          seenCancelRequested = true;
        }

        if (cancelRequested && !isCancelled) {
          isCancelled = true;
          logWorker("WARN", `Task ${taskId} cancellation requested. Sending SIGTERM to process.`);
          killChild("SIGTERM");
          killTimer = setTimeout(() => {
            logWorker("WARN", `Task ${taskId} process still running after 2s of cancellation. Sending SIGKILL.`);
            killChild("SIGKILL");
          }, 2000);
        }
      }, 250);

      if (agentConfig.input === "stdin" && child.stdin) {
        child.stdin.on("error", () => {});
        try {
          child.stdin.write(effectivePrompt);
          child.stdin.end();
        } catch {}
      }

      child.stdout?.on("data", (chunk) => {
        lastOutputTime = Date.now();
        clearStall();
        const rawText = chunk.toString("utf8");
        if (sdkParser) {
          const readable = sdkParser.feedChunk(rawText);
          if (readable) {
            stdoutData = capTailString(stdoutData + readable, MAX_SDK_BUFFER_BYTES);
            try {
              fs.appendFileSync(taskOutFilePath, readable, "utf8");
            } catch {}
          }
          // In stream-json mode, activity & conversationId are driven ONLY by parsed SDK events (via sdkParser onActivity)
        } else {
          stuckWarned = false;
          stdoutData = capTailString(stdoutData + rawText, MAX_SDK_BUFFER_BYTES);
          try {
            fs.appendFileSync(taskOutFilePath, rawText, "utf8");
          } catch {}
          const extracted = extractSessionIdFromOutput(rawText);
          sessionTracker.checkActivity({
            extractedSessionId: extracted,
            stdoutLen: stdoutData.length,
            stderrLen: stderrData.length,
            stuckThresholdMs,
          });
        }
      });

      child.stderr?.on("data", (chunk) => {
        lastOutputTime = Date.now();
        clearStall();
        const errText = chunk.toString("utf8");
        stderrData = capTailString(stderrData + errText, MAX_SDK_BUFFER_BYTES);
        try {
          fs.appendFileSync(taskOutFilePath.replace(/\.out$/, ".err"), errText, "utf8");
        } catch {}
        if (!sdkParser) {
          stuckWarned = false;
          sessionTracker.checkActivity({
            stdoutLen: stdoutData.length,
            stderrLen: stderrData.length,
            stuckThresholdMs,
          });
        }
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        clearOverdueTimer();
        if (killTimer) clearTimeout(killTimer);
        if (cancelCheckInterval) clearInterval(cancelCheckInterval);
        if (stuckCheckInterval) clearInterval(stuckCheckInterval);
        if (stallCheckInterval) clearInterval(stallCheckInterval);
        reject(err);
      });

      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        clearOverdueTimer();
        if (killTimer) clearTimeout(killTimer);
        if (cancelCheckInterval) clearInterval(cancelCheckInterval);
        if (stuckCheckInterval) clearInterval(stuckCheckInterval);
        if (stallCheckInterval) clearInterval(stallCheckInterval);
        if (sdkParser) {
          const trailing = sdkParser.flush();
          if (trailing) {
            stdoutData = capTailString(stdoutData + trailing, MAX_SDK_BUFFER_BYTES);
            try {
              fs.appendFileSync(taskOutFilePath, trailing, "utf8");
            } catch {}
          }
        }
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
  let state: "completed" | "failed" | "cancelled" | "paused_quota" = "completed";
  let reason: string | undefined = undefined;

  // Check cancellation before writing final result:
  // status is cancelled, or control cancel file exists, or seenCancelRequested, or isCancelled
  let wasCancelled = isCancelled || seenCancelRequested;
  try {
    if (fs.existsSync(cancelFilePath)) {
      wasCancelled = true;
      try { fs.unlinkSync(cancelFilePath); } catch {}
    }
  } catch {}
  if (!wasCancelled) {
    try {
      const currentSt = readStatus(currentRoot, taskId);
      if (currentSt?.state === "cancelled") {
        wasCancelled = true;
      }
    } catch {}
  }

  // agy early exit check: If agy exits within 30s with an error, mark task failed with the error text (fail fast, notify)
  // Quota exhaustion takes precedence over agy early-exit fail-fast so sessions can be resumed after account switch.
  const isAgy = isAgyFamily;
  if (sdkParser) {
    const sdkClean = sdkParser.getCleanOutput();
    if (sdkClean && sdkClean.trim().length > 0) {
      stdoutData = capTailString(sdkClean, MAX_SDK_BUFFER_BYTES);
    }
    const sdkErrors = sdkParser.getErrorMessages();
    if (sdkErrors.length > 0 && !stderrData.includes(sdkErrors[0])) {
      stderrData = capTailString((stderrData ? `${stderrData}\n` : "") + sdkErrors.join("\n"), MAX_SDK_BUFFER_BYTES);
    }
    const sdkResult = sdkParser.getResultPayload();
    if ((sdkResult?.status === "ERROR" || sdkResult?.finished_reason === "error") && (exitCode === 0 || exitCode === null)) {
      exitCode = 1;
    }
  }
  const failureKind: "login" | "quota" | "other" = exitCode !== 0 && !wasCancelled && !isTimeout
    ? (isLoginInvalidError(stdoutData, stderrData)
        ? "login"
        : sdkParser
          ? (sdkParser.isQuotaError(exitCode, `${stderrData}\n${stdoutData}`) ? "quota" : "other")
          : classifyAgentFailure(exitCode, stdoutData, stderrData))
    : "other";
  const runDurationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (wasCancelled) {
    status = "cancelled (cancelled by request)";
    state = "cancelled";
    reason = "cancelled by request";
    isCancelled = true;
    if (exitCode === null || exitCode === 0) exitCode = 1;
  } else if (isTimeout) {
    status = "failed (timeout)";
    state = "failed";
    reason = "timeout";
  } else if (exitCode !== 0 && failureKind === "login") {
    status = "failed";
    state = "failed";
    reason = `agy login invalid (needs re-login); retryable after re-login`;
    const detail = (stderrData || stdoutData).trim().split(/\r?\n/).filter(l => l.trim()).slice(-1).join(" ").slice(0, 200);
    if (poolProfile) {
      try { markProfileNeedsRelogin(currentRoot, poolProfile.alias, detail); } catch {}
      logWorker("WARN", `Pool profile "${poolProfile.alias}" marked needs_relogin (not a quota pause).`);
    }
  } else if (exitCode !== 0 && failureKind === "quota") {
    status = "paused_quota";
    state = "paused_quota";
    reason = "quota or rate limit exhausted";
    try {
      const extractedEarly = useSdkStreamParser
        ? (sdkParser?.getConversationId() ?? undefined)
        : extractSessionIdFromOutput(stdoutData);
      const earlySessionId = extractedEarly || targetSessionToResume;
      stashQuotaTask(currentRoot, {
        taskId,
        session_id: earlySessionId || sessionId,
        agent: agentName,
        model,
        reasoningEffort,
        prompt,
        errorSnippet: (stderrData || stdoutData).slice(-300),
        pausedAt: finishedAt,
      });
      logWorker("WARN", `Task ${taskId} encountered quota exhaustion. Marked paused_quota and stashed session context.`);
      const resetAt = parseQuotaResetTime(stderrData + "\n" + stdoutData) || new Date(Date.now() + 5 * 3600 * 1000).toISOString();
      if (poolProfile) {
        handlePoolQuotaPaused(currentRoot, poolProfile.alias, resetAt);
        logWorker("INFO", `Pool profile "${poolProfile.alias}" paused until ${resetAt} due to explicit quota evidence.`);
      }
      if (accountEmail) {
        pauseEmail(currentRoot, accountEmail, resetAt, "quota");
        logWorker("INFO", `Account ${accountEmail} paused (shared across pools) until ${resetAt}.`);
      }
    } catch {}
  } else if (exitCode !== 0 && runDurationMs <= 30000) {
    // Fast failure (any agent): surface the error text as the reason.
    status = "failed";
    state = "failed";
    const errText = (stderrData || stdoutData).trim();
    reason = errText
      ? `exited with code ${exitCode} after ${Math.round(runDurationMs / 1000)}s: ${errText.split(/\r?\n/).filter(l => l.trim()).slice(-8).join("\n").slice(-800)}`
      : `${isAgy ? "agy" : agentName} exited with code ${exitCode} after ${Math.round(runDurationMs / 1000)}s with no output (not treated as quota; retryable)`;
  } else if (exitCode !== 0) {
    status = "failed";
    state = "failed";
    const errText = (stderrData || stdoutData).trim();
    reason = `exited with code ${exitCode}${errText ? `: ${errText.split(/\r?\n/).filter(l => l.trim()).slice(-5).join("\n").slice(-500)}` : ""}`;
  }

  const extractedSessionId = useSdkStreamParser
    ? (sdkParser?.getConversationId() ?? undefined)
    : (sessionTrackerRef?.getBoundConversationId() || extractSessionIdFromOutput(stdoutData));
  const finalSessionId = extractedSessionId || targetSessionToResume;
  if (finalSessionId) {
    recordSession(currentRoot, taskId, finalSessionId, effectiveAccountAlias);
    if (sessionId) {
      recordSession(currentRoot, sessionId, finalSessionId, effectiveAccountAlias);
    }
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
    reasoningEffort,
    finalSessionId || sessionId,
    poolProfile ? `${poolProfile.alias}${accountEmail ? ` <${accountEmail}>` : ""} (custom pool)`
      : accountSel?.pool === "default" ? `${accountEmail || "default HOME"} (default pool)` : undefined
  );

  const combinedRawOutput = `${stdoutData}\n${stderrData}`;
  const heuristicPrUrl = extractPrUrl(combinedRawOutput) || null;
  const heuristicSummary = extractExecutionSummary(stdoutData, stderrData) || reason || "";
  const { report: finalReport, report_source: finalReportSource, validation_error: reportValErr } =
    readOrFallbackTaskReport(taskReportDir, {
      state: isTimeout ? "timeout" : state,
      prUrl: heuristicPrUrl,
      summaryText: heuristicSummary,
      reason,
      rawOutput: combinedRawOutput,
    });
  if (reportValErr) {
    logWorker("WARN", `Task ${taskId}: report.json validation failed (${reportValErr}); fell back to heuristic.`);
  }
  const finalPrUrl = finalReport.pr_url || heuristicPrUrl;
  if (!finalReport.pr_url && finalPrUrl) {
    finalReport.pr_url = finalPrUrl;
  }
  const finalStage = deriveStage({
    state: isTimeout ? "timeout" : state,
    status,
    reason,
    report: finalReport,
    outcome: finalReport.outcome,
    pr_url: finalPrUrl,
    question: finalReport.question,
  });

  writeStatus(currentRoot, taskId, {
    state,
    stage: finalStage,
    agent: agentName,
    model,
    reasoningEffort,
    account: effectiveAccountAlias,
    startedAt,
    finishedAt,
    exitCode: state === "cancelled" ? (exitCode ?? 1) : exitCode,
    ...(slackStartTs ? { slackMessageTs: slackStartTs } : {}),
    ...(finalSessionId || sessionId ? { sessionId: finalSessionId || sessionId } : {}),
    ...(reason ? { reason } : {}),
    logPath: taskOutFilePath,
    workDir: effectiveWorkingDir,
    lastActivityAt: finishedAt,
    activity: "idle",
    last_activity_at: finishedAt,
    idle_seconds: 0,
    activity_source: state === "cancelled" ? "cancelled" : (sdkParser?.hasStructuredEvents() ? sdkParser.getLastActivitySource() : "none"),
    ...(state === "failed" ? { logTail: (stdoutData + (stderrData ? "\n[stderr]\n" + stderrData : "")).split(/\r?\n/).filter(l => l.trim()).slice(-15).join("\n").slice(-1500) || undefined } : {}),
    report: finalReport,
    report_source: finalReportSource,
    outcome: finalReport.outcome,
    pr_url: finalPrUrl,
    question: finalReport.question,
  });

  releaseAccount();
  process.removeListener("exit", releaseAccount);
  saveProcessedTask(processedMap, taskId, finishedAt);
  audit(currentRoot, { tool: "worker", taskId, agent: agentName, state, exitCode });
  logWorker("INFO", `Task ${taskId} finished with status "${status}" (exitCode=${exitCode})`);
  if (isNotifyEnabled) {
    if (isTimeout && notifyOn.has("timeout")) {
      notify("agent-bridge", `Task ${taskId} timed out after ${Math.round(effectiveHardTimeoutMs / 1000)}s [${agentName}]`, {
        subtitle: "执行超时警告",
        level: "warning",
        channel: notifyChannel,
        sound: notifySound,
      });
    } else if (state === "completed" && notifyOn.has("completed")) {
      notify("agent-bridge", `Task ${taskId} completed [${agentName}]`, {
        subtitle: "任务执行完成",
        level: "success",
        channel: notifyChannel,
        sound: notifySound,
      });
    } else if (state === "failed" && notifyOn.has("failed")) {
      notify("agent-bridge", `Task ${taskId} failed [${agentName}]`, {
        subtitle: "任务执行失败",
        level: "error",
        channel: notifyChannel,
        sound: notifySound,
      });
    } else if (state === "cancelled") {
      notify("agent-bridge", `Task ${taskId} cancelled (cancelled by request) [${agentName}]`, {
        subtitle: "任务已取消",
        level: "info",
        channel: notifyChannel,
        sound: notifySound,
      });
    }

    // Dispatch Slack lifecycle card if slackChannel or slackWebhookEnv is configured
    if (slackChannel || slackWebhookEnv) {
      if (!slackStartTs) {
        try {
          const currentStatus = readStatus(currentRoot, taskId);
          if (currentStatus?.slackMessageTs) {
            slackStartTs = currentStatus.slackMessageTs;
          }
        } catch {}
      }

      const durationSeconds = Math.max(1, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
      let slackEvent: "completed" | "failed" | "timeout" | "cancelled" = "completed";
      if (isTimeout) slackEvent = "timeout";
      else if (state === "failed") slackEvent = "failed";
      else if (state === "cancelled") slackEvent = "cancelled";

      // 1. Extract accurate, real output summary without fabrication
      const realSummary = extractExecutionSummary(stdoutData, stderrData);

      // 2. Extract error output for non-zero exit codes (last 20 lines)
      let rawErrorOutput = stderrData || "";
      if (!rawErrorOutput && fs.existsSync(taskOutFilePath)) {
        try {
          rawErrorOutput = fs.readFileSync(taskOutFilePath, "utf8");
        } catch {}
      }
      if (!rawErrorOutput && stdoutData) {
        rawErrorOutput = stdoutData;
      }

      // 3. Extract Git PR and commit links
      const gitLinks = extractGitLinks(stdoutData + "\n" + stderrData, projectRepo);
      if (effectiveWorkingDir && projectRepo) {
        try {
          const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: effectiveWorkingDir, encoding: "utf8" });
          if (gitHead.status === 0 && gitHead.stdout) {
            const gitHeadAfter = gitHead.stdout.trim();
            if (gitHeadBefore && gitHeadAfter && gitHeadBefore !== gitHeadAfter) {
              const cleanRepo = projectRepo.replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
              const commitUrl = `https://github.com/${cleanRepo}/commit/${gitHeadAfter}`;
              if (!gitLinks.some((l: { url: string }) => l.url === commitUrl)) {
                gitLinks.unshift({
                  type: "commit",
                  title: `Commit ${gitHeadAfter.slice(0, 7)}`,
                  url: commitUrl,
                });
              }
            }
          }
        } catch {}
      }

      await dispatchTaskLifecycleNotification(
        {
          taskId,
          event: slackEvent,
          projectName,
          repo: projectRepo,
          slackChannel,
          slackWebhookEnv,
          agent: agentName,
          model,
          durationSeconds,
          resultSummary: realSummary,
          errorDetails: rawErrorOutput,
          exitCode: exitCode ?? (slackEvent === "completed" ? 0 : 1),
          logFilePath: taskOutFilePath,
          gitLinks,
          updateTs: slackStartTs,
          desktop: false,
        },
        logWorker
      );
    }
  }

  // Dispatch completion callback on terminal states (completed/failed/timeout/cancelled/stuck)
  if (callbackUrl) {
    const callbackDuration = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
    let terminalStatus: "completed" | "failed" | "timeout" | "cancelled" | "stuck" = "completed";
    if (isTimeout) terminalStatus = "timeout";
    else if (state === "cancelled") terminalStatus = "cancelled";
    else if (state === "failed") terminalStatus = "failed";

    sendCompletionCallback({
      url: callbackUrl,
      headers: callbackHeaders,
      allowedEnv: matchedTaskProj?.allowed_env,
      taskId,
      agent: agentName,
      status: terminalStatus,
      stage: finalStage,
      outcome: finalReport.outcome,
      question: finalReport.question,
      prUrl: finalPrUrl,
      exitCode: exitCode !== null ? exitCode : (terminalStatus === "completed" ? 0 : 1),
      durationSeconds: callbackDuration,
      resultPath: path.join(resultsDir, `${taskId}.md`),
      logPath: taskOutFilePath,
      outputLog: stdoutData + "\n" + stderrData,
      project: projectName || projectId,
      rootDir: currentRoot,
      logger: logWorker,
    }).catch(() => {});
  }

  // Trigger task chains on_success
  if (state === "completed" && onSuccess) {
    try {
      const nextTasks = Array.isArray(onSuccess) ? onSuccess : [onSuccess];
      for (const nextItem of nextTasks) {
        let nextPrompt = "";
        let nextTitle = "";
        let nextAgent = agentName;
        let nextModel = model;

        if (typeof nextItem === "string") {
          nextPrompt = nextItem;
          nextTitle = `Follow-up to ${taskId}`;
        } else if (nextItem && typeof nextItem === "object") {
          nextPrompt = nextItem.prompt;
          nextTitle = nextItem.title || `Follow-up to ${taskId}`;
          if (nextItem.agent) nextAgent = nextItem.agent;
          if (nextItem.model) nextModel = nextItem.model;
        }

        if (nextPrompt && nextPrompt.trim()) {
          const nextTaskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          const nextTaskPath = path.join(tasksDir, `${nextTaskId}.md`);
          let nextContent = `# ${nextTitle}\n\n`;
          nextContent += `- **Task ID**: ${nextTaskId}\n`;
          if (nextAgent) nextContent += `- **Agent**: ${nextAgent}\n`;
          if (projectId) nextContent += `- **Project ID**: ${projectId}\n`;
          if (projectName) nextContent += `- **Project Name**: ${projectName}\n`;
          if (projectRepo) nextContent += `- **Project Repo**: ${projectRepo}\n`;
          if (projectDir) nextContent += `- **Project Dir**: ${projectDir}\n`;
          if (slackChannel) nextContent += `- **Slack Channel**: ${slackChannel}\n`;
          if (slackStartTs) nextContent += `- **Slack Thread**: ${slackStartTs}\n`;
          if (nextModel) nextContent += `- **Model**: ${nextModel}\n`;
          nextContent += `- **Created At**: ${new Date().toISOString()}\n\n---\n\n## Prompt\n\n${nextPrompt}\n`;

          fs.writeFileSync(nextTaskPath, nextContent, "utf8");
          logWorker("INFO", `Task chain triggered: created follow-up task ${nextTaskId} for parent ${taskId}`);
        }
      }
    } catch (chainErr: any) {
      logWorker("WARN", `Failed to trigger on_success chain for task ${taskId}: ${chainErr?.message || String(chainErr)}`);
    }
  }

  // Hook auto-queue dispatcher on task completion/failure
  try {
    onTaskFinished(currentRoot, taskId, state, finalSessionId || sessionId, reason);
  } catch (queueErr: any) {
    logWorker("WARN", `Queue dispatch hook error on task ${taskId}: ${queueErr?.message || String(queueErr)}`);
  }

  // Trigger opt-in per-task completion webhook (NEVER blocks queue advance)
  try {
    const elapsedMs = startedAt && finishedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : undefined;
    const webhookTerminal = isTimeout ? "timeout" : state;
    triggerTaskWebhook(currentRoot, taskId, webhookTerminal, finalSessionId || sessionId, elapsedMs).catch(() => {});
  } catch (webhookErr: any) {
    logWorker("WARN", `Webhook trigger error on task ${taskId}: ${webhookErr?.message || String(webhookErr)}`);
  }

  return true;
}

// Worker service loop
export class WorkerService {
  private isRunning = false;
  private isShuttingDown = false;
  private processedMap: Record<string, string>;
  private sleepResolve: (() => void) | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<boolean>>();

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

    try {
      reconcileAllTasks(this.root);
    } catch {}

    const starters: Promise<boolean>[] = [];
    for (const file of files) {
      if (this.isShuttingDown) break;
      let job!: Promise<boolean>;
      job = processTaskFile(
        file,
        tasksDir,
        resultsDir,
        this.processedMap,
        registry,
        this.timeout,
        this.root
      )
        .catch((err: any) => {
          logWorker("ERROR", `Unexpected error handling task file "${file}": ${err?.message || String(err)}`);
          return false;
        })
        .finally(() => {
          this.inFlight.delete(job);
        });
      this.inFlight.add(job);
      starters.push(job);
    }

    return starters.length;
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

    // Mark ghost tasks (running status but owning worker/agent process gone) as failed
    try {
      const fixed = reconcileAllTasks(this.root, { graceMs: 0 });
      if (fixed.length) logWorker("WARN", `Reconciled ${fixed.length} ghost task(s) on startup: ${fixed.join(", ")}`);
    } catch {}

    // Reconcile queues on worker startup (dispatch items whose triggers already finished)
    try {
      reconcileQueues(this.root);
    } catch (reconcileErr: any) {
      logWorker("WARN", `Queue reconcile error on startup: ${reconcileErr?.message || String(reconcileErr)}`);
    }

    while (this.isRunning && !this.isShuttingDown) {
      await this.scanOnce();
      if (!this.isRunning || this.isShuttingDown) break;
      await this.interruptibleSleep(this.pollInterval);
    }

    if (this.inFlight.size > 0) {
      logWorker("INFO", `Waiting for ${this.inFlight.size} in-flight task(s) to finish...`);
      await Promise.allSettled([...this.inFlight]);
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
