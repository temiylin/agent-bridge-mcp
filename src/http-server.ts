import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBridgeMcpServer, BridgeMcpServerInstance } from "./server.js";

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

/**
 * Starts an HTTP/SSE server for agent-bridge-mcp.
 * Implements the MCP Streamable HTTP specification.
 */
export async function startHttpServer(options: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 38080);
  const host = options.host ?? (process.env.HOST || "0.0.0.0");

  const mcpServerInstance = createBridgeMcpServer(options.customRootDir);
  const { server: mcpServer, logger } = mcpServerInstance;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await mcpServer.connect(transport);
  logger.info("Connected MCP server to StreamableHTTPServerTransport");

  const nodeServer = http.createServer(async (req, res) => {
    // 1. CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, mcp-session-id, x-mcp-session-id, authorization"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, x-mcp-session-id, content-type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // 2. Health check and root info
    if (pathname === "/" || pathname === "/health" || pathname === "/status") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.statusCode = 200;
      res.end(
        JSON.stringify(
          {
            service: "agent-bridge-mcp",
            status: "online",
            version: "1.0.0",
            mcpEndpoint: "/mcp",
            sseEndpoint: "/sse",
            toolsAvailable: 15,
            timestamp: new Date().toISOString(),
          },
          null,
          2
        )
      );
      return;
    }

    // 3. MCP Streamable HTTP / SSE endpoint
    if (pathname === "/mcp" || pathname === "/sse") {
      try {
        await transport.handleRequest(req, res);
      } catch (err: any) {
        logger.error(`Error handling MCP request: ${err?.message || String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal Server Error", message: err?.message || String(err) }));
        }
      }
      return;
    }

    // 4. Default 404
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not Found", path: pathname }));
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
        mcpServerInstance,
        close: async () => {
          return new Promise<void>((res) => {
            nodeServer.close(() => res());
          });
        },
      });
    });
  });
}
