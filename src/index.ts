#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import { resolveBridgeRoot, ensureBridgeDirectories } from "./config.js";
import { isValidTaskId, generateTaskId, resolveSafePath } from "./validator.js";
import { BridgeLogger } from "./logger.js";
import { loadAgents } from "./agents.js";
import { audit } from "./audit.js";
import { registerOpsTools } from "./ops-tools.js";
import { registerRepoStatusTool } from "./repo-status.js";
import { registerWorkerAliveTool } from "./worker-alive.js";

// Initialize data directories and logger
const rootDir = resolveBridgeRoot();
const { tasksDir, resultsDir, logsDir } = ensureBridgeDirectories(rootDir);
const logger = new BridgeLogger(logsDir);

logger.info(`Initializing agent-bridge-mcp. AGENT_BRIDGE_ROOT=${rootDir}`);

// Create MCP Server instance
const server = new McpServer({
  name: "agent-bridge-mcp",
  version: "1.0.0",
});

/**
 * Tool 1: send_task
 * Dispatches a prompt to local agents by writing it to tasks/<task_id>.md.
 */
server.tool(
  "send_task",
  "Dispatch a task to local agents by writing the task prompt to a file.",
  {
    prompt: z.string().describe("Task prompt content for the local agent (plain text)"),
    title: z.string().optional().describe("Optional task title"),
    agent: z.string().optional().describe("Optional agent name (must be registered in agents.json)"),
  },
  async ({ prompt, title, agent }) => {
    try {
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Error: prompt must be a non-empty string.",
            },
          ],
        };
      }

      // Validate agents.json registry existence and format
      let registry: ReturnType<typeof loadAgents>;
      try {
        registry = loadAgents(rootDir);
      } catch (regErr: any) {
        logger.error(`send_task registry error: ${regErr.message}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error reading agent registry: ${regErr.message}`,
            },
          ],
        };
      }

      // Validate agent if provided
      let agentName = "";
      if (agent && typeof agent === "string" && agent.trim().length > 0) {
        const trimmedAgent = agent.trim();
        if (!(trimmedAgent in registry)) {
          const available = Object.keys(registry).join(", ") || "(none)";
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: Agent "${trimmedAgent}" is not registered in agents.json. Available agents: [${available}]`,
              },
            ],
          };
        }
        agentName = trimmedAgent;
      }

      const taskId = generateTaskId();
      const taskFilePath = resolveSafePath(tasksDir, rootDir, `${taskId}.md`);

      const createdAt = new Date().toISOString();
      const taskTitle = title && title.trim().length > 0 ? title.trim() : `Task ${taskId}`;

      const content = `# ${taskTitle}

- **Task ID**: ${taskId}
- **Agent**: ${agentName}
- **Created At**: ${createdAt}

---

## Prompt

${prompt}
`;

      fs.writeFileSync(taskFilePath, content, "utf8");
      logger.info(`send_task success: taskId=${taskId}, path=${taskFilePath}, title="${taskTitle}"`);

      audit(rootDir, { tool: "send_task", taskId, agent: agentName || undefined, state: "dispatched" });

      return {
        content: [
          {
            type: "text",
            text: `Task dispatched successfully.
task_id: ${taskId}
path: ${taskFilePath}`,
          },
        ],
      };
    } catch (err: any) {
      logger.error(`send_task error: ${err?.message || String(err)}`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error dispatching task: ${err?.message || String(err)}`,
          },
        ],
      };
    }
  }
);

/**
 * Tool 2: read_result
 * Reads results/<task_id>.md. If not present, returns a pending status description without crashing.
 */
server.tool(
  "read_result",
  "Read the execution result of a task by its task_id.",
  {
    task_id: z.string().describe("Task ID to retrieve result for"),
  },
  async ({ task_id }) => {
    try {
      // 1. Security constraint: task_id character whitelist validation
      if (!isValidTaskId(task_id)) {
        logger.warn(`read_result rejected invalid task_id: "${task_id}"`);
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

      // 2. Security constraint: verify resolved path is safely inside resultsDir and rootDir
      let resultFilePath: string;
      try {
        resultFilePath = resolveSafePath(resultsDir, rootDir, `${task_id}.md`);
      } catch (pathErr: any) {
        logger.warn(`read_result path traversal blocked for task_id "${task_id}": ${pathErr.message}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Access denied. Path traversal detected: ${pathErr.message}`,
            },
          ],
        };
      }

      // 3. Check if result file exists. If not, return clear pending status description
      if (!fs.existsSync(resultFilePath)) {
        logger.info(`read_result: result for taskId=${task_id} is pending (file not found)`);
        audit(rootDir, { tool: "read_result", taskId: task_id, state: "pending" });
        return {
          content: [
            {
              type: "text",
              text: `Status: Pending. Result not ready yet for task "${task_id}". (Result file "${resultFilePath}" does not exist)`,
            },
          ],
        };
      }

      // 4. Return result file content
      const fileContent = fs.readFileSync(resultFilePath, "utf8");
      logger.info(`read_result: successfully retrieved result for taskId=${task_id}`);
      audit(rootDir, { tool: "read_result", taskId: task_id, state: "read" });

      return {
        content: [
          {
            type: "text",
            text: fileContent,
          },
        ],
      };
    } catch (err: any) {
      logger.error(`read_result error for taskId=${task_id}: ${err?.message || String(err)}`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error reading result: ${err?.message || String(err)}`,
          },
        ],
      };
    }
  }
);

// Register Ops Tools: get_task_status, cancel_task, read_task_output, read_result_page
registerOpsTools(server, rootDir, tasksDir, resultsDir, logsDir, logger);
registerRepoStatusTool(server, rootDir, logger);
registerWorkerAliveTool(server, rootDir, logger);

// Connect over stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("agent-bridge-mcp connected to stdio transport");
}

main().catch((error) => {
  logger.error(`Fatal error in agent-bridge-mcp: ${error?.message || String(error)}`);
  process.exit(1);
});
