import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import { resolveBridgeRoot, ensureBridgeDirectories } from "./config.js";
import { isValidTaskId, generateTaskId, resolveSafePath } from "./validator.js";
import { BridgeLogger } from "./logger.js";
import { loadAgents } from "./agents.js";
import { audit } from "./audit.js";
import { writeStatus } from "./status.js";
import { registerOpsTools } from "./ops-tools.js";
import { registerRepoStatusTool } from "./repo-status.js";
import { registerWorkerAliveTool } from "./worker-alive.js";
import { registerListTasksTool } from "./list-tasks.js";
import { registerAgentRegistryTool } from "./agent-registry.js";
import { registerDeviceInfoTool } from "./device-info.js";
import { registerLocalFsTools } from "./local-fs.js";
import { registerModelsTool } from "./models.js";
import { registerTerminalTools } from "./terminal.js";
import { registerProjectInspectionTool } from "./project-inspection.js";
import { registerGitTools } from "./git-tools.js";
import { registerGitHubPrTools } from "./github-pr.js";
import { registerNotificationTools } from "./notification-tools.js";
import { registerSelfCheckTool } from "./self-check-tool.js";
import { registerBridgeRound2Tools } from "./round2-tools.js";
import { resolveTaskAgent } from "./routing.js";
import { resolveProject } from "./project-router.js";

export interface BridgeMcpServerInstance {
  server: McpServer;
  rootDir: string;
  tasksDir: string;
  resultsDir: string;
  logsDir: string;
  logger: BridgeLogger;
}

/**
 * Creates and initializes an McpServer instance with all agent-bridge-mcp tools registered.
 */
