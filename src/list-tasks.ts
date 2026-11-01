import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import {
  deriveStage,
  type TaskStage,
  type TaskOutcome,
  type ReportSource,
} from "./task-stage.js";

export interface TaskSummaryItem {
  taskId: string;
  state: string;
  stage: TaskStage;
  outcome?: TaskOutcome;
  question?: string | null;
  pr_url?: string | null;
  report_source?: ReportSource;
  projectId?: string;
  projectName?: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
}

export function registerListTasksTool(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  server.tool(
    "list_tasks_summary",
    "List recent task execution summaries without returning prompt, result, or log bodies.",
    {
      limit: z.number().int().optional().describe("Maximum number of tasks to return (1-50, default 20)"),
      project_id: z.string().optional().describe("Optional project ID or name to filter tasks by"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ limit, project_id }) => {
      audit(rootDir, { tool: "list_tasks_summary" });

      const rawLimit = typeof limit === "number" && !Number.isNaN(limit) ? limit : 20;
      const effectiveLimit = Math.max(1, Math.min(50, Math.floor(rawLimit)));
      const filterProj = project_id?.trim().toLowerCase();

      const statusDir = path.join(rootDir, "status");
      const tasksDir = path.join(rootDir, "tasks");
      const items: TaskSummaryItem[] = [];

      try {
        if (fs.existsSync(statusDir)) {
          const files = fs.readdirSync(statusDir);
          for (const file of files) {
            if (!file.endsWith(".json") || file.includes(".tmp") || file.startsWith("_")) {
              continue;
            }
            const filePath = path.join(statusDir, file);
            try {
              const content = fs.readFileSync(filePath, "utf8");
              const parsed = JSON.parse(content);
              if (parsed && typeof parsed === "object") {
                const taskId = typeof parsed.taskId === "string" ? parsed.taskId : file.replace(/\.json$/, "");
                const stateVal = typeof parsed.state === "string" ? parsed.state : "unknown";
                const item: TaskSummaryItem = {
                  taskId,
                  state: stateVal,
                  stage: deriveStage(parsed),
                };
                if (parsed.outcome || parsed.report?.outcome) {
                  item.outcome = parsed.outcome || parsed.report?.outcome;
                }
                if (parsed.question !== undefined || parsed.report?.question !== undefined) {
                  item.question = parsed.question ?? parsed.report?.question ?? null;
                }
                if (parsed.pr_url !== undefined || parsed.report?.pr_url !== undefined) {
                  item.pr_url = parsed.pr_url ?? parsed.report?.pr_url ?? null;
                }
                if (parsed.report_source) {
                  item.report_source = parsed.report_source;
                }
                if (typeof parsed.projectId === "string" && parsed.projectId) item.projectId = parsed.projectId;
                if (typeof parsed.projectName === "string" && parsed.projectName) item.projectName = parsed.projectName;

                if (!item.projectId || !item.projectName) {
                  const tf = path.join(tasksDir, `${taskId}.md`);
                  if (fs.existsSync(tf)) {
                    try {
                      const tc = fs.readFileSync(tf, "utf8");
                      const idM = tc.match(/^-[ \t]*\*\*Project ID\*\*:[ \t]*([^\r\n]*)$/im);
                      const nameM = tc.match(/^-[ \t]*\*\*Project Name\*\*:[ \t]*([^\r\n]*)$/im);
                      if (!item.projectId && idM) item.projectId = idM[1].trim();
                      if (!item.projectName && nameM) item.projectName = nameM[1].trim();
                    } catch {}
                  }
                }

                if (filterProj) {
                  const pId = (item.projectId || "").toLowerCase();
                  const pName = (item.projectName || "").toLowerCase();
                  if (pId !== filterProj && pName !== filterProj) {
                    continue;
                  }
                }

                if (typeof parsed.agent === "string") item.agent = parsed.agent;
                if (typeof parsed.model === "string") item.model = parsed.model;
                if (typeof parsed.reasoningEffort === "string") item.reasoningEffort = parsed.reasoningEffort;
                if (typeof parsed.startedAt === "string") item.startedAt = parsed.startedAt;
                if (typeof parsed.finishedAt === "string") item.finishedAt = parsed.finishedAt;
                if (typeof parsed.exitCode === "number" || parsed.exitCode === null) {
                  item.exitCode = parsed.exitCode;
                }
                items.push(item);
              }
            } catch (err: any) {
              logger.warn(`list_tasks_summary: skipping corrupt status file ${file}: ${err?.message || String(err)}`);
            }
          }
        }
      } catch (err: any) {
        logger.error(`list_tasks_summary: error reading status directory: ${err?.message || String(err)}`);
      }

      // Sort by startedAt descending (newest first)
      items.sort((a, b) => {
        const timeA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const timeB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return timeB - timeA;
      });

      const sliced = items.slice(0, effectiveLimit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(sliced, null, 2),
          },
        ],
      };
    }
  );
}
