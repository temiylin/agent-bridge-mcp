import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeLogger } from "./logger.js";
import {
  setTaskWebhook,
  clearTaskWebhook,
  getTaskWebhook,
  WebhookEvent,
} from "./webhook.js";
import { isValidTaskId } from "./validator.js";

export function registerWebhookTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  /**
   * Tool: set_task_webhook
   * WARNING / OPT-IN NOTICE:
   * Opt-in per task; do not enable globally; only callers that have a webhook (e.g. Grok Bot) should pass on_complete.
   */
  server.tool(
    "set_task_webhook",
    "Attach an opt-in completion webhook to a specific task. Opt-in per task; do not enable globally; only callers that have a webhook (e.g. Grok Bot) should pass on_complete.",
    {
      taskId: z.string().describe("Task ID to attach completion webhook to"),
      on_complete: z
        .object({
          url: z.string().describe("Destination webhook URL (must be http/https)"),
          headers: z.record(z.string(), z.string()).optional().describe("Optional custom HTTP headers"),
          events: z.array(z.enum(["completed", "failed", "pr_opened"])).optional().describe("Events to trigger webhook on (default: ['completed', 'failed'])"),
          secret: z.string().optional().describe("Optional shared secret for HMAC-SHA256 signature in X-Agent-Bridge-Signature header"),
        })
        .describe("Opt-in webhook configuration for this specific task"),
    },
    async ({ taskId, on_complete }) => {
      try {
        if (!isValidTaskId(taskId)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error: Invalid taskId "${taskId}".` }],
          };
        }

        setTaskWebhook(rootDir, taskId, {
          url: on_complete.url,
          headers: on_complete.headers,
          events: on_complete.events as WebhookEvent[],
          secret: on_complete.secret,
        });

        logger.info(`set_task_webhook: attached webhook to task ${taskId} (url=${on_complete.url})`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  taskId,
                  attached: true,
                  url: on_complete.url,
                  events: on_complete.events || ["completed", "failed"],
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`set_task_webhook error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error setting task webhook: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: clear_task_webhook
   * Removes webhook attached to a specific task.
   */
  server.tool(
    "clear_task_webhook",
    "Clear and remove any completion webhook attached to a specific task.",
    {
      taskId: z.string().describe("Task ID whose webhook should be removed"),
    },
    async ({ taskId }) => {
      try {
        if (!isValidTaskId(taskId)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error: Invalid taskId "${taskId}".` }],
          };
        }

        const cleared = clearTaskWebhook(rootDir, taskId);
        logger.info(`clear_task_webhook: removed webhook for task ${taskId} (existed=${cleared})`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ taskId, cleared: true }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`clear_task_webhook error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error clearing task webhook: ${err?.message || String(err)}` }],
        };
      }
    }
  );
}
