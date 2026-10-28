#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeMcpServer } from "./server.js";
import { startHttpServer } from "./http-server.js";

export { createBridgeMcpServer } from "./server.js";
export { startHttpServer } from "./http-server.js";

async function main() {
  const args = process.argv.slice(2);
  const isHttp =
    args.includes("--http") ||
    args.includes("--serve") ||
    process.env.AGENT_BRIDGE_HTTP === "1" ||
    process.env.AGENT_BRIDGE_MODE === "http";

  if (isHttp) {
    // Parse port if provided: --port 38080 or -p 38080
    let port = 38080;
    const portIdx = args.findIndex((arg) => arg === "--port" || arg === "-p");
    if (portIdx !== -1 && args[portIdx + 1]) {
      const parsed = parseInt(args[portIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        port = parsed;
      }
    } else if (process.env.PORT) {
      const parsed = parseInt(process.env.PORT, 10);
      if (!isNaN(parsed) && parsed > 0) {
        port = parsed;
      }
    }

    let host = "0.0.0.0";
    const hostIdx = args.findIndex((arg) => arg === "--host");
    if (hostIdx !== -1 && args[hostIdx + 1]) {
      host = args[hostIdx + 1];
    } else if (process.env.HOST) {
      host = process.env.HOST;
    }

    const { port: actualPort, host: actualHost } = await startHttpServer({ port, host });
    console.log(`\n==================================================`);
    console.log(`🚀 agent-bridge-mcp HTTP/SSE Server Started`);
    console.log(`📡 Local Endpoint: http://localhost:${actualPort}/mcp`);
    console.log(`🏥 Health Check:   http://localhost:${actualPort}/health`);
    console.log(`==================================================\n`);
    return;
  }

  // Default: stdio transport (compatible with Claude Desktop, Codex CLI, etc.)
  const { server, logger } = createBridgeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("agent-bridge-mcp connected to stdio transport");
}

main().catch((error) => {
  console.error(`Fatal error in agent-bridge-mcp: ${error?.message || String(error)}`);
  process.exit(1);
});
