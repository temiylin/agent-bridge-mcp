import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createBridgeMcpServer, BridgeMcpServerInstance } from "./server.js";
import { BridgeLogger } from "./logger.js";
import { renderDashboardHtml } from "./dashboard-html.js";
import { loadAgents, saveAgents } from "./agents.js";
import { loadRoutingConfig, saveRoutingConfig } from "./routing.js";
import { queryRecentTasks } from "./recent-tasks.js";
import { readStatus, writeStatus, ACTIVE_STATES } from "./status.js";
import { reconcileTaskStatus } from "./task-reconcile.js";
import { isValidTaskId, resolveSafePath } from "./validator.js";
import { audit } from "./audit.js";
import { getStashedQuotaTask, removeStashedQuotaTask } from "./session-quota.js";
import {
  listRequirements,
  getRequirement,
  writeRequirement,
  deleteRequirement,
  generateRequirementId,
} from "./requirements.js";
import { dispatchTaskDirect, isSessionBusy } from "./queue-dispatcher.js";
import {
  listAllSessionQueues,
  listQueue,
  enqueueTask,
  reorderQueue,
  updateQueueItem,
  cancelQueueItem,
  pauseQueue,
  resumeQueue,
  findItemInQueues,
} from "./queue.js";
import {
  queryPoolStatus,
  loadPoolConfig,
  initPoolProfile,
  pausePoolProfile,
  resumePoolProfile,
  bindProfileEmail,
  getRunningTasksPerProfile,
  syncProfileAuthFromCockpit,
  detectProfileLoginStatus,
  removePoolProfile,
} from "./account-pool.js";
import { removeGitWorktree, resolveWorktreeRoot } from "./worktree.js";
import { resolveDeviceToken } from "./token.js";
import { queryAccountOverview, isCustomPoolEnabled, setCustomPoolEnabled, resumeEmail } from "./dual-pool.js";
import { fileURLToPath } from "node:url";
import { listAccountsFromCockpitStorage, switchAgentAccount } from "./account-manager.js";
import {
  loadProjectsConfig,
  sanitizeProjectForClient,
  getProjectRepoPath,
  validateGitRepoPath,
} from "./project-router.js";
import { addProject, updateProject, removeProject } from "./project-tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface HttpServerOptions {
  port?: number;
  host?: string;
  customRootDir?: string;
}

export interface HttpServerHandle {
  server: http.Server;
  port: number;
  host: string;
  mcpServerInstance: BridgeMcpServerInstance;
  close: () => Promise<void>;
}

interface SessionRecord {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  serverInstance: BridgeMcpServerInstance;
  type: "streamable" | "sse";
  lastActive: number;
}

/**
 * Starts a full-featured HTTP/SSE server for agent-bridge-mcp.
 * Implements:
 * 1. Streamable HTTP (/mcp) with stateful & stateless fallback, enableJsonResponse: true
 * 2. Classic HTTP+SSE (/sse and /messages) for older MCP clients
 * 3. Health & Status endpoints (/health, /status, /)
 * 4. Full CORS support and detailed HTTP request logging
 */
