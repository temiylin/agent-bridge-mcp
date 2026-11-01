import { reconcileTaskStatus } from "./task-reconcile.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { listAllSessionQueues, SessionQueueState } from "./queue.js";
import {
  deriveStage,
  type TaskStage,
  type TaskReport,
  type TaskOutcome,
  type ReportSource,
} from "./task-stage.js";

export interface RecentTaskItem {
  taskId: string;
  status: "running" | "completed" | "failed" | "queued" | "paused" | "paused_quota" | "cancelled";
  stage: TaskStage;
  outcome?: TaskOutcome;
  question?: string | null;
  report?: TaskReport;
  report_source?: ReportSource;
  hasFollowUp?: boolean;
  pr_open?: boolean;
  session_id?: string;
  project?: string;
  project_id?: string;
  project_name?: string;
  agent?: string;
  model?: string;
  account?: string;
  workDir?: string;
  elapsed?: string;
  last_activity_at?: string;
  created_at?: string;
  finished_at?: string;
  pr_url?: string;
  last_log_line?: string;
  plan_id?: string;
  step_id?: string;
  plan_title?: string;
  /** Raw task state when it differs from status (e.g. suspected_stalled, cancelled). */
  state?: string;
  reason?: string;
}

/**
 * Formats duration in seconds into a compact human-readable elapsed string (e.g., '5s', '2m 10s', '1h 5m').
 */
export function formatElapsedSeconds(seconds: number): string {
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

/**
 * Reads the last non-empty line of a file, truncated to ~120 chars.
 */
export function getLastLogLine(filePath: string, maxChars: number = 120): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return "";
    // Read up to last 4096 bytes
    const readLen = Math.min(stat.size, 4096);
    const startOffset = stat.size - readLen;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(readLen);
    try {
      fs.readSync(fd, buf, 0, readLen, startOffset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return "";
    const lastLine = lines[lines.length - 1];
    if (lastLine.length <= maxChars) return lastLine;
    return lastLine.slice(0, maxChars - 3) + "...";
  } catch {
    return undefined;
  }
}

/**
 * Extracts PR url from text if present.
 */
export function extractPrUrl(text: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i);
  return match ? match[0] : undefined;
}

/**
 * Collects and filters recent tasks from status/, tasks/, results/, and queue/.
 */