export function createBridgeMcpServer(customRootDir?: string): BridgeMcpServerInstance {
  const rootDir = customRootDir || resolveBridgeRoot();
  const { tasksDir, resultsDir, logsDir } = ensureBridgeDirectories(rootDir);
  const logger = new BridgeLogger(logsDir);

  logger.info(`Initializing agent-bridge-mcp. AGENT_BRIDGE_ROOT=${rootDir}`);

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
      model: z.string().optional().describe("Optional model identifier for the execution agent (e.g., 'gpt-6.1', 'o3', 'gpt-6-luna')"),
      reasoning_effort: z.string().optional().describe("Optional reasoning effort for the model (e.g., 'low', 'medium', 'high', 'xhigh')"),
      continue_session: z.boolean().optional().describe("If true, resumes and continues the previous agent conversation session (e.g., codex exec resume --last or agy --continue)"),
      session_id: z.string().optional().describe("Optional specific session or thread ID to resume"),
      notify: z
        .union([
          z.boolean().describe("简单布尔值：传 true 开启默认本地电脑通知（完成/超时/卡住/失败时弹窗+声音），传 false 关闭"),
          z
            .object({
              enabled: z.boolean().optional().describe("是否启用通知，默认 true"),
              channel: z
                .enum(["desktop", "sound_only", "none"])
                .optional()
                .describe("通知方式: 'desktop' (桌面横幅+声音), 'sound_only' (仅声音), 'none' (静默)"),
              sound: z
                .union([z.boolean(), z.string()])
                .optional()
                .describe("是否播放提示音 (true/false) 或指定声音名 (如 'Hero', 'Ping', 'Basso')"),
              on: z
                .array(z.enum(["completed", "failed", "timeout", "stuck"]))
                .optional()
                .describe("何时通知，默认全部包含: ['completed', 'failed', 'timeout', 'stuck']"),
              timeout_seconds: z
                .number()
                .optional()
                .describe("规定时间内没有完成告警的超时秒数"),
            })
            .describe("二级通知配置对象"),
        ])
        .optional()
        .describe("任务通知配置：传 true 开启默认电脑通知；或传二级参数对象精细控制方式与时机"),
      timeout_seconds: z.number().optional().describe("规定时间内没有完成告警的超时秒数（简写参数，与 notify.timeout_seconds 作用一致）"),
      project_id: z.string().optional().describe("所属项目标识，用于路由至对应的 Slack 项目频道及配置项目属性"),
      project_dir: z.string().optional().describe("项目工作目录路径，用于根据 projects.json 自动匹配项目归属"),
      callback_url: z.string().optional().describe("任务完成后的 HTTP Webhook 回调地址 (POST JSON)"),
      callback_headers: z.record(z.string(), z.string()).optional().describe("回调请求自定义 Headers 字典 (键值对，环境变量名格式如 $API_KEY 或 API_KEY)"),
      worktree: z
        .object({
          base_branch: z.string().optional().describe("创建 worktree 的基准分支（默认当前或远程 HEAD）"),
          name: z.string().describe("worktree 目录及分支名称"),
        })
        .optional()
        .describe("可选 Git worktree 隔离环境配置"),
      on_success: z
        .union([
          z.string().describe("单条后续任务 prompt 或配置文件中的预设 prompt"),
          z.array(z.string()).describe("多条后续任务 prompt 列表"),
          z.object({
            prompt: z.string().describe("后续任务 prompt"),
            title: z.string().optional().describe("后续任务标题"),
            agent: z.string().optional().describe("后续任务 agent"),
            model: z.string().optional().describe("后续任务 model"),
          }),
          z.array(
            z.object({
              prompt: z.string().describe("后续任务 prompt"),
              title: z.string().optional().describe("后续任务标题"),
              agent: z.string().optional().describe("后续任务 agent"),
              model: z.string().optional().describe("后续任务 model"),
            })
          ),
        ])
        .optional()
        .describe("任务成功后自动触发的后续任务链 (Task chains)"),
    },
    async ({ prompt, title, agent, model, reasoning_effort, continue_session, session_id, notify, timeout_seconds, project_id, project_dir, callback_url, callback_headers, worktree, on_success }) => {
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

        // Resolve agent: explicit or smart routing
        let agentName = "";
        let routingReason = "";
        if (agent && typeof agent === "string" && agent.trim().length > 0 && agent.trim().toLowerCase() !== "auto") {
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
          routingReason = "explicitly specified";
        } else {
          const resolved = resolveTaskAgent(rootDir, prompt);
          agentName = resolved.agent;
          routingReason = resolved.reason;
        }

        // Validate model if provided
        let modelParam = "";
        if (model !== undefined && model !== null) {
          if (typeof model !== "string" || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(model.trim())) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Invalid model "${model}". Model identifier must be 1-128 characters containing only letters, numbers, hyphens, underscores, dots, colons, or slashes.`,
                },
              ],
            };
          }
          modelParam = model.trim();
        }

        // Validate reasoning_effort if provided
        let effortParam = "";
        if (reasoning_effort !== undefined && reasoning_effort !== null) {
          if (typeof reasoning_effort !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(reasoning_effort.trim())) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Invalid reasoning_effort "${reasoning_effort}". Must be 1-32 characters (e.g., 'low', 'medium', 'high', 'xhigh').`,
                },
              ],
            };
          }
          effortParam = reasoning_effort.trim().toLowerCase();
        }

        const taskId = generateTaskId();
        const taskFilePath = resolveSafePath(tasksDir, rootDir, `${taskId}.md`);

        const createdAt = new Date().toISOString();
        const taskTitle = title && title.trim().length > 0 ? title.trim() : `Task ${taskId}`;

        // Project Resolution & Slack Channel lookup
        const projectResolution = resolveProject(rootDir, {
          projectId: project_id,
          projectDir: project_dir,
        });

        if (projectResolution.conflict) {
          logger.warn(`Project routing conflict for task ${taskId}: ${projectResolution.reason}`);
        } else if (projectResolution.matched) {
          logger.info(`Task ${taskId} routed to project "${projectResolution.project?.name}" (${projectResolution.reason}) -> Slack: ${projectResolution.channelId || "(no channel)"}`);
        }

        let headerMeta = `- **Task ID**: ${taskId}\n- **Agent**: ${agentName}\n`;
        if (projectResolution.project?.id) headerMeta += `- **Project ID**: ${projectResolution.project.id}\n`;
        if (projectResolution.project?.name) headerMeta += `- **Project Name**: ${projectResolution.project.name}\n`;
        if (projectResolution.project?.repo) headerMeta += `- **Project Repo**: ${projectResolution.project.repo}\n`;
        if (projectResolution.project?.slack_webhook_env) headerMeta += `- **Slack Webhook Env**: ${projectResolution.project.slack_webhook_env}\n`;
        const effectiveProjectDir = project_dir || projectResolution.project?.paths?.[0];
        if (effectiveProjectDir) headerMeta += `- **Project Dir**: ${effectiveProjectDir}\n`;
        if (projectResolution.channelId) headerMeta += `- **Slack Channel**: ${projectResolution.channelId}\n`;
        if (projectResolution.conflict) headerMeta += `- **Routing Conflict**: true\n`;

        // Callback URL & Headers configuration (per-task or per-project fallback)
        const effectiveCallbackUrl = callback_url || projectResolution.project?.callback_url;
        const effectiveCallbackHeaders = callback_headers || projectResolution.project?.callback_headers;
        if (effectiveCallbackUrl) headerMeta += `- **Callback URL**: ${effectiveCallbackUrl}\n`;
        if (effectiveCallbackHeaders) headerMeta += `- **Callback Headers**: ${JSON.stringify(effectiveCallbackHeaders)}\n`;

        // Task Chains configuration (on_success)
        if (on_success) {
          headerMeta += `- **On Success**: ${JSON.stringify(on_success)}\n`;
        }

        // Worktree configuration
        if (worktree && worktree.name) {
          headerMeta += `- **Worktree Name**: ${worktree.name.trim()}\n`;
          if (worktree.base_branch) headerMeta += `- **Worktree Base Branch**: ${worktree.base_branch.trim()}\n`;
        }
        if (modelParam) headerMeta += `- **Model**: ${modelParam}\n`;
        if (effortParam) headerMeta += `- **Reasoning Effort**: ${effortParam}\n`;
        if (continue_session) headerMeta += `- **Continue Session**: true\n`;
        if (session_id && session_id.trim()) headerMeta += `- **Session ID**: ${session_id.trim()}\n`;

        // Parse notification settings (boolean or nested object)
        let notifyEnabled: boolean | undefined;
        let notifyChannel: string | undefined;
        let notifySound: boolean | string | undefined;
        let notifyOn: string[] | undefined;
        let effectiveTimeoutSec = timeout_seconds && timeout_seconds > 0 ? timeout_seconds : undefined;

        if (typeof notify === "boolean") {
          notifyEnabled = notify;
        } else if (notify && typeof notify === "object") {
          notifyEnabled = notify.enabled !== undefined ? notify.enabled : true;
          notifyChannel = notify.channel;
          notifySound = notify.sound;
          notifyOn = notify.on;
          if (notify.timeout_seconds && notify.timeout_seconds > 0) {
            effectiveTimeoutSec = notify.timeout_seconds;
          }
        }

        if (notifyEnabled !== undefined) headerMeta += `- **Notify**: ${notifyEnabled}\n`;
        if (notifyChannel) headerMeta += `- **Notify Channel**: ${notifyChannel}\n`;
        if (notifySound !== undefined) headerMeta += `- **Notify Sound**: ${notifySound}\n`;
        if (notifyOn && notifyOn.length > 0) headerMeta += `- **Notify On**: ${notifyOn.join(",")}\n`;
        if (effectiveTimeoutSec) headerMeta += `- **Timeout Seconds**: ${effectiveTimeoutSec}\n`;

        headerMeta += `- **Created At**: ${createdAt}\n`;

        const content = `# ${taskTitle}

${headerMeta}
---

## Prompt

${prompt}
`;

        fs.writeFileSync(taskFilePath, content, "utf8");
        logger.info(`send_task success: taskId=${taskId}, path=${taskFilePath}, title="${taskTitle}", agent="${agentName}", model="${modelParam}", effort="${effortParam}"`);

        audit(rootDir, {
          tool: "send_task",
          taskId,
          agent: agentName || undefined,
          state: "dispatched",
        });

        try {
          writeStatus(rootDir, taskId, {
            state: "queued",
            agent: agentName,
            model: modelParam || undefined,
            reasoningEffort: effortParam || undefined,
            startedAt: createdAt,
          });
        } catch {}

        let metaDetails = "";
        if (projectResolution.project?.name) metaDetails += `\nproject: ${projectResolution.project.name}`;
        if (projectResolution.channelId) metaDetails += `\nslack_channel: ${projectResolution.channelId}`;
        if (projectResolution.conflict) metaDetails += `\nrouting_conflict: true`;
        if (agentName) metaDetails += `\nagent: ${agentName}`;
        if (modelParam) metaDetails += `\nmodel: ${modelParam}`;
        if (effortParam) metaDetails += `\nreasoning_effort: ${effortParam}`;
        if (continue_session) metaDetails += `\ncontinue_session: true`;
        if (session_id && session_id.trim()) metaDetails += `\nsession_id: ${session_id.trim()}`;
        if (effectiveCallbackUrl) metaDetails += `\ncallback_url: ${effectiveCallbackUrl}`;
        if (worktree && worktree.name) metaDetails += `\nworktree: ${worktree.name}`;
        if (notifyEnabled !== undefined) metaDetails += `\nnotify: ${notifyEnabled}`;
        if (notifyChannel) metaDetails += `\nnotify_channel: ${notifyChannel}`;
        if (effectiveTimeoutSec) metaDetails += `\ntimeout_seconds: ${effectiveTimeoutSec}`;

        return {
          content: [
            {
              type: "text",
              text: `Task dispatched successfully.\ntask_id: ${taskId}\npath: ${taskFilePath}${metaDetails}`,
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
    "Read the execution result of a task by its task_id. Returns a compact summary by default (status, changed files, test results, PR url); full output on demand via full_output=true.",
    {
      task_id: z.string().describe("Task ID to retrieve result for"),
      full_output: z.boolean().optional().describe("If true, returns full unabridged execution result output. Default: false (compact summary)."),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ task_id, full_output = false }) => {
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

        // 4. Return result: full output on demand, compact summary by default
        const fileContent = fs.readFileSync(resultFilePath, "utf8");
        logger.info(`read_result: successfully retrieved result for taskId=${task_id} (full_output=${full_output})`);
        audit(rootDir, { tool: "read_result", taskId: task_id, state: "read" });

        if (full_output || process.env.AGENT_BRIDGE_RAW_RESULT === "1") {
          return {
            content: [
              {
                type: "text",
                text: fileContent,
              },
            ],
          };
        }

        // Generate compact summary (status, changed files, test results, PR url)
        const statusMatch = fileContent.match(/^-[ \t]*\*\*Status\*\*:[ \t]*([^\r\n]*)$/m);
        const statusStr = statusMatch ? statusMatch[1].trim() : "completed";

        const gitPrMatches = [...fileContent.matchAll(/https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/g)];
        const prUrl = gitPrMatches.length > 0 ? gitPrMatches[0][0] : undefined;

        // Changed files count / list
        const changedFilesMatch = [...fileContent.matchAll(/(?:modified|added|deleted|renamed|M|A|D|R):\s+([^\r\n]+)/g)];
        const changedFiles = changedFilesMatch.map((m) => m[1].trim());

        // Test pass/fail counts
        const passedMatch = fileContent.match(/(\d+)\s+(?:passing|passed)/i);
        const failedMatch = fileContent.match(/(\d+)\s+(?:failing|failed)/i);
        let testResults: { passed: number; failed: number } | undefined;
        if (passedMatch || failedMatch) {
          testResults = {
            passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
            failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
          };
        }

        const summaryLines: string[] = [
          `# Compact Result Summary for ${task_id}`,
          `- **Status**: ${statusStr}`,
        ];
        if (changedFiles.length > 0) {
          summaryLines.push(`- **Changed Files**: ${changedFiles.length} file(s) [${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? "..." : ""}]`);
        }
        if (testResults) {
          summaryLines.push(`- **Test Results**: ${testResults.passed} passed, ${testResults.failed} failed`);
        }
        if (prUrl) {
          summaryLines.push(`- **PR URL**: ${prUrl}`);
        }
        summaryLines.push("\n*(Pass full_output=true to read the full execution log and output body)*");

        return {
          content: [
            {
              type: "text",
              text: summaryLines.join("\n"),
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
  registerListTasksTool(server, rootDir, logger);
  registerAgentRegistryTool(server, rootDir, logger);
  registerDeviceInfoTool(server, rootDir, logger);
  registerLocalFsTools(server, rootDir, logger);
  registerModelsTool(server, rootDir, logger);
  registerTerminalTools(server, rootDir, logger);
  registerProjectInspectionTool(server, rootDir, logger);
  registerGitTools(server, rootDir, logger);
  registerGitHubPrTools(server, rootDir, logger);
  registerNotificationTools(server, rootDir, logger);
  registerSelfCheckTool(server, rootDir, logger);
  registerBridgeRound2Tools(server, rootDir, logger);

  return { server, rootDir, tasksDir, resultsDir, logsDir, logger };
}
