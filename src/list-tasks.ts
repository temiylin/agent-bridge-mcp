import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

export interface TaskSummaryItem {
  taskId: string;
  state: string;
  agent?: string;
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
    },
    async ({ limit }) => {
      audit(rootDir, { tool: "list_tasks_summary" });

      const rawLimit = typeof limit === "number" && !Number.isNaN(limit) ? limit : 20;
      const effectiveLimit = Math.max(1, Math.min(50, Math.floor(rawLimit)));

      const statusDir = path.join(rootDir, "status");
      const items: TaskSummaryItem[] = [];

      try {
        if (fs.existsSync(statusDir)) {
          const files = fs.readdirSync(statusDir);
          for (const file of files) {
            if (!file.endsWith(".json") || file.includes(".tmp")) {
              continue;
            }
            const filePath = path.join(statusDir, file);
            try {
              const content = fs.readFileSync(filePath, "utf8");
              const parsed = JSON.parse(content);
              if (parsed && typeof parsed === "object") {
                const item: TaskSummaryItem = {
                  taskId: typeof parsed.taskId === "string" ? parsed.taskId : file.replace(/\.json$/, ""),
                  state: typeof parsed.state === "string" ? parsed.state : "unknown",
                };
                if (typeof parsed.agent === "string") item.agent = parsed.agent;
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