export async function startHttpServer(options: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 38080);
  const host = options.host ?? (process.env.HOST || "127.0.0.1");

  const defaultInstance = createBridgeMcpServer(options.customRootDir);
  const { logger } = defaultInstance;

  const sessions = new Map<string, SessionRecord>();

  // Prune idle sessions every 60 seconds
  const pruneInterval = setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30 minutes
    for (const [sid, rec] of sessions.entries()) {
      if (rec.lastActive < cutoff) {
        logger.info(`Pruning idle session ${sid}`);
        rec.transport.close().catch(() => {});
        sessions.delete(sid);
      }
    }
  }, 60000).unref();

  const nodeServer = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const method = req.method || "GET";

    // 1. CORS headers:
    // Only MCP endpoints (/mcp, /sse, /messages) and public health/status check endpoints allow wildcard CORS (*).
    // Sensitive REST APIs (/api/*) do NOT expose wildcard CORS to arbitrary web pages.
    const isMcpOrPublic =
      pathname.startsWith("/mcp") ||
      pathname.startsWith("/sse") ||
      pathname.startsWith("/messages") ||
      pathname === "/health" ||
      pathname === "/status";

    const origin = req.headers["origin"];
    if (isMcpOrPublic) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin) {
      // For local dashboard / admin, strictly allow origin whitelist (localhost, 127.0.0.1)
      // to prevent DNS rebinding attacks from arbitrary sites
      try {
        const originUrl = new URL(origin);
        if (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1") {
          res.setHeader("Access-Control-Allow-Origin", origin);
        }
      } catch {}
    }

    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD, DELETE");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, mcp-session-id, x-mcp-session-id, authorization, x-device-token, x-admin-token"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, x-mcp-session-id, content-type");

    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Host header validation: strictly allow only localhost, 127.0.0.1, or [::1] (with optional port)
    // Return 403 to prevent DNS rebinding attacks from public host headers
    const hostHeader = (req.headers["host"] || "").trim();
    const isAllowedHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(hostHeader);
    if (!isAllowedHost) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: false, error: "Forbidden: Invalid Host header" }));
      return;
    }

    // Origin check for state-mutating API routes and /mcp POST
    // If request has Origin header, verify that Origin's hostname is localhost or 127.0.0.1 or [::1].
    // Requests without Origin (e.g. CLI curl, tools, background jobs) are allowed through.
    const isWriteOrMcpPost =
      (pathname.startsWith("/api/") && (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH")) ||
      (pathname === "/mcp" && method === "POST");

    if (isWriteOrMcpPost && origin) {
      let isAllowedOrigin = false;
      try {
        const originUrl = new URL(origin);
        const oHost = originUrl.hostname.toLowerCase();
        isAllowedOrigin = oHost === "localhost" || oHost === "127.0.0.1" || oHost === "[::1]" || oHost === "::1";
      } catch {}

      if (!isAllowedOrigin) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: false, error: "Forbidden: Cross-site request rejected" }));
        return;
      }
    }

    // Content-Type validation for write requests:
    // All /api/* write requests (POST/PUT/DELETE/PATCH) and /mcp POST must require application/json.
    if (isWriteOrMcpPost) {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        res.statusCode = 415;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: false, error: "Unsupported Media Type: Content-Type must be application/json" }));
        return;
      }
    }

    // Helper: Verify authorization for state-mutating or sensitive REST APIs
    // Allowed if:
    // 1. Request is strictly from local loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1)
    // 2. OR request provides valid non-empty device token via header: Authorization: Bearer <token>, x-device-token: <token>, or x-admin-token: <token>
    // NOTE: fe80:: (IPv6 link-local) is NOT considered localhost; token being empty or "dev_default" does NOT grant authorization.
    const isAuthorizedRequest = (): boolean => {
      const clientIp = req.socket.remoteAddress || "";
      const isLocalhost =
        clientIp === "127.0.0.1" ||
        clientIp === "::1" ||
        clientIp === "::ffff:127.0.0.1";

      if (isLocalhost) return true;

      const expectedToken = resolveDeviceToken().token;
      if (!expectedToken || expectedToken === "dev_default") {
        return false;
      }

      const authHeader = req.headers["authorization"] || "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
      const devTokenHeader = req.headers["x-device-token"] || req.headers["x-admin-token"] || "";

      return (
        bearerToken === expectedToken ||
        devTokenHeader === expectedToken ||
        url.searchParams.get("token") === expectedToken
      );
    };

    // 2. Normalize Accept header
    // The MCP Streamable HTTP SDK strictly requires both application/json and text/event-stream in Accept.
    // Clients like ChatGPT or curl frequently send 'application/json' or '*/*'.
    // We normalize it here so clients aren't rejected with 406 Not Acceptable.
    const originalAccept = req.headers["accept"] || "";
    if (!originalAccept.includes("text/event-stream")) {
      req.headers["accept"] = originalAccept ? `${originalAccept}, text/event-stream` : "application/json, text/event-stream";
    }

    // Read body helper
    const readBody = async (): Promise<any> => {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
      }
      if (!data.trim()) return undefined;
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    };

    logger.info(`[HTTP] --> ${method} ${pathname} (accept: "${originalAccept || "*/*"}")`);

    res.on("finish", () => {
      const duration = Date.now() - startTime;
      logger.info(`[HTTP] <-- ${method} ${pathname} ${res.statusCode} (${duration}ms)`);
    });

    try {
      // 3. Web Dashboard (/ and /dashboard and /admin)
      const isHtmlRequest =
        originalAccept.includes("text/html") ||
        pathname === "/dashboard" ||
        pathname === "/admin";

      const webDistDir = path.resolve(__dirname, "..", "web", "dist");

      // Serve static assets from web/dist (Vite React app)
      if (pathname.startsWith("/assets/") && fs.existsSync(path.join(webDistDir, pathname))) {
        const filePath = path.join(webDistDir, pathname);
        const ext = path.extname(filePath).toLowerCase();
        let mime = "application/octet-stream";
        if (ext === ".js") mime = "application/javascript; charset=utf-8";
        else if (ext === ".css") mime = "text/css; charset=utf-8";
        else if (ext === ".svg") mime = "image/svg+xml";
        else if (ext === ".png") mime = "image/png";

        res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.statusCode = 200;
        res.end(fs.readFileSync(filePath));
        return;
      }

      if (isHtmlRequest && (pathname === "/" || pathname === "/dashboard" || pathname === "/admin")) {
        const reactIndexHtml = path.join(webDistDir, "index.html");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.statusCode = 200;
        if (fs.existsSync(reactIndexHtml)) {
          res.end(fs.readFileSync(reactIndexHtml, "utf8"));
        } else {
          res.end(renderDashboardHtml());
        }
        return;
      }

      // 4. REST APIs for Local Web Dashboard
      if (pathname === "/api/config") {
        if (method === "GET") {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          let rawDeviceToken = "dev_default";
          const cfgPath = path.join(os.homedir(), ".agent-bridge", "config.json");
          if (fs.existsSync(cfgPath)) {
            try {
              const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
              if (cfg.deviceToken) rawDeviceToken = cfg.deviceToken;
            } catch {}
          }
          let agents: any = {};
          try {
            agents = loadAgents(defaultInstance.rootDir);
          } catch {}
          const routing = loadRoutingConfig(defaultInstance.rootDir);
          const relayHttp = process.env.RELAY_HTTP || "https://bridge.krow.top/mcp";

          // Only expose raw deviceToken if client is authorized (localhost or valid token)
          const authorized = isAuthorizedRequest();
          const deviceToken = authorized ? rawDeviceToken : (rawDeviceToken ? `${rawDeviceToken.slice(0, 6)}...***` : "");
          const deviceUrl = `${relayHttp}/${authorized ? rawDeviceToken : "******"}`;

          res.statusCode = 200;
          res.end(JSON.stringify({ deviceToken, deviceUrl, agents, routing }, null, 2));
          return;
        }

        if (method === "POST") {
          if (!isAuthorizedRequest()) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Forbidden: Write operation requires authorization" }));
            return;
          }
          const body = await readBody();
          if (!body || typeof body !== "object") {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
          if (body.agents && typeof body.agents === "object" && !Array.isArray(body.agents)) {
            saveAgents(defaultInstance.rootDir, body.agents);
          }
          if (body.routing && typeof body.routing === "object") {
            saveRoutingConfig(defaultInstance.rootDir, body.routing);
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, message: "Configuration saved successfully" }));
          return;
        }
      }

      if (pathname === "/api/projects") {
        if (method === "GET") {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          try {
            const cfg = loadProjectsConfig(defaultInstance.rootDir);
            const projects = Object.values(cfg.projects).map((p) => {
              const sanitized = sanitizeProjectForClient(p);
              const repoPath = getProjectRepoPath(p);
              const pathCheck = repoPath ? validateGitRepoPath(repoPath) : { valid: false, error: "No repo_path configured" };
              return {
                ...sanitized,
                repo_path: repoPath,
                path_valid: pathCheck.valid,
                path_error: pathCheck.valid ? undefined : pathCheck.error,
              };
            });
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, projects }));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }

        if (method === "POST") {
          if (!isAuthorizedRequest()) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
            return;
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          try {
            const body = await readBody();
            if (!body || typeof body !== "object") {
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, error: "Invalid JSON body" }));
              return;
            }
            const action = body.action || "add";
            if (action === "add") {
              const result = addProject(defaultInstance.rootDir, body);
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }
            if (action === "update") {
              const result = updateProject(defaultInstance.rootDir, body);
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }
            if (action === "remove" || action === "delete") {
              const projectId = body.project_id || body.id;
              const result = removeProject(defaultInstance.rootDir, projectId);
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: `Unsupported action: ${action}` }));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }
      }

      if (pathname === "/api/test-agent" && method === "POST") {
        const body = await readBody();
        const agentName = body?.agent || "codex";
        let cmd = agentName;
        try {
          const agents = loadAgents(defaultInstance.rootDir);
          if (agents[agentName]?.command) {
            cmd = agents[agentName].command;
          }
        } catch {}

        const isWin = process.platform === "win32";
        const lookup = isWin ? "where" : "which";
        const proc = spawnSync(lookup, [cmd], { encoding: "utf8", timeout: 5000 });
        const foundPath = proc.status === 0 ? proc.stdout.trim().split(/\r?\n/)[0] : null;

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            available: Boolean(foundPath),
            path: foundPath,
            command: cmd,
            message: foundPath ? `Found ${cmd} at ${foundPath}` : `Command "${cmd}" not found in PATH`,
          })
        );
        return;
      }

      if (pathname === "/api/system" && method === "GET") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const cpus = os.cpus();
        const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024));
        const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
        const workerPid = process.pid;

        res.statusCode = 200;
        res.end(
          JSON.stringify({
            platform: os.platform(),
            arch: os.arch(),
            cpuModel: cpus[0]?.model || "Apple Silicon / x86",
            cores: cpus.length,
            totalMemGb: totalMem,
            freeMemGb: freeMem,
            workerPid,
          })
        );
        return;
      }

      // API: Recent Tasks
      if (pathname === "/api/recent-tasks" && method === "GET") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
        const status = url.searchParams.get("status") || undefined;
        const project = url.searchParams.get("project") || undefined;
        const sessionId = url.searchParams.get("session_id") || undefined;

        try {
          const tasks = queryRecentTasks(defaultInstance.rootDir, {
            limit,
            status,
            project,
            session_id: sessionId,
          });
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, tasks }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
        }
        return;
      }

      // API: Cancel Recent Task
      if (pathname === "/api/recent-tasks/cancel" && method === "POST") {
        if (!isAuthorizedRequest()) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
          return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const body = await readBody();
          const taskId = body?.taskId || body?.id;
          if (!taskId || !isValidTaskId(taskId)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: "Invalid or missing taskId" }));
            return;
          }

          const rootDir = defaultInstance.rootDir;
          const currentStatus = readStatus(rootDir, taskId);

          // 1. If already finished, return immediately
          if (currentStatus && ["completed", "failed", "cancelled"].includes(currentStatus.state)) {
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, message: `Task "${taskId}" has already finished with status "${currentStatus.state}".` }));
            return;
          }

          // 2. Check if result file already exists
          const resultsDir = path.join(rootDir, "results");
          const resultFilePath = path.join(resultsDir, `${taskId}.md`);
          if (fs.existsSync(resultFilePath)) {
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, message: `Task "${taskId}" has already finished with result file.` }));
            return;
          }

          // 3. If paused_quota or queued in status with no active running process, cancel immediately
          if (currentStatus && (currentStatus.state === "paused_quota" || currentStatus.state === "queued")) {
            writeStatus(rootDir, taskId, {
              ...currentStatus,
              state: "cancelled",
              finishedAt: currentStatus.finishedAt || new Date().toISOString(),
              reason: "cancelled by user request via dashboard",
            });
            audit(rootDir, { tool: "http_cancel_task", taskId, state: "cancelled" });
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, message: `Task "${taskId}" marked cancelled.` }));
            return;
          }

          // 4. Ghost task check (marked running but process is dead)
          if (currentStatus && ACTIVE_STATES.includes(currentStatus.state)) {
            const after = reconcileTaskStatus(rootDir, { taskId, ...currentStatus }, { graceMs: 0, childExitGraceMs: 0, finalState: "cancelled" });
            if (after.state === "cancelled") {
              audit(rootDir, { tool: "http_cancel_task", taskId, state: "cancelled" });
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, message: `Task "${taskId}" had no live process; marked cancelled.` }));
              return;
            }
          }

          // 5. Also try removing from queue if present
          cancelQueueItem(rootDir, taskId);

          // 6. Write control/<taskId>.cancel for running worker/agent
          const controlDir = path.join(rootDir, "control");
          if (!fs.existsSync(controlDir)) {
            fs.mkdirSync(controlDir, { recursive: true });
          }
          const cancelFilePath = path.join(controlDir, `${taskId}.cancel`);
          fs.writeFileSync(cancelFilePath, new Date().toISOString(), "utf8");
          audit(rootDir, { tool: "http_cancel_task", taskId, state: "cancel_requested" });

          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, message: `Cancel requested for task "${taskId}".` }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
        }
        return;
      }

      // API: Task Details
      if (pathname === "/api/recent-tasks/details" && method === "GET") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const taskId = url.searchParams.get("taskId") || "";
        if (!taskId || !isValidTaskId(taskId)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: "Invalid or missing taskId" }));
          return;
        }

        try {
          const rootDir = defaultInstance.rootDir;
          const status = readStatus(rootDir, taskId);
          const taskFilePath = path.join(rootDir, "tasks", `${taskId}.md`);
          let taskRaw = "";
          let meta: Record<string, string> = {};
          let prompt = "";

          if (fs.existsSync(taskFilePath)) {
            taskRaw = fs.readFileSync(taskFilePath, "utf8");
            const parts = taskRaw.split(/\r?\n---\r?\n/);
            const header = parts[0] || "";
            for (const line of header.split(/\r?\n/)) {
              const m = line.match(/^-[ \t]*\*\*([^*]+)\*\*:[ \t]*(.*)$/);
              if (m) meta[m[1].trim()] = m[2].trim();
            }
            const pMatch = taskRaw.match(/## Prompt\s*\n([\s\S]*)$/i);
            prompt = pMatch ? pMatch[1].trim() : "";
          }

          const resultFilePath = path.join(rootDir, "results", `${taskId}.md`);
          let resultRaw: string | null = null;
          if (fs.existsSync(resultFilePath)) {
            resultRaw = fs.readFileSync(resultFilePath, "utf8");
          }

          const workDir = status?.workDir || meta["Worktree Dir"] || meta["Project Dir"] || undefined;

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            taskId,
            status,
            meta,
            prompt,
            workDir,
            hasResult: !!resultRaw,
            resultRaw,
          }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
        }
        return;
      }

      // API: Task Logs (Tail)
      if (pathname === "/api/recent-tasks/logs" && method === "GET") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const taskId = url.searchParams.get("taskId") || "";
        const rawLines = parseInt(url.searchParams.get("lines") || "100", 10);
        const maxLines = Math.max(1, Math.min(500, Number.isFinite(rawLines) ? rawLines : 100));

        if (!taskId || !isValidTaskId(taskId)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: "Invalid or missing taskId" }));
          return;
        }

        try {
          const rootDir = defaultInstance.rootDir;
          const logsDir = path.join(rootDir, "logs");
          const outPath = path.join(logsDir, `${taskId}.out`);
          const errPath = path.join(logsDir, `${taskId}.err`);

          // Efficient tail reader: reads only the end of the file up to 64KB instead of entire file
          const readTail = (filePath: string, lineLimit: number): string => {
            if (!fs.existsSync(filePath)) return "";
            try {
              const stat = fs.statSync(filePath);
              const readLength = Math.min(stat.size, 65536);
              const startOffset = Math.max(0, stat.size - readLength);
              const fd = fs.openSync(filePath, "r");
              const buf = Buffer.alloc(readLength);
              let bytesRead = 0;
              try {
                bytesRead = fs.readSync(fd, buf, 0, readLength, startOffset);
              } finally {
                fs.closeSync(fd);
              }
              const lines = buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
              return lines.slice(-lineLimit).join("\n");
            } catch {
              return "";
            }
          };

          const stdout = readTail(outPath, maxLines);
          const stderr = readTail(errPath, maxLines);

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            taskId,
            stdout,
            stderr,
          }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
        }
        return;
      }

      // API: Task Retry / Resume
      if (pathname === "/api/recent-tasks/retry" && method === "POST") {
        if (!isAuthorizedRequest()) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
          return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const body = await readBody();
          const target = String(body?.taskId || body?.id || "").trim();
          if (!target || !isValidTaskId(target)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: "Invalid or missing taskId" }));
            return;
          }

          const rootDir = defaultInstance.rootDir;
          const mode = body?.mode === "fresh" ? "fresh" : "continue";
          const agentOverride = body?.agent ? String(body.agent).trim() : undefined;
          const modelOverride = body?.model ? String(body.model).trim() : undefined;
          const accountOverride = body?.account ? String(body.account).trim() : undefined;
          const promptOverride = body?.prompt ? String(body.prompt).trim() : undefined;

          // Load original task info
          const taskFilePath = path.join(rootDir, "tasks", `${target}.md`);
          let originalPrompt = "";
          let sessionId = target;
          let originalAgent = "agy";
          let originalModel: string | undefined = undefined;
          let originalEffort: string | undefined = undefined;

          const stashed = getStashedQuotaTask(rootDir, target);
          if (stashed) {
            originalPrompt = stashed.prompt;
            sessionId = stashed.session_id || sessionId;
            originalAgent = stashed.agent || originalAgent;
            originalModel = stashed.model;
            originalEffort = stashed.reasoningEffort;
          }

          if (fs.existsSync(taskFilePath)) {
            try {
              const content = fs.readFileSync(taskFilePath, "utf8");
              const pMatch = content.match(/## Prompt\s*\n([\s\S]*)$/i);
              if (pMatch && !originalPrompt) originalPrompt = pMatch[1].trim();
              const sMatch = content.match(/- \*\*Session ID\*\*:\s*([^\r\n]+)/i);
              if (sMatch) sessionId = sMatch[1].trim();
              const aMatch = content.match(/- \*\*Agent\*\*:\s*([^\r\n]+)/i);
              if (aMatch && !originalAgent) originalAgent = aMatch[1].trim();
              const mMatch = content.match(/- \*\*Model\*\*:\s*([^\r\n]+)/i);
              if (mMatch && !originalModel) originalModel = mMatch[1].trim();
              const effMatch = content.match(/- \*\*Reasoning Effort\*\*:\s*([^\r\n]+)/i);
              if (effMatch && !originalEffort) originalEffort = effMatch[1].trim();
            } catch {}
          }

          const promptToRun = promptOverride || originalPrompt;
          if (!promptToRun) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: `Could not find prompt for task "${target}"` }));
            return;
          }

          const agentToUse = agentOverride || originalAgent;
          const modelToUse = modelOverride || originalModel;
          const accountToUse = accountOverride || undefined;

          // If continuing session, ensure session queue is unpaused
          if (mode === "continue" && sessionId) {
            resumeQueue(rootDir, sessionId);
          }

          const dispatchRes = dispatchTaskDirect(rootDir, {
            prompt: promptToRun,
            title: mode === "continue" ? `Resume ${target}` : `Retry ${target}`,
            agent: agentToUse,
            model: modelToUse,
            reasoning_effort: originalEffort,
            account: accountToUse,
            continue_session: mode === "continue",
            session_id: mode === "continue" ? sessionId : undefined,
          });

          if (stashed) {
            removeStashedQuotaTask(rootDir, stashed.taskId);
          }

          audit(rootDir, {
            tool: "http_task_retry",
            taskId: dispatchRes.taskId,
            state: "dispatched",
          });

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            taskId: dispatchRes.taskId,
            mode,
            agent: dispatchRes.agentName,
            model: dispatchRes.modelParam,
            message: mode === "continue" ? `已成功续跑会话（新任务 ID: ${dispatchRes.taskId}）` : `已重新发起新任务（ID: ${dispatchRes.taskId}）`,
          }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
        }
        return;
      }

      // API: Task Archive / Move to archive/
      if (pathname === "/api/recent-tasks/archive" && method === "POST") {
        if (!isAuthorizedRequest()) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
          return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const body = await readBody();
          const taskIds: string[] = Array.isArray(body?.taskIds) ? body.taskIds : (body?.taskId ? [body.taskId] : []);
          const cleanWorktree = !!body?.cleanWorktree;

          if (taskIds.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: "Missing taskIds" }));
            return;
          }

          const rootDir = defaultInstance.rootDir;
          let deletedCount = 0;
          const cleanedWorktrees: string[] = [];
          const errors: string[] = [];

          // Base archive directory under bridge root
          const archiveRootDir = path.join(rootDir, "archive");
          fs.mkdirSync(path.join(archiveRootDir, "status"), { recursive: true });
          fs.mkdirSync(path.join(archiveRootDir, "tasks"), { recursive: true });
          fs.mkdirSync(path.join(archiveRootDir, "results"), { recursive: true });
          fs.mkdirSync(path.join(archiveRootDir, "logs"), { recursive: true });

          for (const tid of taskIds) {
            if (!isValidTaskId(tid)) continue;

            // 1. Check if task is running, queued, or paused due to quota: REFUSE archive if active!
            const status = readStatus(rootDir, tid);
            if (status && (status.state === "running" || status.state === "suspected_stalled")) {
              errors.push(`Task "${tid}" is currently running and cannot be archived.`);
              continue;
            }
            if (status && status.state === "paused_quota") {
              errors.push(`Task "${tid}" is paused due to quota and cannot be archived.`);
              continue;
            }
            if (findItemInQueues(rootDir, tid)) {
              errors.push(`Task "${tid}" is currently queued and cannot be archived.`);
              continue;
            }

            // 2. Optional safe worktree cleanup:
            // ONLY allowed if status.workDir is strictly inside bridge's worktrees root!
            // Read repo directory from task metadata if available (or auto-discover from worktree .git pointer).
            if (cleanWorktree && status?.workDir) {
              let repoDirCandidate: string | undefined = undefined;
              const taskPath = path.join(rootDir, "tasks", `${tid}.md`);
              if (fs.existsSync(taskPath)) {
                try {
                  const content = fs.readFileSync(taskPath, "utf8");
                  const dirMatch = content.match(/- \*\*Project Dir\*\*:\s*([^\r\n]+)/i);
                  if (dirMatch) repoDirCandidate = dirMatch[1].trim();
                } catch {}
              }

              const worktreeResult = removeGitWorktree(rootDir, status.workDir, repoDirCandidate, (lvl, msg) => {
                logger[lvl.toLowerCase() as "info" | "warn" | "error"](msg);
              });
              if (worktreeResult.success) {
                cleanedWorktrees.push(status.workDir);
              } else if (worktreeResult.error) {
                errors.push(`Task "${tid}" worktree removal refused: ${worktreeResult.error}`);
              }
            }

            // 3. Move files to archive/ directory instead of permanently deleting
            // If target file already exists in archive, append timestamp to preserve history.
            let taskFileMoved = false;
            let moveErrorOccurred = false;

            const safeMove = (src: string, dest: string, fileLabel: string) => {
              if (!fs.existsSync(src)) return;
              try {
                let finalDest = dest;
                if (fs.existsSync(finalDest)) {
                  const ext = path.extname(dest);
                  const base = path.basename(dest, ext);
                  finalDest = path.join(path.dirname(dest), `${base}_${Date.now()}${ext}`);
                }
                try {
                  fs.renameSync(src, finalDest);
                } catch {
                  fs.copyFileSync(src, finalDest);
                  fs.unlinkSync(src);
                }
                taskFileMoved = true;
              } catch (e: any) {
                moveErrorOccurred = true;
                errors.push(`Task "${tid}" failed to archive ${fileLabel}: ${e?.message || String(e)}`);
              }
            };

            safeMove(
              path.join(rootDir, "status", `${tid}.json`),
              path.join(archiveRootDir, "status", `${tid}.json`),
              "status file"
            );
            safeMove(
              path.join(rootDir, "tasks", `${tid}.md`),
              path.join(archiveRootDir, "tasks", `${tid}.md`),
              "task markdown"
            );
            safeMove(
              path.join(rootDir, "results", `${tid}.md`),
              path.join(archiveRootDir, "results", `${tid}.md`),
              "result markdown"
            );
            safeMove(
              path.join(rootDir, "logs", `${tid}.out`),
              path.join(archiveRootDir, "logs", `${tid}.out`),
              "stdout log"
            );
            safeMove(
              path.join(rootDir, "logs", `${tid}.err`),
              path.join(archiveRootDir, "logs", `${tid}.err`),
              "stderr log"
            );

            // Clean any stale control files
            const cancelPath = path.join(rootDir, "control", `${tid}.cancel`);
            if (fs.existsSync(cancelPath)) {
              try { fs.unlinkSync(cancelPath); } catch {}
            }

            if (taskFileMoved && !moveErrorOccurred) {
              deletedCount++;
            }
          }

          audit(rootDir, {
            tool: "http_tasks_archive",
            state: `archived_${deletedCount}_tasks`,
          });

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            deletedCount,
            archivedCount: deletedCount,
            cleanedWorktrees,
            errors: errors.length > 0 ? errors : undefined,
            message: `成功归档 ${deletedCount} 条任务${cleanedWorktrees.length > 0 ? `，清理 ${cleanedWorktrees.length} 个 Worktree` : ""}${errors.length > 0 ? `（${errors.join("; ")}）` : ""}`,
          }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
        }
        return;
      }

      // API: Requirements Backlog
      if (pathname === "/api/requirements") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (method === "GET") {
          const project = url.searchParams.get("project") || undefined;
          const status = (url.searchParams.get("status") as any) || undefined;
          const topic = url.searchParams.get("topic") || undefined;

          try {
            const requirements = listRequirements(defaultInstance.rootDir, { project, status, topic });
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, requirements }));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }

        if (method === "POST") {
          if (!isAuthorizedRequest()) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
            return;
          }
          const body = await readBody();
          const action = body?.action;

          try {
            if (action === "create") {
              const { project, title, raw_text, topic, session_id, tags } = body;
              if (!project || !title || !raw_text) {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, error: "Missing required fields: project, title, raw_text" }));
                return;
              }
              const id = generateRequirementId();
              const now = new Date().toISOString();
              const rec = {
                id,
                project: String(project).trim(),
                topic: (topic || session_id || "").trim() || undefined,
                session_id: (session_id || topic || "").trim() || undefined,
                title: String(title).trim(),
                raw_text: String(raw_text).trim(),
                tags: Array.isArray(tags) ? tags : [],
                status: "draft" as const,
                created_at: now,
                updated_at: now,
              };
              writeRequirement(defaultInstance.rootDir, rec);
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, requirement: rec }));
              return;
            }

            if (action === "update") {
              const { id, title, raw_text, tags, topic, status } = body;
              const rec = getRequirement(defaultInstance.rootDir, id);
              if (!rec) {
                res.statusCode = 404;
                res.end(JSON.stringify({ success: false, error: `Requirement "${id}" not found` }));
                return;
              }
              if (title !== undefined) rec.title = String(title).trim();
              if (raw_text !== undefined) rec.raw_text = String(raw_text).trim();
              if (tags !== undefined) rec.tags = Array.isArray(tags) ? tags : [];
              if (topic !== undefined) {
                rec.topic = topic ? String(topic).trim() : undefined;
                rec.session_id = rec.topic;
              }
              if (status !== undefined) rec.status = status;
              rec.updated_at = new Date().toISOString();
              writeRequirement(defaultInstance.rootDir, rec);
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, requirement: rec }));
              return;
            }

            if (action === "delete") {
              const { id } = body;
              const ok = deleteRequirement(defaultInstance.rootDir, id);
              res.statusCode = ok ? 200 : 404;
              res.end(JSON.stringify({ success: ok, error: ok ? undefined : "Not found" }));
              return;
            }

            if (action === "archive") {
              const { id } = body;
              const rec = getRequirement(defaultInstance.rootDir, id);
              if (!rec) {
                res.statusCode = 404;
                res.end(JSON.stringify({ success: false, error: `Requirement "${id}" not found` }));
                return;
              }
              rec.status = "archived";
              rec.updated_at = new Date().toISOString();
              writeRequirement(defaultInstance.rootDir, rec);
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, requirement: rec }));
              return;
            }

            if (action === "dispatch") {
              const { id, agent, model, reasoning_effort, account, queue_if_busy } = body;
              const rec = getRequirement(defaultInstance.rootDir, id);
              if (!rec) {
                res.statusCode = 404;
                res.end(JSON.stringify({ success: false, error: `Requirement "${id}" not found` }));
                return;
              }
              const effectiveSessionId = rec.session_id || rec.topic;
              if (effectiveSessionId && queue_if_busy && isSessionBusy(defaultInstance.rootDir, effectiveSessionId)) {
                const enqRes = enqueueTask(defaultInstance.rootDir, {
                  session_id: effectiveSessionId,
                  prompt: rec.raw_text,
                  options: {
                    title: rec.title,
                    agent,
                    model,
                    reasoning_effort,
                    account,
                    requirement_id: rec.id,
                  },
                  mode: "auto",
                });
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, queued: true, queueId: enqRes.id, position: enqRes.position }));
                return;
              }

              const dispatchRes = dispatchTaskDirect(defaultInstance.rootDir, {
                prompt: rec.raw_text,
                title: rec.title,
                agent,
                model,
                reasoning_effort,
                account,
                continue_session: !!effectiveSessionId,
                session_id: effectiveSessionId,
              });

              const now = new Date().toISOString();
              rec.status = "dispatched";
              rec.task_id = dispatchRes.taskId;
              rec.dispatched_at = now;
              rec.updated_at = now;
              writeRequirement(defaultInstance.rootDir, rec);

              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, taskId: dispatchRes.taskId }));
              return;
            }

            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: `Unknown action: "${action}"` }));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }
      }

      // API: Task Queue
      if (pathname === "/api/queue") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (method === "GET") {
          const sessionId = url.searchParams.get("session_id") || undefined;
          try {
            const queues = listAllSessionQueues(defaultInstance.rootDir);
            const items = listQueue(defaultInstance.rootDir, sessionId);
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, queues, items }));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }

        if (method === "POST") {
          if (!isAuthorizedRequest()) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
            return;
          }
          const body = await readBody();
          const action = body?.action;

          try {
            if (action === "pause") {
              const { session_id, reason } = body;
              const ok = pauseQueue(defaultInstance.rootDir, session_id, reason);
              res.statusCode = 200;
              res.end(JSON.stringify({ success: ok }));
              return;
            }

            if (action === "resume") {
              const { session_id } = body;
              const ok = resumeQueue(defaultInstance.rootDir, session_id);
              res.statusCode = 200;
              res.end(JSON.stringify({ success: ok }));
              return;
            }

            if (action === "cancel") {
              const { id } = body;
              const ok = cancelQueueItem(defaultInstance.rootDir, id);
              res.statusCode = 200;
              res.end(JSON.stringify({ success: ok }));
              return;
            }

            if (action === "reorder") {
              const { session_id, ordered_ids, move_id, to_position } = body;
              const moveItem =
                move_id && to_position !== undefined
                  ? { id: String(move_id), target_position: Number(to_position) }
                  : undefined;
              const result = reorderQueue(
                defaultInstance.rootDir,
                String(session_id || "").trim(),
                ordered_ids,
                moveItem
              );
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "update") {
              const { id, prompt, mode, options } = body;
              const ok = updateQueueItem(defaultInstance.rootDir, id, { prompt, mode, options });
              res.statusCode = 200;
              res.end(JSON.stringify({ success: ok }));
              return;
            }

            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: `Unknown queue action: "${action}"` }));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }
      }

      // API: Account Pool & Cockpit Integration
      if (pathname === "/api/pool") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (method === "GET") {
          try {
            const pool = queryPoolStatus(defaultInstance.rootDir);
            const profiles = loadPoolConfig(defaultInstance.rootDir);
            let cockpitAccounts: any[] = [];
            try {
              cockpitAccounts = listAccountsFromCockpitStorage("antigravity");
            } catch {}
            const runningTasks = Object.fromEntries(getRunningTasksPerProfile(defaultInstance.rootDir));

            res.statusCode = 200;
            res.end(
              JSON.stringify({
                success: true,
                pool,
                profiles,
                cockpitAccounts,
                runningTasks,
                accounts: queryAccountOverview(defaultInstance.rootDir, cockpitAccounts),
                custom_pool_enabled: isCustomPoolEnabled(defaultInstance.rootDir),
              })
            );
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }

        if (method === "POST") {
          if (!isAuthorizedRequest()) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
            return;
          }
          const body = await readBody();
          const action = body?.action;

          try {
            if (action === "init") {
              const { alias, email, cockpit_account_id } = body;
              const result = initPoolProfile(defaultInstance.rootDir, {
                alias,
                email,
                cockpit_account_id,
              });
              if (!result.success || !result.profile) {
                res.statusCode = 400;
                res.end(JSON.stringify(result));
                return;
              }

              // Primary path: reuse Cockpit auth into the new profile HOME (no terminal / paste).
              let authSync: any = null;
              const accountId = String(cockpit_account_id || result.profile.cockpit_account_id || "").trim();
              if (accountId || result.profile.email) {
                authSync = await syncProfileAuthFromCockpit(
                  defaultInstance.rootDir,
                  result.profile.alias,
                  { logger, accountId: accountId || undefined }
                );
              }

              const login = detectProfileLoginStatus(
                loadPoolConfig(defaultInstance.rootDir).find((p) => p.alias === result.profile!.alias) ||
                  result.profile
              );

              res.statusCode = 200;
              res.end(
                JSON.stringify({
                  ...result,
                  authSync,
                  login_status: login.status,
                  login_label: login.label,
                  ...(login.reason ? { login_reason: login.reason } : {}),
                })
              );
              return;
            }

            if (action === "sync_auth") {
              const { alias, cockpit_account_id } = body;
              if (!alias || typeof alias !== "string") {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, error: "alias is required" }));
                return;
              }
              const syncRes = await syncProfileAuthFromCockpit(defaultInstance.rootDir, alias.trim(), {
                logger,
                accountId: cockpit_account_id ? String(cockpit_account_id).trim() : undefined,
              });
              res.statusCode = syncRes.success ? 200 : 400;
              res.end(JSON.stringify(syncRes));
              return;
            }

            if (action === "pause") {
              const { alias, until } = body;
              const result = pausePoolProfile(defaultInstance.rootDir, alias, until);
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "remove") {
              const { alias, delete_home } = body;
              if (!alias || typeof alias !== "string") {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, error: "alias is required" }));
                return;
              }
              const result = removePoolProfile(defaultInstance.rootDir, alias.trim(), { deleteHome: delete_home === true });
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "set_custom_enabled") {
              const result = setCustomPoolEnabled(defaultInstance.rootDir, body?.enabled !== false);
              res.statusCode = 200;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "resume_email") {
              const { email } = body;
              const targetEmail = String(email || "").trim().toLowerCase();
              resumeEmail(defaultInstance.rootDir, targetEmail);
              // Also resume matching profiles in agy-pool.json if any
              try {
                const profiles = loadPoolConfig(defaultInstance.rootDir);
                for (const p of profiles) {
                  if (p.email && p.email.trim().toLowerCase() === targetEmail) {
                    resumePoolProfile(defaultInstance.rootDir, p.alias);
                  }
                }
              } catch {}
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true }));
              return;
            }

            if (action === "resume") {
              const { alias } = body;
              const prof = loadPoolConfig(defaultInstance.rootDir).find((p) => p.alias === alias);
              if (prof?.email) resumeEmail(defaultInstance.rootDir, prof.email);
              const result = resumePoolProfile(defaultInstance.rootDir, alias);
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "bind_email") {
              const { alias, email } = body;
              const result = bindProfileEmail(defaultInstance.rootDir, alias, email);
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "switch_cockpit") {
              const { account, runtime_target } = body;
              const result = await switchAgentAccount({
                provider: "antigravity",
                targetEmailOrAccount: account,
                runtimeTarget: runtime_target || "antigravity",
                logger,
              });
              res.statusCode = result.success ? 200 : 500;
              res.end(JSON.stringify(result));
              return;
            }

            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: `Unknown pool action: "${action}"` }));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }
      }

      // 5. Health & Status
      if (pathname === "/" || pathname === "/health" || pathname === "/status") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.statusCode = 200;
        res.end(
          JSON.stringify(
            {
              service: "agent-bridge-mcp",
              status: "online",
              version: "1.0.0",
              endpoints: {
                mcp: "/mcp",
                sse: "/sse",
                messages: "/messages",
                dashboard: "/dashboard",
              },
              toolsAvailable: 39,
              activeSessions: sessions.size,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          )
        );
        return;
      }

      // 4. Streamable HTTP endpoint (/mcp)
      if (pathname === "/mcp") {
        if (method === "POST") {
          if (!isAuthorizedRequest()) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "Forbidden: Write operation requires authorization" }));
            return;
          }
          const body = await readBody();
          const sessionId = (req.headers["mcp-session-id"] || req.headers["x-mcp-session-id"]) as string | undefined;

          let transport: StreamableHTTPServerTransport;

          if (sessionId && sessions.has(sessionId)) {
            const rec = sessions.get(sessionId)!;
            rec.lastActive = Date.now();
            transport = rec.transport as StreamableHTTPServerTransport;
          } else if (body && isInitializeRequest(body)) {
            // New initialization request
            const sInstance = createBridgeMcpServer(options.customRootDir);
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableJsonResponse: true,
              onsessioninitialized: (newSid) => {
                logger.info(`StreamableHTTP session initialized: ${newSid}`);
                sessions.set(newSid, {
                  transport,
                  serverInstance: sInstance,
                  type: "streamable",
                  lastActive: Date.now(),
                });
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid && sessions.has(sid)) {
                logger.info(`Session closed: ${sid}`);
                sessions.delete(sid);
              }
            };

            await sInstance.server.connect(transport);
          } else {
            // Stateless mode for validator probes or one-off tool queries
            const sInstance = createBridgeMcpServer(options.customRootDir);
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
              enableJsonResponse: true,
            });
            await sInstance.server.connect(transport);
          }

          await transport.handleRequest(req, res, body);
          return;
        }

        if (method === "GET") {
          const sessionId = (req.headers["mcp-session-id"] || req.headers["x-mcp-session-id"]) as string | undefined;
          if (sessionId && sessions.has(sessionId)) {
            const rec = sessions.get(sessionId)!;
            rec.lastActive = Date.now();
            await (rec.transport as StreamableHTTPServerTransport).handleRequest(req, res);
            return;
          }

          // If client attempts GET /mcp with text/event-stream without an active session
          const sInstance = createBridgeMcpServer(options.customRootDir);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSid) => {
              sessions.set(newSid, {
                transport,
                serverInstance: sInstance,
                type: "streamable",
                lastActive: Date.now(),
              });
            },
          });
          await sInstance.server.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        if (method === "DELETE") {
          const sessionId = (req.headers["mcp-session-id"] || req.headers["x-mcp-session-id"]) as string | undefined;
          if (sessionId && sessions.has(sessionId)) {
            const rec = sessions.get(sessionId)!;
            await rec.transport.close();
            sessions.delete(sessionId);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ status: "ok", message: `Session ${sessionId} closed` }));
            return;
          }
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }

        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      // 5. Deprecated HTTP+SSE transport (/sse and /messages)
      if (pathname === "/sse" && method === "GET") {
        const sInstance = createBridgeMcpServer(options.customRootDir);
        const transport = new SSEServerTransport("/messages", res);
        const sid = transport.sessionId;

        sessions.set(sid, {
          transport,
          serverInstance: sInstance,
          type: "sse",
          lastActive: Date.now(),
        });

        transport.onclose = () => {
          logger.info(`SSE Session closed: ${sid}`);
          sessions.delete(sid);
        };

        await sInstance.server.connect(transport);
        logger.info(`SSE client connected with session ID: ${sid}`);
        return;
      }

      if (pathname === "/messages" && method === "POST") {
        const sid =
          url.searchParams.get("sessionId") ||
          (req.headers["mcp-session-id"] as string) ||
          (req.headers["x-mcp-session-id"] as string);

        if (!sid || !sessions.has(sid)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Session not found", sessionId: sid }));
          return;
        }

        const session = sessions.get(sid)!;
        if (session.type !== "sse") {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Session is not an SSE session" }));
          return;
        }

        session.lastActive = Date.now();
        const body = await readBody();
        await (session.transport as SSEServerTransport).handlePostMessage(req, res, body);
        return;
      }

      // 6. Default 404
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Not Found", path: pathname }));
    } catch (err: any) {
      logger.error(`Error handling ${method} ${pathname}: ${err?.message || String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal Server Error", message: err?.message || String(err) }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    nodeServer.on("error", (err) => {
      logger.error(`HTTP server failed to bind: ${err.message}`);
      reject(err);
    });

    nodeServer.listen(port, host, () => {
      const address = nodeServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      logger.info(`agent-bridge-mcp HTTP server listening on http://${host}:${actualPort}/mcp`);

      resolve({
        server: nodeServer,
        port: actualPort,
        host,
        mcpServerInstance: defaultInstance,
        close: async () => {
          clearInterval(pruneInterval);
          for (const [, rec] of sessions) {
            await rec.transport.close().catch(() => {});
          }
          sessions.clear();
          return new Promise<void>((res) => {
            nodeServer.close(() => res());
          });
        },
      });
    });
  });
}