export function queryRecentTasks(
  rootDir: string,
  filter?: {
    limit?: number;
    status?: string;
    project?: string;
    session_id?: string;
    plan_id?: string;
  }
): RecentTaskItem[] {
  const limit = Math.max(1, Math.min(100, filter?.limit || 20));
  const statusDir = path.join(rootDir, "status");
  const tasksDir = path.join(rootDir, "tasks");
  const logsDir = path.join(rootDir, "logs");
  const resultsDir = path.join(rootDir, "results");

  const items: RecentTaskItem[] = [];
  const now = Date.now();

  // 1. Process tasks from status/
  if (fs.existsSync(statusDir)) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(statusDir);
    } catch {}

    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp") || file.startsWith("_")) continue;
      const statusFilePath = path.join(statusDir, file);
      try {
        const raw = fs.readFileSync(statusFilePath, "utf8");
        let statusObj = JSON.parse(raw);
        if (!statusObj) continue;
        if (statusObj.state === "running" || statusObj.state === "suspected_stalled") {
          statusObj = reconcileTaskStatus(rootDir, { taskId: file.replace(/\.json$/, ""), ...statusObj });
        }

        const taskId = statusObj.taskId || file.replace(/\.json$/, "");
        let stateStr = statusObj.state as string;
        let mappedStatus: RecentTaskItem["status"] = "queued";
        if (stateStr === "running" || stateStr === "suspected_stalled") mappedStatus = "running";
        else if (stateStr === "completed") mappedStatus = "completed";
        else if (stateStr === "paused_quota") mappedStatus = "paused_quota";
        else if (stateStr === "cancelled") mappedStatus = "cancelled";
        else if (stateStr === "failed") mappedStatus = "failed";
        else mappedStatus = "queued";

        // Read metadata from tasks/<taskId>.md
        let sessionId = statusObj.sessionId;
        let projectId: string | undefined = statusObj.projectId;
        let projectName: string | undefined = statusObj.projectName;
        let project: string | undefined = projectName || projectId;
        let prUrl: string | undefined = (statusObj.pr_url ?? statusObj.report?.pr_url) || undefined;
        let createdAt: string | undefined = undefined;
        let taskAgent: string | undefined = statusObj.agent;
        let taskModel: string | undefined = statusObj.model;
        let taskAccount: string | undefined = statusObj.account;
        let planId: string | undefined = statusObj.plan_id || statusObj.planId;
        let stepId: string | undefined = statusObj.step_id || statusObj.stepId;
        let planTitle: string | undefined = statusObj.plan_title || statusObj.planTitle;

        const taskFilePath = path.join(tasksDir, `${taskId}.md`);
        if (fs.existsSync(taskFilePath)) {
          try {
            const taskContent = fs.readFileSync(taskFilePath, "utf8");
            if (!sessionId) {
              const sMatch = taskContent.match(/- \*\*Session ID\*\*:\s*([^\r\n]+)/i);
              if (sMatch) sessionId = sMatch[1].trim();
            }
            const idMatch = taskContent.match(/- \*\*Project ID\*\*:\s*([^\r\n]+)/i);
            if (idMatch && !projectId) projectId = idMatch[1].trim();
            const pMatch = taskContent.match(/- \*\*Project(?:\s*Name)?\*\*:\s*([^\r\n]+)/i);
            if (pMatch && !projectName) projectName = pMatch[1].trim();
            if (!project) project = projectName || projectId;
            const cMatch = taskContent.match(/- \*\*Created At\*\*:\s*([^\r\n]+)/i);
            if (cMatch) createdAt = cMatch[1].trim();
            if (!taskAgent) {
              const aMatch = taskContent.match(/- \*\*Agent\*\*:\s*([^\r\n]+)/i);
              if (aMatch) taskAgent = aMatch[1].trim();
            }
            if (!taskModel) {
              const mMatch = taskContent.match(/- \*\*Model\*\*:\s*([^\r\n]+)/i);
              if (mMatch) taskModel = mMatch[1].trim();
            }
            if (!taskAccount) {
              const accMatch = taskContent.match(/- \*\*Account\*\*:\s*([^\r\n]+)/i);
              if (accMatch) taskAccount = accMatch[1].trim();
            }
            if (!planId) {
              const planMatch = taskContent.match(/- \*\*Plan ID\*\*:\s*([^\r\n]+)/i);
              if (planMatch) planId = planMatch[1].trim();
            }
            if (!stepId) {
              const stepMatch = taskContent.match(/- \*\*Plan Step ID\*\*:\s*([^\r\n]+)/i);
              if (stepMatch) stepId = stepMatch[1].trim();
            }
            if (!planTitle) {
              const titleMatch = taskContent.match(/- \*\*Plan Title\*\*:\s*([^\r\n]+)/i);
              if (titleMatch) planTitle = titleMatch[1].trim();
            }
          } catch {}
        }

        if (!createdAt) {
          const idMatch = taskId.match(/^task_(\d{13})/);
          if (idMatch) {
            const ts = parseInt(idMatch[1], 10);
            if (!isNaN(ts) && ts > 1000000000000) {
              createdAt = new Date(ts).toISOString();
            }
          }
        }

        // Check elapsed for running tasks or finished_at
        let elapsed: string | undefined = undefined;
        let finished_at: string | undefined = statusObj.finishedAt;

        if (mappedStatus === "running" && statusObj.startedAt) {
          const startedMs = new Date(statusObj.startedAt).getTime();
          if (!isNaN(startedMs)) {
            const sec = Math.max(0, Math.floor((now - startedMs) / 1000));
            elapsed = formatElapsedSeconds(sec);
          }
        }

        // Get last log line from logs/<taskId>.out and last activity timestamp
        const outFilePath = path.join(logsDir, `${taskId}.out`);
        let lastLogLine = getLastLogLine(outFilePath, 120);
        let lastActivityAt: string | undefined = statusObj.lastActivityAt;
        if (!lastActivityAt && fs.existsSync(outFilePath)) {
          try {
            const stat = fs.statSync(outFilePath);
            lastActivityAt = stat.mtime.toISOString();
          } catch {}
        }
        if (!lastActivityAt) {
          lastActivityAt = finished_at || statusObj.startedAt || createdAt;
        }

        // Check for PR URL in out log or result file if not already in status/report
        if (!prUrl && fs.existsSync(outFilePath)) {
          try {
            const outContent = fs.readFileSync(outFilePath, "utf8");
            prUrl = extractPrUrl(outContent);
          } catch {}
        }
        if (!prUrl || !lastLogLine) {
          const resPath = path.join(resultsDir, `${taskId}.md`);
          if (fs.existsSync(resPath)) {
            try {
              const resContent = fs.readFileSync(resPath, "utf8");
              if (!prUrl) prUrl = extractPrUrl(resContent);
              if (!lastLogLine) {
                // If no .out log, extract from result output
                const outMatch = resContent.match(/## Output\s*\n([\s\S]*?)(?:\n## Error Details|$)/i);
                if (outMatch) {
                  const outLines = outMatch[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  if (outLines.length > 0) {
                    const l = outLines[outLines.length - 1];
                    lastLogLine = l.length <= 120 ? l : l.slice(0, 117) + "...";
                  }
                }
              }
            } catch {}
          }
        }

        // Apply filters
        if (filter?.status && mappedStatus !== filter.status) continue;
        if (filter?.session_id && sessionId !== filter.session_id) continue;
        if (filter?.plan_id && planId !== filter.plan_id) continue;
        if (filter?.project) {
          const fp = filter.project.trim().toLowerCase();
          const matchProj =
            (project && project.toLowerCase() === fp) ||
            (projectId && projectId.toLowerCase() === fp) ||
            (projectName && projectName.toLowerCase() === fp);
          if (!matchProj) continue;
        }

        const effectiveOutcome: TaskOutcome | undefined =
          statusObj.outcome ||
          statusObj.report?.outcome ||
          (stateStr === "completed" ? "ready" : undefined);
        const effectiveQuestion: string | null | undefined =
          statusObj.question !== undefined
            ? statusObj.question
            : statusObj.report?.question !== undefined
              ? statusObj.report.question
              : undefined;
        const derivedStage = deriveStage({
          state: stateStr,
          status: mappedStatus,
          reason: statusObj.reason,
          hasFollowUp: statusObj.hasFollowUp,
          report: statusObj.report,
          outcome: effectiveOutcome,
          pr_url: prUrl || null,
          question: effectiveQuestion ?? null,
          pr_open: statusObj.pr_open,
        });

        items.push({
          taskId,
          status: mappedStatus,
          stage: derivedStage,
          ...(effectiveOutcome ? { outcome: effectiveOutcome } : {}),
          ...(effectiveQuestion !== undefined ? { question: effectiveQuestion } : {}),
          ...(statusObj.report ? { report: statusObj.report } : {}),
          ...(statusObj.report_source ? { report_source: statusObj.report_source } : {}),
          ...(statusObj.hasFollowUp !== undefined ? { hasFollowUp: statusObj.hasFollowUp } : {}),
          ...(statusObj.pr_open !== undefined ? { pr_open: statusObj.pr_open } : {}),
          session_id: sessionId,
          project,
          ...(projectId ? { project_id: projectId } : {}),
          ...(projectName ? { project_name: projectName } : {}),
          agent: taskAgent,
          model: taskModel,
          account: taskAccount,
          workDir: statusObj.workDir,
          elapsed,
          last_activity_at: lastActivityAt,
          created_at: createdAt,
          finished_at,
          pr_url: prUrl,
          last_log_line: lastLogLine,
          ...(planId ? { plan_id: planId } : {}),
          ...(stepId ? { step_id: stepId } : {}),
          ...(planTitle ? { plan_title: planTitle } : {}),
          ...(stateStr !== mappedStatus ? { state: stateStr } : {}),
          ...(statusObj.reason && mappedStatus !== "completed" ? { reason: String(statusObj.reason).slice(0, 300) } : {}),
        });
      } catch {}
    }
  }

  // 2. Process queued and paused items from queue/
  const queueStates = listAllSessionQueues(rootDir);
  for (const q of queueStates) {
    if (filter?.session_id && q.session_id !== filter.session_id) continue;

    for (const item of q.items) {
      if (item.status === "dispatched") continue; // Already covered in status/

      let itemStatus: RecentTaskItem["status"] = q.paused ? "paused" : "queued";
      if (filter?.status && itemStatus !== filter.status) continue;

      const projectId = item.options?.project_id || item.options?.project;
      const projectName = item.options?.projectName || projectId;
      const project = projectName || projectId;
      if (filter?.project) {
        const fp = filter.project.trim().toLowerCase();
        const matchProj =
          (project && String(project).toLowerCase() === fp) ||
          (projectId && String(projectId).toLowerCase() === fp) ||
          (projectName && String(projectName).toLowerCase() === fp);
        if (!matchProj) continue;
      }

      const lastLogLine = item.prompt ? `[queued prompt] ${item.prompt.slice(0, 80).replace(/\r?\n/g, " ")}` : undefined;

      items.push({
        taskId: item.id,
        status: itemStatus,
        stage: deriveStage({ state: itemStatus, status: itemStatus }),
        session_id: q.session_id,
        project,
        ...(projectId ? { project_id: projectId } : {}),
        ...(projectName ? { project_name: projectName } : {}),
        agent: item.options?.agent,
        model: item.options?.model,
        account: item.options?.account,
        created_at: item.created_at,
        last_log_line: lastLogLine,
      });
    }
  }

  // 3. Sort: running tasks first, then by finished_at/created_at descending
  items.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    const timeA = (a.finished_at ? new Date(a.finished_at).getTime() : 0) || (a.created_at ? new Date(a.created_at).getTime() : 0);
    const timeB = (b.finished_at ? new Date(b.finished_at).getTime() : 0) || (b.created_at ? new Date(b.created_at).getTime() : 0);
    return timeB - timeA;
  });

  return items.slice(0, limit);
}

