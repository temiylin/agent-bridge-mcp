import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSelfCheck } from "./self-check.js";
import { BridgeLogger } from "./logger.js";

/**
 * Registers the startup self-check MCP tool (self_check)
 */
export function registerSelfCheckTool(server: McpServer, rootDir: string, logger: BridgeLogger): void {
  server.tool(
    "self_check",
    "Startup and runtime self-check tool that verifies the local background worker process is alive and active, and checks that each registered agent CLI binary in agents.json runs and responds properly.",
    {},
    async () => {
      try {
        const report = runSelfCheck(rootDir);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
          isError: !report.ok,
        };
      } catch (err: any) {
        logger.error(`self_check failed: ${err?.message || String(err)}`);
        return {
          content: [
            {
              type: "text",
              text: `Self-check execution failed: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
