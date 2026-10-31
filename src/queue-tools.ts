import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeLogger } from "./logger.js";
import {
  enqueueTask,
  listQueue,
  reorderQueue,
  updateQueueItem,
  cancelQueueItem,
  pauseQueue,
  resumeQueue,
  isValidQueueId,
  QueueMode,
} from "./queue.js";
import { resolveSessionId } from "./sessions.js";
import { readStatus } from "./status.js";

export function registerQueueTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  /**
   * Tool: enqueue_task
   * Enqueues a task prompt behind an existing task or for a session.
   */
  server.tool(
    "enqueue_task",
    "Enqueue a task to run after a task finishes or sequentially within a session.",
    {
      session_id: z.string().optional().describe("Session ID to sequence the task in"),
      after_task_id: z.string().optional().describe("Task ID after which this task should run"),
      prompt: z.string().describe("Task prompt content for the execution agent"),
      options: z
        .object({
          title: z.string().optional(),
          agent: z.string().optional(),
          model: z.string().optional(),
          reasoning_effort: z.string().optional(),
        })
        .optional()
        .describe("Optional agent/model options"),
      on_complete: z
        .object({
          url: z.string().describe("Destination webhook URL (must be http/https)"),
          headers: z.record(z.string(), z.string()).optional().describe("Optional custom HTTP headers"),
          events: z.array(z.enum(["completed", "failed", "pr_opened"])).optional().describe("Events to trigger webhook on (default: ['completed', 'failed'])"),
          secret: z.string().optional().describe("Optional shared secret for HMAC-SHA256 signature in X-Agent-Bridge-Signature header"),
        })
        .optional()
        .describe("Opt-in per task completion webhook. Opt-in per task; do not enable globally; only callers that have a webhook (e.g. Grok Bot) should pass on_complete."),
      mode: z.enum(["auto", "notify"]).default("auto").describe("'auto' dispatches automatically when turn comes; 'notify' marks ready for manual triggering"),
    },
    async ({ session_id, after_task_id, prompt, options, on_complete, mode }) => {
      try {
        if (!prompt || prompt.trim().length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: prompt must be a non-empty string." }],
          };
        }

        let effectiveSessionId = session_id && session_id.trim();
        if (!effectiveSessionId && after_task_id && after_task_id.trim()) {
          // Attempt to find session from after_task_id status or sessions.json
          const cleanAfterId = after_task_id.trim();
          const taskStatus = readStatus(rootDir, cleanAfterId);
          if (taskStatus && (taskStatus as any).sessionId) {
            effectiveSessionId = (taskStatus as any).sessionId;
          } else {
            const resolved = resolveSessionId(rootDir, cleanAfterId);
            effectiveSessionId = resolved || cleanAfterId;
          }
        }

        if (!effectiveSessionId) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: Either session_id or after_task_id must be provided to determine the queue." }],
          };
        }

        const mergedOptions = {
          ...(options || {}),
          ...(on_complete ? { on_complete } : {}),
        };

        const res = enqueueTask(rootDir, {
          session_id: effectiveSessionId,
          after_task_id: after_task_id?.trim(),
          prompt: prompt.trim(),
          options: mergedOptions,
          mode: mode as QueueMode,
        });

        logger.info(`enqueue_task: enqueued task id=${res.id} in session=${effectiveSessionId} at position=${res.position}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: res.id,
                  session_id: effectiveSessionId,
                  position: res.position,
                  mode: mode || "auto",
                  status: "queued",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`enqueue_task error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error enqueuing task: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: list_queue
   * Lists compact queue items (preview <= 80 chars) for a session or globally.
   */
  server.tool(
    "list_queue",
    "List queued items in compact form (id, session_id, position, status, mode, prompt_preview <= 80 chars).",
    {
      session_id: z.string().optional().describe("Optional session_id to filter by"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ session_id }) => {
      try {
        const items = listQueue(rootDir, session_id?.trim());
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(items, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`list_queue error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing queue: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: reorder_queue
   * Reorders items within a session queue either by ordered_ids or moving an item to a target position.
   */
  server.tool(
    "reorder_queue",
    "Reorder items in a session queue using ordered_ids or by moving an item to a position.",
    {
      session_id: z.string().describe("Session ID whose queue to reorder"),
      ordered_ids: z.array(z.string()).optional().describe("Complete or partial list of IDs in desired order"),
      move_item_id: z.string().optional().describe("Item ID to move"),
      target_position: z.number().int().optional().describe("Target 1-based position for move_item_id"),
    },
    async ({ session_id, ordered_ids, move_item_id, target_position }) => {
      try {
        if (!session_id || session_id.trim().length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: session_id must be provided." }],
          };
        }

        const moveItem =
          move_item_id && target_position !== undefined
            ? { id: move_item_id.trim(), target_position }
            : undefined;

        const res = reorderQueue(rootDir, session_id.trim(), ordered_ids, moveItem);
        if (!res.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error reordering queue: ${res.error}` }],
          };
        }

        logger.info(`reorder_queue: successfully reordered queue for session ${session_id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, items: res.items }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`reorder_queue error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error reordering queue: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: update_queue_item
   * Updates prompt, mode, or options of a queued item.
   */
  server.tool(
    "update_queue_item",
    "Update the prompt, mode ('auto' | 'notify'), or options of a queued task item.",
    {
      id: z.string().describe("Queue item ID"),
      prompt: z.string().optional().describe("New prompt text"),
      mode: z.enum(["auto", "notify"]).optional().describe("New mode ('auto' or 'notify')"),
      options: z
        .object({
          title: z.string().optional(),
          agent: z.string().optional(),
          model: z.string().optional(),
          reasoning_effort: z.string().optional(),
        })
        .optional()
        .describe("Updated options"),
    },
    async ({ id, prompt, mode, options }) => {
      try {
        if (!isValidQueueId(id)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Invalid queue item ID "${id}".` }],
          };
        }

        const updated = updateQueueItem(rootDir, id, {
          prompt: prompt?.trim(),
          mode: mode as QueueMode,
          options,
        });

        if (!updated) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Queue item "${id}" not found.` }],
          };
        }

        logger.info(`update_queue_item: updated item ${id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: updated.id,
                  session_id: updated.session_id,
                  position: updated.position,
                  mode: updated.mode,
                  status: updated.status,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`update_queue_item error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating queue item: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: cancel_queue_item
   * Cancels and removes an item from the queue.
   */
  server.tool(
    "cancel_queue_item",
    "Cancel and remove an item from the task queue.",
    {
      id: z.string().describe("Queue item ID to cancel"),
    },
    async ({ id }) => {
      try {
        if (!isValidQueueId(id)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Invalid queue item ID "${id}".` }],
          };
        }

        const success = cancelQueueItem(rootDir, id);
        if (!success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Queue item "${id}" not found.` }],
          };
        }

        logger.info(`cancel_queue_item: cancelled item ${id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id, cancelled: true }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`cancel_queue_item error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error cancelling queue item: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: pause_queue
   * Pauses automatic dispatching for a session queue.
   */
  server.tool(
    "pause_queue",
    "Pause automatic dispatching for a session's task queue.",
    {
      session_id: z.string().describe("Session ID whose queue to pause"),
    },
    async ({ session_id }) => {
      try {
        if (!session_id || session_id.trim().length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: session_id must be provided." }],
          };
        }

        pauseQueue(rootDir, session_id.trim(), "paused by user request");
        logger.info(`pause_queue: paused queue for session ${session_id}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ session_id: session_id.trim(), paused: true }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`pause_queue error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error pausing queue: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: resume_queue
   * Resumes automatic dispatching for a session queue.
   */
  server.tool(
    "resume_queue",
    "Resume automatic dispatching for a session's task queue.",
    {
      session_id: z.string().describe("Session ID whose queue to resume"),
    },
    async ({ session_id }) => {
      try {
        if (!session_id || session_id.trim().length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: session_id must be provided." }],
          };
        }

        resumeQueue(rootDir, session_id.trim());
        logger.info(`resume_queue: resumed queue for session ${session_id}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ session_id: session_id.trim(), paused: false }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`resume_queue error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error resuming queue: ${err?.message || String(err)}` }],
        };
      }
    }
  );
}
