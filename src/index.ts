#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeMcpServer } from "./server.js";
import { startHttpServer } from "./http-server.js";
import { startRelayClient } from "./client.js";

export { createBridgeMcpServer } from "./server.js";
export { startHttpServer } from "./http-server.js";
export { startRelayClient } from "./client.js";

async function main() {
  const args = process.argv.slice(2);

  // 1. Relay Client mode: connects outbound to Cloud Relay Hub (e.g. wss://bridge.krow.top/ws)
  const isConnect =
    args.includes("--connect") ||
    args.includes("connect") ||
    process.env.AGENT_BRIDGE_MODE === "connect";

  if (isConnect) {
    let serverUrl = process.env.RELAY_SERVER || "wss://bridge.krow.top/ws";
    const serverIdx = args.findIndex((arg) => arg === "--server" || arg === "-s");
    if (serverIdx !== -1 && args[serverIdx + 1]) {
      serverUrl = args[serverIdx + 1];
    }

    let token = process.env.DEVICE_TOKEN || "";
    const tokenIdx = args.findIndex((arg) => arg === "--token" || arg === "-t");
    if (tokenIdx !== -1 && args[tokenIdx + 1]) {
      token = args[tokenIdx + 1];
    }
    if (!token) {
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const os = await import("node:os");
        const cfgPath = path.join(os.homedir(), ".agent-bridge", "config.json");
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          if (cfg.deviceToken) token = cfg.deviceToken;
        }
      } catch {}
    }
    if (!token) {
      token = "dev_default";
    }

    await startRelayClient({ serverUrl, token });
    return;
  }

  // 2. HTTP/SSE Standalone Server mode: listens locally on HTTP port
  const isHttp =
    args.includes("--http") ||
    args.includes("--serve") ||
    process.env.AGENT_BRIDGE_HTTP === "1" ||
    process.env.AGENT_BRIDGE_MODE === "http";

  if (isHttp) {
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

  // 3. Default: stdio transport (compatible with Claude Desktop, Codex CLI, etc.)
  const { server, logger } = createBridgeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("agent-bridge-mcp connected to stdio transport");
}

main().catch((error) => {
  console.error(`Fatal error in agent-bridge-mcp: ${error?.message || String(error)}`);
  process.exit(1);
});
