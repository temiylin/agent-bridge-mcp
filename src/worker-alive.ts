import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

export function registerWorkerAliveTool(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  server.tool(
    "worker_alive_summary",
    "Get read-only summary of local worker process alive state, PID, and last recorded activity timestamp.",
    {},
    async () => {
      audit(rootDir, { tool: "worker_alive_summary" });

      let running = false;
      let pid: number | undefined = undefined;
      let lastActivity: string | undefined = undefined;

      const logsDir = path.join(rootDir, "logs");
      const pidPath = path.join(logsDir, "worker.pid");
      const workerLogPath = path.join(logsDir, "worker.log");

      // 1. Check worker.pid and probe with signal 0 (strictly no other signals)
      try {
        if (fs.existsSync(pidPath)) {
          const content = fs.readFileSync(pidPath, "utf8").trim();
          const parsedPid = parseInt(content, 10);
          if (!Number.isNaN(parsedPid) && parsedPid > 0) {
            pid = parsedPid;
            try {
              process.kill(parsedPid, 0);
              running = true;
            } catch (err: any) {
              if (err.code === "EPERM") {
                // Process exists but lacks permission to signal -> still running
                running = true;
              } else {
                // ESRCH means process does not exist
                running = false;
              }
            }
          }
        }
      } catch (err: any) {
        logger.warn(`worker_alive_summary: error reading pid file: ${err?.message || String(err)}`);
      }

      // 2. Check last activity timestamp from logs/worker.log (read trailing block)
      try {
        if (fs.existsSync(workerLogPath)) {
          const stat = fs.statSync(workerLogPath);
          const readSize = Math.min(stat.size, 64 * 1024);
          const buffer = Buffer.alloc(readSize);
          const fd = fs.openSync(workerLogPath, "r");
          try {
            fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
          } finally {
            fs.closeSync(fd);
          }
          const text = buffer.toString("utf8");
          const lines = text.split("\n");
          const isoRegex = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]/;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            const match = line.match(isoRegex);
            if (match) {
              lastActivity = match[1];
              break;
            }
          }
        }
      } catch (err: any) {
        logger.warn(`worker_alive_summary: error reading worker.log: ${err?.message || String(err)}`);
      }

      const summary: { running: boolean; pid?: number; lastActivity?: string } = {
        running,
        ...(pid !== undefined ? { pid } : {}),
        ...(lastActivity !== undefined ? { lastActivity } : {}),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );
}
