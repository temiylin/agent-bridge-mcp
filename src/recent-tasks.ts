import { reconcileTaskStatus } from "./task-reconcile.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { listAllSessionQueues, SessionQueueState } from "./queue.js";

export interface RecentTaskItem {
  taskId: string;
  status: "running" | "completed" | "failed" | "queued" | "paused";
  session_id?: string;
  project?: string;
  elapsed?: string;
  finished_at?: string;
  pr_url?: string;
  last_log_line?: string;
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
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
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
        else if (stateStr === "failed" || stateStr === "cancelled") mappedStatus = "failed";
        else mappedStatus = "queued";

        // Read metadata from tasks/<taskId>.md
        let sessionId = statusObj.sessionId;
        let project: string | undefined = undefined;
        let prUrl: string | undefined = undefined;

        const taskFilePath = path.join(tasksDir, `${taskId}.md`);
        if (fs.existsSync(taskFilePath)) {
          try {
            const taskContent = fs.readFileSync(taskFilePath, "utf8");
            if (!sessionId) {
              const sMatch = taskContent.match(/- \*\*Session ID\*\*:\s*([^\r\n]+)/i);
              if (sMatch) sessionId = sMatch[1].trim();
            }
            const pMatch = taskContent.match(/- \*\*Project(?:\s*Name)?\*\*:\s*([^\r\n]+)/i);
            if (pMatch) project = pMatch[1].trim();
          } catch {}
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

        // Get last log line from logs/<taskId>.out
        const outFilePath = path.join(logsDir, `${taskId}.out`);
        let lastLogLine = getLastLogLine(outFilePath, 120);

        // Check for PR URL in out log or result file
        if (fs.existsSync(outFilePath)) {
          try {
            const outContent = fs.readFileSync(outFilePath, "utf8");
            prUrl = extractPrUrl(outContent);
          } catch {}
        }
        if (!prUrl) {
          const resPath = path.join(resultsDir, `${taskId}.md`);
          if (fs.existsSync(resPath)) {
            try {
              const resContent = fs.readFileSync(resPath, "utf8");
              prUrl = extractPrUrl(resContent);
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
        if (filter?.project && project !== filter.project) continue;

        items.push({
          taskId,
          status: mappedStatus,
          session_id: sessionId,
          project,
          elapsed,
          finished_at,
          pr_url: prUrl,
          last_log_line: lastLogLine,
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

      const project = item.options?.project || item.options?.projectName;
      if (filter?.project && project !== filter.project) continue;

      const lastLogLine = item.prompt ? `[queued prompt] ${item.prompt.slice(0, 80).replace(/\r?\n/g, " ")}` : undefined;

      items.push({
        taskId: item.id,
        status: itemStatus,
        session_id: q.session_id,
        project,
        last_log_line: lastLogLine,
      });
    }
  }

  // 3. Sort: running tasks first, then by finished_at/createdAt descending
  items.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    const timeA = a.finished_at ? new Date(a.finished_at).getTime() : 0;
    const timeB = b.finished_at ? new Date(b.finished_at).getTime() : 0;
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
    status: z.enum(["running", "completed", "failed", "queued", "paused"]).optional().describe("Filter by task status"),
    project: z.string().optional().describe("Filter by project identifier"),
    session_id: z.string().optional().describe("Filter by topic / session ID"),
  };

  const handler = async ({ limit, status, project, session_id }: {
    limit?: number;
    status?: "running" | "completed" | "failed" | "queued" | "paused";
    project?: string;
    session_id?: string;
  }) => {
    try {
      audit(rootDir, { tool: "list_recent_tasks" });
      const recent = queryRecentTasks(rootDir, {
        limit,
        status,
        project: project?.trim(),
        session_id: session_id?.trim(),
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
