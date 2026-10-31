import fs from "node:fs";
import path from "node:path";
import { isValidTaskId, resolveSafePath } from "./validator.js";

export type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "paused_quota";

export interface TaskStatusInfo {
  taskId?: string;
  state: TaskState;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  reason?: string;
  slackMessageTs?: string;
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

  const payload: TaskStatusInfo = {
    taskId,
    state: info.state,
    agent: info.agent || "",
    ...(info.model ? { model: info.model } : {}),
    ...(info.reasoningEffort ? { reasoningEffort: info.reasoningEffort } : {}),
    startedAt: info.startedAt,
    finishedAt: info.finishedAt,
    exitCode: info.exitCode !== undefined ? info.exitCode : null,
    ...(info.reason ? { reason: info.reason } : {}),
    ...(info.slackMessageTs ? { slackMessageTs: info.slackMessageTs } : {}),
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
