import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isValidTaskId, resolveSafePath } from "./validator.js";
import { readStatus, writeStatus, ACTIVE_STATES } from "./status.js";
import { readReconciledStatus, reconcileTaskStatus, isPidAlive, getDescendantPids } from "./task-reconcile.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

export function getControlDir(root: string): string {
  const controlDir = path.join(root, "control");
  if (!fs.existsSync(controlDir)) {
    fs.mkdirSync(controlDir, { recursive: true });
  }
  return controlDir;
}


export function registerOpsTools(
  server: McpServer,
  rootDir: string,
  tasksDir: string,
  resultsDir: string,
  logsDir: string,
  logger: BridgeLogger
): void {
  const controlDir = getControlDir(rootDir);

  // Tool 1: get_task_status
  server.tool(
    "get_task_status",
    "Get the current execution status of a task without returning the result body.",
    {
      task_id: z.string().describe("Task ID to query status for"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ task_id }) => {
      if (!isValidTaskId(task_id)) {
        logger.warn(`get_task_status rejected invalid task_id: "${task_id}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Invalid task_id: "${task_id}". Only letters, numbers, hyphens (-), and underscores (_) are allowed to prevent path traversal.`,
            },
          ],
        };
      }

      // Check status file first (reconciled against the real worker/agent processes)
      const status = readReconciledStatus(rootDir, task_id);
      if (status) {
        audit(rootDir, { tool: "get_task_status", taskId: task_id, state: status.state });
        const { logTail, ...sanitizedStatus } = status;
        const now = Date.now();
        const lastAct = sanitizedStatus.last_activity_at || sanitizedStatus.lastActivityAt;
        const lastActMs = lastAct ? new Date(lastAct).getTime() : (sanitizedStatus.startedAt ? new Date(sanitizedStatus.startedAt).getTime() : now);
        const idleSec = Math.max(0, Math.floor((now - lastActMs) / 1000));
        if (sanitizedStatus.idle_seconds === undefined) {
          sanitizedStatus.idle_seconds = idleSec;
        }
        if (!sanitizedStatus.activity) {
          sanitizedStatus.activity = ACTIVE_STATES.includes(sanitizedStatus.state) && idleSec < 30 ? "active" : "idle";
        }
        if (!sanitizedStatus.last_activity_at && lastAct) {
          sanitizedStatus.last_activity_at = lastAct;
        }
        if (!sanitizedStatus.activity_source) {
          sanitizedStatus.activity_source = "none";
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sanitizedStatus, null, 2),
            },
          ],
        };
      }

      // If no status file, check tasks directory
      let taskFilePath: string;
      try {
        taskFilePath = resolveSafePath(tasksDir, rootDir, `${task_id}.md`);
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `Error resolving task path.` }],
        };
      }

      if (fs.existsSync(taskFilePath)) {
        audit(rootDir, { tool: "get_task_status", taskId: task_id, state: "queued" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                taskId: task_id,
                state: "queued",
                activity: "idle",
                idle_seconds: 0,
                activity_source: "none",
              }, null, 2),
            },
          ],
        };
      }

      // Check results directory as fallback
      let resultFilePath: string;
      try {
        resultFilePath = resolveSafePath(resultsDir, rootDir, `${task_id}.md`);
        if (fs.existsSync(resultFilePath)) {
          audit(rootDir, { tool: "get_task_status", taskId: task_id, state: "completed" });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  taskId: task_id,
                  state: "completed",
                  activity: "idle",
                  idle_seconds: 0,
                  activity_source: "none",
                }, null, 2),
              },
            ],
          };
        }
      } catch {}

      audit(rootDir, { tool: "get_task_status", taskId: task_id, state: "not_found" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ taskId: task_id, state: "not_found", message: `Task "${task_id}" does not exist.` }, null, 2),
          },
        ],
      };
    }
  );

  // Tool 2: cancel_task
  server.tool(
    "cancel_task",
    "Request cancellation of a running or queued task by writing control file.",
    {
      task_id: z.string().describe("Task ID to cancel"),
    },
    async ({ task_id }) => {
      if (!isValidTaskId(task_id)) {
        logger.warn(`cancel_task rejected invalid task_id: "${task_id}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Invalid task_id: "${task_id}". Only letters, numbers, hyphens (-), and underscores (_) are allowed to prevent path traversal.`,
            },
          ],
        };
      }

      // Check if task already has a final state
      const currentStatus = readStatus(rootDir, task_id);
      if (currentStatus && ["completed", "failed", "cancelled"].includes(currentStatus.state)) {
        audit(rootDir, { tool: "cancel_task", taskId: task_id, state: currentStatus.state });
        return {
          content: [
            {
              type: "text",
              text: `Task "${task_id}" has already finished with status "${currentStatus.state}". Cancel request ignored.`,
            },
          ],
        };
      }

      let resultFilePath: string;
      try {
        resultFilePath = resolveSafePath(resultsDir, rootDir, `${task_id}.md`);
        if (fs.existsSync(resultFilePath)) {
          audit(rootDir, { tool: "cancel_task", taskId: task_id, state: "completed" });
          return {
            content: [
              {
                type: "text",
                text: `Task "${task_id}" has already finished with result file. Cancel request ignored.`,
              },
            ],
          };
        }
      } catch {}

      // Ghost task (status says running but no live worker/agent): resolve it directly.
      if (currentStatus && ACTIVE_STATES.includes(currentStatus.state)) {
        const after = reconcileTaskStatus(rootDir, { taskId: task_id, ...currentStatus }, { graceMs: 0, childExitGraceMs: 0, finalState: "cancelled" });
        if (after.state === "cancelled") {
          audit(rootDir, { tool: "cancel_task", taskId: task_id, state: "cancelled" });
          logger.info(`cancel_task: ${task_id} had no live process; marked cancelled`);
          return {
            content: [
              {
                type: "text",
                text: `Task "${task_id}" had no live worker/agent process (ghost); marked cancelled.\nreason: ${after.reason}`,
              },
            ],
          };
        }
      }

      // Write control/<task_id>.cancel
      let cancelFilePath: string;
      try {
        cancelFilePath = resolveSafePath(controlDir, rootDir, `${task_id}.cancel`);
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error resolving control path: ${err.message}` }],
        };
      }

      fs.writeFileSync(cancelFilePath, new Date().toISOString(), "utf8");
      audit(rootDir, { tool: "cancel_task", taskId: task_id, state: "cancel_requested" });
      logger.info(`cancel_task: wrote control file for taskId=${task_id}`);

      // Persist status as cancelled BEFORE killing process
      try {
        const existingStatus = readStatus(rootDir, task_id) || {};
        writeStatus(rootDir, task_id, {
          taskId: task_id,
          ...existingStatus,
          state: "cancelled",
          reason: "cancelled by request",
          activity: "idle",
        });
      } catch {}

      // Immediately signal active agent process
      if (currentStatus && ACTIVE_STATES.includes(currentStatus.state)) {
        if (currentStatus.pid && isPidAlive(currentStatus.pid)) {
          const childPid = currentStatus.pid;
          const logMsg = `[${new Date().toISOString()}] [WARN] Task ${task_id} cancellation requested. Sending SIGTERM to process.\n`;
          try {
            const logsDir = path.join(rootDir, "logs");
            if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
            fs.appendFileSync(path.join(logsDir, "worker.log"), logMsg, "utf8");
          } catch {}
          const isWin = process.platform === "win32";
          if (isWin) {
            try {
              spawnSync("taskkill", ["/T", "/PID", String(childPid)], { windowsHide: true });
            } catch {}
          } else {
            const allPids = [childPid, ...getDescendantPids(childPid)];
            for (const p of allPids) {
              try { process.kill(p, "SIGTERM"); } catch {}
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `cancel requested for task "${task_id}"`,
          },
        ],
      };
    }
  );

  // Tool 3: read_task_output
  server.tool(
    "read_task_output",
    "Incrementally read execution stdout from logs/<task_id>.out.",
    {
      task_id: z.string().describe("Task ID to read output for"),
      offset: z.number().optional().describe("Byte offset to start reading from (default 0)"),
      length: z.number().optional().describe("Number of bytes to read (default 4000, max 16000)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ task_id, offset, length }) => {
      if (!isValidTaskId(task_id)) {
        logger.warn(`read_task_output rejected invalid task_id: "${task_id}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Invalid task_id: "${task_id}". Only letters, numbers, hyphens (-), and underscores (_) are allowed to prevent path traversal.`,
            },
          ],
        };
      }

      const safeOffset = offset !== undefined ? Math.floor(offset) : 0;
      if (safeOffset < 0 || isNaN(safeOffset)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: offset must be a non-negative integer." }],
        };
      }

      const rawLength = length !== undefined ? Math.floor(length) : 4000;
      let clampedLength = rawLength;
      let clampNote = "";
      if (rawLength < 1) {
        clampedLength = 1;
        clampNote = ` (Note: requested length ${rawLength} clamped to minimum 1)`;
      } else if (rawLength > 16000) {
        clampedLength = 16000;
        clampNote = ` (Note: requested length ${rawLength} clamped to maximum 16000)`;
      }

      let outFilePath: string;
      try {
        outFilePath = resolveSafePath(logsDir, rootDir, `${task_id}.out`);
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error resolving output path: ${err.message}` }],
        };
      }

      if (!fs.existsSync(outFilePath)) {
        audit(rootDir, { tool: "read_task_output", taskId: task_id, state: "no_output_yet" });
        return {
          content: [{ type: "text", text: "no output yet" }],
        };
      }

      const stat = fs.statSync(outFilePath);
      const fileSize = stat.size;
      let nextOffset = safeOffset;
      let chunk = "";

      if (safeOffset < fileSize) {
        const bytesToRead = Math.min(clampedLength, fileSize - safeOffset);
        const fd = fs.openSync(outFilePath, "r");
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, bytesToRead, safeOffset);
        fs.closeSync(fd);
        chunk = buffer.toString("utf8");
        nextOffset = safeOffset + bytesToRead;
      }

      const currentStatus = readStatus(rootDir, task_id);
      let isFinished = false;
      if (currentStatus && ["completed", "failed", "cancelled"].includes(currentStatus.state)) {
        isFinished = true;
      } else {
        try {
          const resPath = resolveSafePath(resultsDir, rootDir, `${task_id}.md`);
          isFinished = fs.existsSync(resPath);
        } catch {}
      }

      const eof = isFinished && nextOffset >= fileSize;
      audit(rootDir, { tool: "read_task_output", taskId: task_id, state: eof ? "eof" : "reading" });

      const payload: Record<string, any> = {
        taskId: task_id,
        offset: safeOffset,
        nextOffset,
        eof,
        output: chunk,
      };
      if (clampNote) payload.note = clampNote;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );

  // Tool 4: read_result_page
  server.tool(
    "read_result_page",
    "Paging reader for results/<task_id>.md without altering read_result.",
    {
      task_id: z.string().describe("Task ID to read result page for"),
      offset: z.number().optional().describe("Byte offset to start reading from (default 0)"),
      length: z.number().optional().describe("Number of bytes to read (default 4000, max 16000)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ task_id, offset, length }) => {
      if (!isValidTaskId(task_id)) {
        logger.warn(`read_result_page rejected invalid task_id: "${task_id}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Invalid task_id: "${task_id}". Only letters, numbers, hyphens (-), and underscores (_) are allowed to prevent path traversal.`,
            },
          ],
        };
      }

      const safeOffset = offset !== undefined ? Math.floor(offset) : 0;
      if (safeOffset < 0 || isNaN(safeOffset)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: offset must be a non-negative integer." }],
        };
      }

      const rawLength = length !== undefined ? Math.floor(length) : 4000;
      let clampedLength = rawLength;
      let clampNote = "";
      if (rawLength < 1) {
        clampedLength = 1;
        clampNote = ` (Note: requested length ${rawLength} clamped to minimum 1)`;
      } else if (rawLength > 16000) {
        clampedLength = 16000;
        clampNote = ` (Note: requested length ${rawLength} clamped to maximum 16000)`;
      }

      let resultFilePath: string;
      try {
        resultFilePath = resolveSafePath(resultsDir, rootDir, `${task_id}.md`);
      } catch (pathErr: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Access denied. Path traversal detected: ${pathErr.message}` }],
        };
      }

      if (!fs.existsSync(resultFilePath)) {
        audit(rootDir, { tool: "read_result_page", taskId: task_id, state: "pending" });
        return {
          content: [
            {
              type: "text",
              text: `Status: Pending. Result not ready yet for task "${task_id}". (Result file "${resultFilePath}" does not exist)`,
            },
          ],
        };
      }

      const stat = fs.statSync(resultFilePath);
      const fileSize = stat.size;
      let nextOffset = safeOffset;
      let chunk = "";

      if (safeOffset < fileSize) {
        const bytesToRead = Math.min(clampedLength, fileSize - safeOffset);
        const fd = fs.openSync(resultFilePath, "r");
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, bytesToRead, safeOffset);
        fs.closeSync(fd);
        chunk = buffer.toString("utf8");
        nextOffset = safeOffset + bytesToRead;
      }

      const eof = nextOffset >= fileSize;
      audit(rootDir, { tool: "read_result_page", taskId: task_id, state: eof ? "eof" : "paging" });

      const payload: Record<string, any> = {
        taskId: task_id,
        offset: safeOffset,
        nextOffset,
        eof,
        content: chunk,
      };
      if (clampNote) payload.note = clampNote;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );

  // Tool 5: wait_task
  server.tool(
    "wait_task",
    "Wait for a task to finish with optional timeout, returning execution results or current status.",
    {
      task_id: z.string().describe("Task ID to wait for"),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Timeout in seconds (1-25, default 20). Out of range values will be clamped."),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ task_id, timeout_seconds }) => {
      if (!isValidTaskId(task_id)) {
        logger.warn(`wait_task rejected invalid task_id: "${task_id}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Invalid task_id: "${task_id}". Only letters, numbers, hyphens (-), and underscores (_) are allowed to prevent path traversal.`,
            },
          ],
        };
      }

      let resultFilePath: string;
      try {
        resultFilePath = resolveSafePath(resultsDir, rootDir, `${task_id}.md`);
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Access denied. Path traversal detected: ${err?.message || String(err)}`,
            },
          ],
        };
      }

      // Clamp timeout_seconds between 1 and 25 (default 20)
      const rawTimeout = timeout_seconds !== undefined ? timeout_seconds : 20;
      let clampedTimeout = rawTimeout;
      let clampNote = "";
      if (rawTimeout < 1) {
        clampedTimeout = 1;
        clampNote = ` (Note: requested timeout ${rawTimeout}s was clamped to minimum 1s)`;
      } else if (rawTimeout > 25) {
        clampedTimeout = 25;
        clampNote = ` (Note: requested timeout ${rawTimeout}s was clamped to maximum 25s)`;
      }

      // Check immediately if result file exists
      if (fs.existsSync(resultFilePath)) {
        const fileContent = fs.readFileSync(resultFilePath, "utf8");
        logger.info(`wait_task: result immediately available for taskId=${task_id}`);
        audit(rootDir, { tool: "wait_task", taskId: task_id, state: "completed" });
        return {
          content: [
            {
              type: "text",
              text: clampNote ? `${fileContent}\n\n${clampNote.trim()}` : fileContent,
            },
          ],
        };
      }

      // Wait loop: poll every 1s until clampedTimeout
      const startMs = Date.now();
      const maxWaitMs = clampedTimeout * 1000;

      while (Date.now() - startMs < maxWaitMs) {
        const elapsed = Date.now() - startMs;
        const remainingMs = maxWaitMs - elapsed;
        if (remainingMs <= 0) break;
        const sleepMs = Math.min(1000, remainingMs);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));

        if (fs.existsSync(resultFilePath)) {
          const fileContent = fs.readFileSync(resultFilePath, "utf8");
          logger.info(`wait_task: result ready for taskId=${task_id} after ${Date.now() - startMs}ms`);
          audit(rootDir, { tool: "wait_task", taskId: task_id, state: "completed" });
          return {
            content: [
              {
                type: "text",
                text: clampNote ? `${fileContent}\n\n${clampNote.trim()}` : fileContent,
              },
            ],
          };
        }
      }

      // Timeout reached, return current status
      const currentStatus = readStatus(rootDir, task_id) || {
        taskId: task_id,
        state: "running",
      };
      logger.info(`wait_task: timed out waiting for taskId=${task_id} after ${clampedTimeout}s`);
      audit(rootDir, { tool: "wait_task", taskId: task_id, state: currentStatus.state });

      // Read live stdout progress stats (bytes/size) without leaking repetitive partial text
      let outputStats = "";
      try {
        const outFilePath = resolveSafePath(logsDir, rootDir, `${task_id}.out`);
        if (fs.existsSync(outFilePath)) {
          const stat = fs.statSync(outFilePath);
          if (stat.size > 0) {
            outputStats = `，后台已生成 ${(stat.size / 1024).toFixed(1)} KB`;
          }
        }
      } catch {}

      let elapsedStr = "";
      if (currentStatus.startedAt) {
        const elapsedSec = Math.max(1, Math.round((Date.now() - new Date(currentStatus.startedAt).getTime()) / 1000));
        elapsedStr = `已执行 ${elapsedSec}s`;
      }

      const agentPart = currentStatus.agent ? `[${currentStatus.agent}]` : "";
      const metaInfo = [elapsedStr, outputStats].filter(Boolean).join("");
      const metaPart = metaInfo ? `(${metaInfo})` : "";
      const details = [agentPart, metaPart].filter(Boolean).join(" ");
      const prefix = details ? ` ${details}` : "";

      return {
        content: [
          {
            type: "text",
            text: `Status: Pending. Task "${task_id}"${prefix} 仍在执行，可再次调用 wait_task。${clampNote}`,
          },
        ],
      };
    }
  );
}
