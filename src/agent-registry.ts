import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

export interface AgentSummaryItem {
  name: string;
  enabled: boolean;
}

export function registerAgentRegistryTool(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  server.tool(
    "agent_registry_summary",
    "List registered agent names and their enabled status without exposing underlying commands, args, or paths.",
    {},
    async () => {
      audit(rootDir, { tool: "agent_registry_summary" });

      const agentsFilePath = path.join(rootDir, "agents.json");
      const items: AgentSummaryItem[] = [];

      try {
        if (fs.existsSync(agentsFilePath)) {
          const raw = fs.readFileSync(agentsFilePath, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const name of Object.keys(parsed)) {
              items.push({
                name,
                enabled: true,
              });
            }
          }
        }
      } catch (err: any) {
        logger.warn(`agent_registry_summary: error reading agents.json: ${err?.message || String(err)}`);
      }

      items.sort((a, b) => a.name.localeCompare(b.name));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    }
  );
}
