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
} from "./queue.js";
import {
  queryPoolStatus,
  loadPoolConfig,
  initPoolProfile,
  pausePoolProfile,
  resumePoolProfile,
  bindProfileEmail,
  getRunningTasksPerProfile,
} from "./account-pool.js";
import { listAccountsFromCockpitStorage, switchAgentAccount } from "./account-manager.js";

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
  const host = options.host ?? (process.env.HOST || "0.0.0.0");

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

    // 1. CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD, DELETE");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, mcp-session-id, x-mcp-session-id, authorization"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, x-mcp-session-id, content-type");

    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

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

      if (isHtmlRequest && (pathname === "/" || pathname === "/dashboard" || pathname === "/admin")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.statusCode = 200;
        res.end(renderDashboardHtml());
        return;
      }

      // 4. REST APIs for Local Web Dashboard
      if (pathname === "/api/config") {
        if (method === "GET") {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          let deviceToken = "dev_default";
          const cfgPath = path.join(os.homedir(), ".agent-bridge", "config.json");
          if (fs.existsSync(cfgPath)) {
            try {
              const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
              if (cfg.deviceToken) deviceToken = cfg.deviceToken;
            } catch {}
          }
          let agents: any = {};
          try {
            agents = loadAgents(defaultInstance.rootDir);
          } catch {}
          const routing = loadRoutingConfig(defaultInstance.rootDir);
          const relayHttp = process.env.RELAY_HTTP || "https://bridge.krow.top/mcp";
          const deviceUrl = `${relayHttp}/${deviceToken}`;

          res.statusCode = 200;
          res.end(JSON.stringify({ deviceToken, deviceUrl, agents, routing }, null, 2));
          return;
        }

        if (method === "POST") {
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
              })
            );
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
          }
          return;
        }

        if (method === "POST") {
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
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "pause") {
              const { alias, until } = body;
              const result = pausePoolProfile(defaultInstance.rootDir, alias, until);
              res.statusCode = result.success ? 200 : 400;
              res.end(JSON.stringify(result));
              return;
            }

            if (action === "resume") {
              const { alias } = body;
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
