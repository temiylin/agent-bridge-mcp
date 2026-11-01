import fs from "node:fs";
import path from "node:path";
import { isValidTaskId, resolveSafePath } from "./validator.js";
import {
  deriveStage,
  type TaskStage,
  type TaskReport,
  type ReportSource,
  type TaskOutcome,
} from "./task-stage.js";

export type TaskState = "queued" | "running" | "suspected_stalled" | "completed" | "failed" | "cancelled" | "paused_quota";

/** States in which a task is believed to still be executing. */
export const ACTIVE_STATES: TaskState[] = ["running", "suspected_stalled"];

export interface TaskStatusInfo {
  taskId?: string;
  state: TaskState;
  stage?: TaskStage;
  projectId?: string;
  projectName?: string;
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
  /** Structured or heuristic report */
  report?: TaskReport;
  report_source?: ReportSource;
  outcome?: TaskOutcome;
  pr_url?: string | null;
  question?: string | null;
  pr_open?: boolean;
  hasFollowUp?: boolean;
  plan_id?: string;
  step_id?: string;
  plan_version?: number;
  plan_title?: string;
  planId?: string;
  stepId?: string;
  planVersion?: number;
  planTitle?: string;
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
    if ( fs.existsSync(targetPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(targetPath, "utf8")) as TaskStatusInfo;
        if (ACTIVE_STATES.includes(info.state) && existing && existing.state === "cancelled") {
          return;
        }
        if (!info.projectId && existing?.projectId) info.projectId = existing.projectId;
        if (!info.projectName && existing?.projectName) info.projectName = existing.projectName;
        if (!info.report && existing?.report) info.report = existing.report;
        if (!info.report_source && existing?.report_source) info.report_source = existing.report_source;
        if (info.hasFollowUp === undefined && existing?.hasFollowUp !== undefined) {
          info.hasFollowUp = existing.hasFollowUp;
        }
        if (info.pr_open === undefined && existing?.pr_open !== undefined) {
          info.pr_open = existing.pr_open;
        }
        const exAny = existing as any;
        if (!info.plan_id && !info.planId && (exAny?.plan_id || exAny?.planId)) {
          info.plan_id = exAny.plan_id || exAny.planId;
        }
        if (!info.step_id && !info.stepId && (exAny?.step_id || exAny?.stepId)) {
          info.step_id = exAny.step_id || exAny.stepId;
        }
        if (info.plan_version === undefined && info.planVersion === undefined && (exAny?.plan_version !== undefined || exAny?.planVersion !== undefined)) {
          info.plan_version = exAny.plan_version !== undefined ? exAny.plan_version : exAny.planVersion;
        }
        if (!info.plan_title && !info.planTitle && (exAny?.plan_title || exAny?.planTitle)) {
          info.plan_title = exAny.plan_title || exAny.planTitle;
        }
      } catch {}
    }

  const computedStage =
    info.stage ||
    deriveStage({
      state: info.state,
      reason: info.reason,
      hasFollowUp: info.hasFollowUp,
      report: info.report,
      outcome: info.outcome ?? info.report?.outcome,
      pr_url: info.pr_url ?? info.report?.pr_url,
      question: info.question ?? info.report?.question,
      pr_open: info.pr_open,
    });

  const payload: TaskStatusInfo = {
    taskId,
    state: info.state,
    stage: computedStage,
    ...(info.projectId ? { projectId: info.projectId } : {}),
    ...(info.projectName ? { projectName: info.projectName } : {}),
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
    ...(info.report ? { report: info.report } : {}),
    ...(info.report_source ? { report_source: info.report_source } : {}),
    ...(info.outcome !== undefined ? { outcome: info.outcome } : (info.report?.outcome ? { outcome: info.report.outcome } : {})),
    ...(info.pr_url !== undefined ? { pr_url: info.pr_url } : (info.report?.pr_url ? { pr_url: info.report.pr_url } : {})),
    ...(info.question !== undefined ? { question: info.question } : (info.report?.question ? { question: info.report.question } : {})),
    ...(info.pr_open !== undefined ? { pr_open: info.pr_open } : {}),
    ...(info.hasFollowUp !== undefined ? { hasFollowUp: info.hasFollowUp } : {}),
    ...(info.plan_id || info.planId ? { plan_id: info.plan_id || info.planId } : {}),
    ...(info.step_id || info.stepId ? { step_id: info.step_id || info.stepId } : {}),
    ...(info.plan_version !== undefined || info.planVersion !== undefined
      ? { plan_version: info.plan_version !== undefined ? info.plan_version : info.planVersion }
      : {}),
    ...(info.plan_title || info.planTitle ? { plan_title: info.plan_title || info.planTitle } : {}),
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
