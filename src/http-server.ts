import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createBridgeMcpServer, BridgeMcpServerInstance } from "./server.js";
import { BridgeLogger } from "./logger.js";

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
      // 3. Health & Status
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
              },
              toolsAvailable: 22,
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