export function registerRecentTasksTool(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  const toolDefinition = {
    limit: z.number().int().optional().describe("Maximum number of tasks to return (default 20, max 100)"),
    status: z.enum(["running", "completed", "failed", "queued", "paused", "cancelled"]).optional().describe("Filter by task status"),
    project: z.string().optional().describe("Filter by project identifier"),
    session_id: z.string().optional().describe("Filter by topic / session ID"),
    plan_id: z.string().optional().describe("Filter by plan ID"),
  };

  const handler = async ({ limit, status, project, session_id, plan_id }: {
    limit?: number;
    status?: "running" | "completed" | "failed" | "queued" | "paused" | "cancelled";
    project?: string;
    session_id?: string;
    plan_id?: string;
  }) => {
    try {
      audit(rootDir, { tool: "list_recent_tasks" });
      const recent = queryRecentTasks(rootDir, {
        limit,
        status,
        project: project?.trim(),
        session_id: session_id?.trim(),
        plan_id: plan_id?.trim(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(recent, null, 2),
          },
        ],
      };
    } catch (err: any) {
      logger.error(`list_recent_tasks error: ${err?.message || String(err)}`);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error retrieving recent tasks: ${err?.message || String(err)}` }],
      };
    }
  };

  // Register primary name: list_recent_tasks
  server.tool(
    "list_recent_tasks",
    "List recent tasks and queue status in compact form (topic/session_id, taskId, status, elapsed/finished_at, PR URL, last log line ~120 chars).",
    toolDefinition,
    { readOnlyHint: true, destructiveHint: false },
    handler
  );

  // Register alias: dashboard
  server.tool(
    "dashboard",
    "Dashboard overview of recent tasks and queued items in compact form (alias for list_recent_tasks).",
    toolDefinition,
    { readOnlyHint: true, destructiveHint: false },
    handler
  );
}
