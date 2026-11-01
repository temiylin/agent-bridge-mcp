import fs from "node:fs";
import path from "node:path";
import { isValidTaskId, resolveSafePath } from "./validator.js";

export type TaskState = "queued" | "running" | "suspected_stalled" | "completed" | "failed" | "cancelled" | "paused_quota";

/** States in which a task is believed to still be executing. */
export const ACTIVE_STATES: TaskState[] = ["running", "suspected_stalled"];

export interface TaskStatusInfo {
  taskId?: string;
  state: TaskState;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  account?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  reason?: string;
  slackMessageTs?: string;
  sessionId?: string;
  /** Agent child process pid. */
  pid?: number;
  /** Worker (relay) process pid that owns the child. */
  workerPid?: number;
  logPath?: string;
  workDir?: string;
  lastActivityAt?: string;
  /** Activity status: active or idle */
  activity?: "active" | "idle";
  /** Last activity timestamp in ISO format */
  last_activity_at?: string;
  /** Idle duration in seconds */
  idle_seconds?: number;
  /** Activity signal source: stdout | stderr | session_log | cpu | workdir | none */
  activity_source?: string;
  /** Last lines of the task log when the task failed or stalled. */
  logTail?: string;
}

export function getStatusDir(root: string): string {
  const statusDir = path.join(root, "status");
  if (!fs.existsSync(statusDir)) {
    fs.mkdirSync(statusDir, { recursive: true });
  }
  return statusDir;
}

/**
 * Atomically writes status file to $AGENT_BRIDGE_ROOT/status/<taskId>.json via .tmp rename.
 */
export function writeStatus(
  root: string,
  taskId: string,
  info: TaskStatusInfo
): void {
  if (!isValidTaskId(taskId)) {
    throw new Error(`Invalid taskId for status write: "${taskId}"`);
  }

  const statusDir = getStatusDir(root);
  const targetPath = resolveSafePath(statusDir, root, `${taskId}.json`);
  const tmpPath = resolveSafePath(statusDir, root, `${taskId}.json.tmp`);

  // Prevent active/non-terminal status refreshes (running / suspected_stalled) from overwriting
  // an already persisted "cancelled" terminal state.
  if (ACTIVE_STATES.includes(info.state) && fs.existsSync(targetPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(targetPath, "utf8")) as TaskStatusInfo;
      if (existing && existing.state === "cancelled") {
        return;
      }
    } catch {}
  }

  const payload: TaskStatusInfo = {
    taskId,
    state: info.state,
    agent: info.agent || "",
    ...(info.model ? { model: info.model } : {}),
    ...(info.reasoningEffort ? { reasoningEffort: info.reasoningEffort } : {}),
    ...(info.account ? { account: info.account } : {}),
    startedAt: info.startedAt,
    finishedAt: info.finishedAt,
    exitCode: info.exitCode !== undefined ? info.exitCode : null,
    ...(info.reason ? { reason: info.reason } : {}),
    ...(info.slackMessageTs ? { slackMessageTs: info.slackMessageTs } : {}),
    ...(info.sessionId ? { sessionId: info.sessionId } : {}),
    ...(info.pid ? { pid: info.pid } : {}),
    ...(info.workerPid ? { workerPid: info.workerPid } : {}),
    ...(info.logPath ? { logPath: info.logPath } : {}),
    ...(info.workDir ? { workDir: info.workDir } : {}),
    ...(info.lastActivityAt ? { lastActivityAt: info.lastActivityAt } : {}),
    ...(info.activity ? { activity: info.activity } : {}),
    ...(info.last_activity_at ? { last_activity_at: info.last_activity_at } : (info.lastActivityAt ? { last_activity_at: info.lastActivityAt } : {})),
    ...(info.idle_seconds !== undefined ? { idle_seconds: info.idle_seconds } : {}),
    ...(info.activity_source ? { activity_source: info.activity_source } : {}),
    ...(info.logTail ? { logTail: info.logTail } : {}),
  };

  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Reads status file from $AGENT_BRIDGE_ROOT/status/<taskId>.json.
 * Returns null if the file does not exist.
 */
export function readStatus(root: string, taskId: string): TaskStatusInfo | null {
  if (!isValidTaskId(taskId)) {
    throw new Error(`Invalid taskId for status read: "${taskId}"`);
  }

  const statusDir = path.join(root, "status");
  if (!fs.existsSync(statusDir)) {
    return null;
  }

  let targetPath: string;
  try {
    targetPath = resolveSafePath(statusDir, root, `${taskId}.json`);
  } catch {
    return null;
  }

  if (!fs.existsSync(targetPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    return JSON.parse(raw) as TaskStatusInfo;
  } catch {
    return null;
  }
}
