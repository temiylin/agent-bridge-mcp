import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import { resolveBridgeRoot, ensureBridgeDirectories } from "./config.js";
import { isValidTaskId, generateTaskId, resolveSafePath } from "./validator.js";
import { BridgeLogger } from "./logger.js";
import { loadAgents } from "./agents.js";
import { audit } from "./audit.js";
import { writeStatus, readStatus, formatPreviousTaskContext, TaskStatusInfo } from "./status.js";
import { isPidAlive } from "./task-reconcile.js";
import path from "node:path";
import { registerOpsTools } from "./ops-tools.js";
import { registerRepoStatusTool } from "./repo-status.js";
import { registerWorkerAliveTool } from "./worker-alive.js";
import { registerListTasksTool } from "./list-tasks.js";
import { registerAgentRegistryTool } from "./agent-registry.js";
import { registerDeviceInfoTool } from "./device-info.js";
import { registerLocalFsTools } from "./local-fs.js";
import { registerModelsTool, getConfiguredDefaultModel, getValidModelIds } from "./models.js";
import { getAgentAccountQuota, formatQuotaLine } from "./account-quota.js";
import { registerTerminalTools } from "./terminal.js";
import { registerProjectInspectionTool } from "./project-inspection.js";
import { registerGitTools } from "./git-tools.js";
import { registerGitHubPrTools } from "./github-pr.js";
import { registerNotificationTools } from "./notification-tools.js";
import { registerSelfCheckTool } from "./self-check-tool.js";
import { registerBridgeRound2Tools } from "./round2-tools.js";
import { registerRequirementsTools } from "./requirements-tools.js";
import { registerQueueTools } from "./queue-tools.js";
import { registerRecentTasksTool } from "./recent-tasks.js";
import { registerWebhookTools } from "./webhook-tools.js";
import { registerAccountResumeTools } from "./account-resume-tools.js";
import { registerAccountPoolTools } from "./account-pool-tools.js";
import { setTaskWebhook, WebhookEvent } from "./webhook.js";
import { resolveTaskAgent } from "./routing.js";
import {
  resolveProject,
  getProjectRepoPath,
  validateGitRepoPath,
  buildProjectGitRulesPromptNote,
} from "./project-router.js";
import { registerProjectTools } from "./project-tools.js";
import { registerPlanTools } from "./plan-tools.js";
import { SERVER_INSTRUCTIONS, registerHelpTool } from "./help.js";
import { getPlan, formatPlanPromptPrefix, setPlanStepStatus, Plan, PlanStep } from "./plans.js";
import { getTaskReportDir, buildReportJsonPromptInstruction } from "./task-stage.js";

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

  const server = new McpServer(
    {
      name: "agent-bridge-mcp",
      version: "1.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

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
      model: z.string().optional().describe("Optional model id; must be one listed by list_models for the agent (invalid ids are rejected with the valid list). Omit to use the agent default (agy: gemini-3.8-flash-low, configurable via agents.json default_model)."),
      reasoning_effort: z.string().optional().describe("Optional reasoning effort for the model (e.g., 'low', 'medium', 'high', 'xhigh')"),
      continue_session: z.boolean().optional().describe("If true, resumes and continues the previous agent conversation session (e.g., codex exec resume --last or agy --continue)"),
      session_id: z.string().optional().describe("Optional specific session or thread ID to resume"),
      account: z.string().optional().describe("Optional agy account profile alias or 'auto' (default: auto)"),
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
                .array(z.enum(["completed", "failed", "timeout", "stuck", "overdue"]))
                .optional()
                .describe("何时通知，默认全部包含: ['completed', 'failed', 'timeout', 'stuck', 'overdue']"),
              timeout_seconds: z
                .number()
                .optional()
                .describe("Soft overdue alert: fire once after this many seconds if the task is still running (does not kill the process)"),
            })
            .describe("二级通知配置对象"),
        ])
        .optional()
        .describe("任务通知配置：传 true 开启默认电脑通知；或传二级参数对象精细控制方式与时机"),
      timeout_seconds: z
        .number()
        .optional()
        .describe(
          "Hard kill timeout in seconds: terminate the agent process if still running after this duration. Omit to use a 6h safety cap only (no shorter implicit kill). Soft overdue alerts use notify.timeout_seconds instead."
        ),
      project_id: z.string().optional().describe("所属项目标识，用于路由至对应的 Slack 项目频道及配置项目属性"),
      project_dir: z.string().optional().describe("项目工作目录路径：既作为 agent 的工作目录 (cwd)，也用于根据 projects.json 自动匹配项目归属。未传时使用匹配项目的 paths[0]"),
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
      on_complete: z
        .object({
          url: z.string().describe("Destination webhook URL (must be http/https)"),
          headers: z.record(z.string(), z.string()).optional().describe("Optional custom HTTP headers"),
          events: z
            .array(z.enum(["completed", "failed", "pr_opened", "stalled", "timeout", "stuck", "overdue", "cancelled"]))
            .optional()
            .describe("Events to trigger webhook on (default: ['completed', 'failed'])"),
          secret: z.string().optional().describe("Optional shared secret for HMAC-SHA256 signature in X-Agent-Bridge-Signature header"),
        })
        .optional()
        .describe("Opt-in per task completion webhook. Opt-in per task; do not enable globally; only callers that have a webhook (e.g. Grok Bot) should pass on_complete."),
      plan_id: z.string().optional().describe("Optional plan identifier to associate this task with"),
      step_id: z.string().optional().describe("Optional step identifier within the plan"),
      pr_url: z.string().optional().describe("Optional GitHub Pull Request URL to associate with this task (e.g. for PR review, testing, or rework)"),
      previous_task_id: z.string().optional().describe("Optional previous task ID to inherit context from (summary, outcome, PR URL, project linkage)"),
    },
    async ({ prompt, title, agent, model, reasoning_effort, continue_session, session_id, account, notify, timeout_seconds, project_id, project_dir, callback_url, callback_headers, worktree, on_success, on_complete, plan_id, step_id, pr_url, previous_task_id }) => {
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

        // Plan & Step validation if plan_id is provided
        let effectivePlan: Plan | null = null;
        let effectiveStep: PlanStep | null = null;
        let planPromptPrefix = "";
        let planVersion: number | undefined;
        let planTitle: string | undefined;

        if (plan_id && plan_id.trim()) {
          const cleanPlanId = plan_id.trim();
          if (!step_id || !step_id.trim()) {
            return {
              isError: true,
              content: [{ type: "text", text: "Error: step_id is required when plan_id is provided." }],
            };
          }
          const cleanStepId = step_id.trim();
          try {
            effectivePlan = getPlan(rootDir, cleanPlanId);
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error loading plan "${cleanPlanId}": ${err?.message || String(err)}` }],
            };
          }
          if (!effectivePlan) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error: Plan "${cleanPlanId}" not found.` }],
            };
          }
          effectiveStep = effectivePlan.steps.find((s) => s.id === cleanStepId) || null;
          if (!effectiveStep) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error: Step "${cleanStepId}" not found in plan "${cleanPlanId}".` }],
            };
          }

          planPromptPrefix = formatPlanPromptPrefix(rootDir, effectivePlan, effectiveStep);
          planVersion = effectivePlan.version;
          planTitle = effectivePlan.title;
        } else if (step_id && step_id.trim()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: step_id cannot be specified without plan_id." }],
          };
        }

        // Previous task context extraction if previous_task_id is provided
        const cleanPrevTaskId =
          previous_task_id && typeof previous_task_id === "string" && previous_task_id.trim().length > 0
            ? previous_task_id.trim()
            : undefined;
        let prevTaskContextPrefix = "";
        let prevTaskPrUrl: string | undefined;
        let prevTaskProjectId: string | undefined;

        if (cleanPrevTaskId) {
          const prevCtx = formatPreviousTaskContext(rootDir, cleanPrevTaskId);
          prevTaskContextPrefix = prevCtx.prefix;
          prevTaskPrUrl = prevCtx.prUrl;
          prevTaskProjectId = prevCtx.projectId;
        }

        // If project_id is omitted, inherit from plan or previous task automatically
        const effectiveProjectId =
          (project_id && project_id.trim()) ||
          (effectivePlan?.project_id && effectivePlan.project_id.trim()) ||
          prevTaskProjectId ||
          undefined;

        // Resolve project early so project-level defaults (agent, model, account, timeout, repo_path, base_branch, callback) apply
        const projectResolution = resolveProject(rootDir, {
          projectId: effectiveProjectId,
          projectDir: project_dir,
        });

        if (effectiveProjectId && !projectResolution.matched && !projectResolution.conflict) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: Unknown project_id "${effectiveProjectId}". Use list_projects or add_project to register it first.`,
              },
            ],
          };
        }

        const matchedProject = projectResolution.project;
        const configuredRepoPath = getProjectRepoPath(matchedProject);

        // If project_id matched a registered project with a repo_path, re-verify the path still exists and is a git repo
        if (matchedProject && !project_dir && configuredRepoPath) {
          const pathCheck = validateGitRepoPath(configuredRepoPath);
          if (!pathCheck.valid) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Project "${matchedProject.id}" repository path is invalid or has moved: ${pathCheck.error}`,
                },
              ],
            };
          }
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

        // Resolve agent: explicit -> project default_agent -> smart routing
        let agentName = "";
        let routingReason = "";
        const effectiveAgentArg =
          agent && typeof agent === "string" && agent.trim().length > 0 && agent.trim().toLowerCase() !== "auto"
            ? agent.trim()
            : matchedProject?.default_agent && matchedProject.default_agent.toLowerCase() !== "auto"
              ? matchedProject.default_agent.trim()
              : "";

        if (effectiveAgentArg) {
          if (!(effectiveAgentArg in registry)) {
            const available = Object.keys(registry).join(", ") || "(none)";
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Agent "${effectiveAgentArg}" is not registered in agents.json. Available agents: [${available}]`,
                },
              ],
            };
          }
          agentName = effectiveAgentArg;
          routingReason = agent && agent.trim() ? "explicitly specified" : `project "${matchedProject?.id}" default_agent`;
        } else {
          const resolved = resolveTaskAgent(rootDir, prompt);
          agentName = resolved.agent;
          routingReason = resolved.reason;
        }

        // Validate model if provided (or fallback to project default_model)
        let modelParam = "";
        const rawModelInput = model !== undefined && model !== null && String(model).trim() !== ""
          ? model
          : matchedProject?.default_model;
        if (rawModelInput !== undefined && rawModelInput !== null) {
          if (typeof rawModelInput !== "string" || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(rawModelInput.trim())) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Invalid model "${rawModelInput}". Model identifier must be 1-128 characters containing only letters, numbers, hyphens, underscores, dots, colons, or slashes.`,
                },
              ],
            };
          }
          modelParam = rawModelInput.trim();
        }

        // Reject models the agent does not offer (same catalog as list_models).
        let modelSource = model ? "explicit" : modelParam ? "project_default" : "";
        if (modelParam && process.env.AGENT_BRIDGE_SKIP_MODEL_VALIDATION !== "1") {
          const validIds = await withTimeout(getValidModelIds(rootDir, agentName).catch(() => null), 12000, null);
          if (validIds && validIds.length > 0 && !validIds.includes(modelParam)) {
            const def = getConfiguredDefaultModel(rootDir, agentName);
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: model "${modelParam}" is not available for agent "${agentName}". Valid models: [${validIds.join(", ")}]${def ? `\ndefault_model: ${def} (used when model is omitted)` : ""}`,
                },
              ],
            };
          }
        }
        if (!modelParam) {
          const def = getConfiguredDefaultModel(rootDir, agentName);
          if (def) {
            modelParam = def;
            modelSource = "default";
          }
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

        if (projectResolution.conflict) {
          logger.warn(`Project routing conflict for task ${taskId}: ${projectResolution.reason}`);
        } else if (projectResolution.matched) {
          logger.info(`Task ${taskId} routed to project "${matchedProject?.name}" (${projectResolution.reason}) -> Slack: ${projectResolution.channelId || "(no channel)"}`);
        }

        const effectiveAccount =
          account && account.trim()
            ? account.trim()
            : matchedProject?.default_account
              ? matchedProject.default_account.trim()
              : undefined;

        let headerMeta = `- **Task ID**: ${taskId}\n- **Agent**: ${agentName}\n`;
        if (matchedProject?.id) headerMeta += `- **Project ID**: ${matchedProject.id}\n`;
        if (matchedProject?.name) headerMeta += `- **Project Name**: ${matchedProject.name}\n`;
        if (matchedProject?.repo) headerMeta += `- **Project Repo**: ${matchedProject.repo}\n`;
        if (matchedProject?.slack_webhook_env) headerMeta += `- **Slack Webhook Env**: ${matchedProject.slack_webhook_env}\n`;
        const effectiveProjectDir = project_dir || configuredRepoPath;
        if (effectiveProjectDir) headerMeta += `- **Project Dir**: ${effectiveProjectDir}\n`;
        if (projectResolution.channelId) headerMeta += `- **Slack Channel**: ${projectResolution.channelId}\n`;
        if (projectResolution.conflict) headerMeta += `- **Routing Conflict**: true\n`;

        // Callback URL & Headers configuration (per-task or per-project fallback)
        const effectiveCallbackUrl = callback_url || matchedProject?.callback_url;
        const effectiveCallbackHeaders = callback_headers || matchedProject?.callback_headers;
        if (effectiveCallbackUrl) headerMeta += `- **Callback URL**: ${effectiveCallbackUrl}\n`;
        if (effectiveCallbackHeaders) headerMeta += `- **Callback Headers**: ${JSON.stringify(effectiveCallbackHeaders)}\n`;

        // Task Chains configuration (on_success)
        if (on_success) {
          headerMeta += `- **On Success**: ${JSON.stringify(on_success)}\n`;
        }

        // Worktree configuration (base_branch falls back to project default_base_branch)
        const effectiveBaseBranch = worktree?.base_branch?.trim() || matchedProject?.default_base_branch;
        if (worktree && worktree.name) {
          headerMeta += `- **Worktree Name**: ${worktree.name.trim()}\n`;
          if (effectiveBaseBranch) headerMeta += `- **Worktree Base Branch**: ${effectiveBaseBranch}\n`;
        }
        if (modelParam) headerMeta += `- **Model**: ${modelParam}\n`;
        if (effortParam) headerMeta += `- **Reasoning Effort**: ${effortParam}\n`;
        if (continue_session) headerMeta += `- **Continue Session**: true\n`;
        if (session_id && session_id.trim()) headerMeta += `- **Session ID**: ${session_id.trim()}\n`;
        if (effectiveAccount) headerMeta += `- **Account**: ${effectiveAccount}\n`;
        const rawPrUrl = pr_url && typeof pr_url === "string" && pr_url.trim().length > 0 ? pr_url.trim() : undefined;
        const cleanPrUrl = rawPrUrl || prevTaskPrUrl;
        if (cleanPrUrl) headerMeta += `- **PR URL**: ${cleanPrUrl}\n`;
        if (cleanPrevTaskId) headerMeta += `- **Previous Task ID**: ${cleanPrevTaskId}\n`;
        if (effectivePlan) {
          headerMeta += `- **Plan ID**: ${effectivePlan.id}\n`;
          headerMeta += `- **Plan Step ID**: ${effectiveStep!.id}\n`;
          headerMeta += `- **Plan Version**: ${planVersion}\n`;
          headerMeta += `- **Plan Title**: ${planTitle}\n`;
        }

        // Parse notification settings (boolean or nested object)
        let notifyEnabled: boolean | undefined;
        let notifyChannel: string | undefined;
        let notifySound: boolean | string | undefined;
        let notifyOn: string[] | undefined;
        let hardTimeoutSec =
          timeout_seconds && timeout_seconds > 0
            ? timeout_seconds
            : matchedProject?.default_timeout_seconds && matchedProject.default_timeout_seconds > 0
              ? matchedProject.default_timeout_seconds
              : undefined;
        let notifyOverdueSec: number | undefined;

        if (typeof notify === "boolean") {
          notifyEnabled = notify;
        } else if (notify && typeof notify === "object") {
          notifyEnabled = notify.enabled !== undefined ? notify.enabled : true;
          notifyChannel = notify.channel;
          notifySound = notify.sound;
          notifyOn = notify.on;
          if (notify.timeout_seconds && notify.timeout_seconds > 0) {
            notifyOverdueSec = notify.timeout_seconds;
          }
        }

        if (notifyEnabled !== undefined) headerMeta += `- **Notify**: ${notifyEnabled}\n`;
        if (notifyChannel) headerMeta += `- **Notify Channel**: ${notifyChannel}\n`;
        if (notifySound !== undefined) headerMeta += `- **Notify Sound**: ${notifySound}\n`;
        if (notifyOn && notifyOn.length > 0) headerMeta += `- **Notify On**: ${notifyOn.join(",")}\n`;
        if (hardTimeoutSec) headerMeta += `- **Hard Timeout Seconds**: ${hardTimeoutSec}\n`;
        if (notifyOverdueSec) headerMeta += `- **Notify Overdue Seconds**: ${notifyOverdueSec}\n`;

        headerMeta += `- **Created At**: ${createdAt}\n`;

        // Append non-intrusive git branch/remote rules note and structured report.json instruction into prompt
        const gitPromptNote = buildProjectGitRulesPromptNote(matchedProject);
        const taskReportDir = getTaskReportDir(rootDir, taskId);
        const reportPromptNote = prompt.includes("[Structured Report Requirement]")
          ? ""
          : buildReportJsonPromptInstruction(taskReportDir);
        const promptWithPrev = prevTaskContextPrefix ? `${prevTaskContextPrefix}${prompt}` : prompt;
        const promptWithPlan = planPromptPrefix ? `${planPromptPrefix}${promptWithPrev}` : promptWithPrev;
        const finalPrompt = `${promptWithPlan}${gitPromptNote}${reportPromptNote}`;

        const content = `# ${taskTitle}

${headerMeta}
---

## Prompt

${finalPrompt}
`;

        fs.writeFileSync(taskFilePath, content, "utf8");
        logger.info(`send_task success: taskId=${taskId}, path=${taskFilePath}, title="${taskTitle}", agent="${agentName}", model="${modelParam}", effort="${effortParam}"`);

        audit(rootDir, {
          tool: "send_task",
          taskId,
          agent: agentName || undefined,
          state: "dispatched",
        });

        if (effectivePlan && effectiveStep) {
          try {
            setPlanStepStatus(rootDir, effectivePlan.id, effectiveStep.id, "in_progress", { taskId });
          } catch (err: any) {
            logger.warn(`Failed to update step status for plan ${effectivePlan.id} on send_task: ${err?.message || String(err)}`);
          }
        }

        try {
          writeStatus(rootDir, taskId, {
            state: "queued",
            projectId: matchedProject?.id,
            projectName: matchedProject?.name,
            agent: agentName,
            model: modelParam || undefined,
            reasoningEffort: effortParam || undefined,
            account: effectiveAccount,
            startedAt: createdAt,
            ...(effectivePlan ? {
              plan_id: effectivePlan.id,
              step_id: effectiveStep!.id,
              plan_version: planVersion,
              plan_title: planTitle,
            } : {}),
            ...(cleanPrUrl ? {
              pr_url: cleanPrUrl,
              pr_urls: [cleanPrUrl],
              pr_open: true,
            } : {}),
            ...(cleanPrevTaskId ? {
              previousTaskId: cleanPrevTaskId,
            } : {}),
          });
          if (effectivePlan && cleanPrUrl) {
            try {
              setPlanStepStatus(rootDir, effectivePlan.id, effectiveStep!.id, undefined, { taskId, prUrl: cleanPrUrl });
            } catch {}
          }
        } catch {}

        // If on_complete is provided, save opt-in task webhook
        if (on_complete && on_complete.url) {
          try {
            setTaskWebhook(rootDir, taskId, {
              url: on_complete.url,
              headers: on_complete.headers,
              events: on_complete.events as WebhookEvent[],
              secret: on_complete.secret,
            });
            logger.info(`send_task: opt-in webhook configured for taskId=${taskId} to url=${on_complete.url}`);
          } catch (whErr: any) {
            logger.warn(`send_task: failed to set opt-in webhook: ${whErr?.message || String(whErr)}`);
          }
        }

        let metaDetails = "";
        if (projectResolution.project?.name) metaDetails += `\nproject: ${projectResolution.project.name}`;
        if (projectResolution.channelId) metaDetails += `\nslack_channel: ${projectResolution.channelId}`;
        if (projectResolution.conflict) metaDetails += `\nrouting_conflict: true`;
        if (agentName) metaDetails += `\nagent: ${agentName}`;
        if (modelParam) metaDetails += `\nmodel: ${modelParam}${modelSource === "default" ? " (default)" : ""}`;
        if (effortParam) metaDetails += `\nreasoning_effort: ${effortParam}`;
        if (continue_session) metaDetails += `\ncontinue_session: true`;
        if (session_id && session_id.trim()) metaDetails += `\nsession_id: ${session_id.trim()}`;
        if (effectiveCallbackUrl) metaDetails += `\ncallback_url: ${effectiveCallbackUrl}`;
        if (worktree && worktree.name) metaDetails += `\nworktree: ${worktree.name}`;
        if (notifyEnabled !== undefined) metaDetails += `\nnotify: ${notifyEnabled}`;
        if (notifyChannel) metaDetails += `\nnotify_channel: ${notifyChannel}`;
        if (hardTimeoutSec) metaDetails += `\nhard_timeout_seconds: ${hardTimeoutSec}`;
        if (notifyOverdueSec) metaDetails += `\nnotify_overdue_seconds: ${notifyOverdueSec}`;
        if (cleanPrUrl) metaDetails += `\npr_url: ${cleanPrUrl}`;
        if (cleanPrevTaskId) metaDetails += `\nprevious_task_id: ${cleanPrevTaskId}`;

        const [quota, early] = await Promise.all([
          withTimeout(
            getAgentAccountQuota(agentName, { model: modelParam || undefined, command: registry[agentName]?.command }).catch(() => null),
            5000,
            null
          ),
          waitForEarlyOutcome(rootDir, taskId),
        ]);
        if (early) {
          metaDetails += `\nstate: ${early.state}`;
          if (early.pid) metaDetails += `\npid: ${early.pid}`;
          if (early.reason) metaDetails += `\nreason: ${early.reason}`;
          if (early.logTail && early.state === "failed") metaDetails += `\nlog_tail:\n${early.logTail}`;
        }
        if (quota) {
          metaDetails += `\naccount: ${formatQuotaLine(quota)}`;
          metaDetails += `\naccount_quota: ${JSON.stringify(quota)}`;
        }

        return {
          content: [
            {
              type: "text",
              text: `${early && early.state === "failed" ? "Task dispatched but FAILED immediately." : "Task dispatched successfully."}\ntask_id: ${taskId}\npath: ${taskFilePath}${metaDetails}`,
            },
          ],
          ...(early && early.state === "failed" ? { isError: true } : {}),
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
  registerRequirementsTools(server, rootDir, logger);
  registerQueueTools(server, rootDir, logger);
  registerRecentTasksTool(server, rootDir, logger);
  registerWebhookTools(server, rootDir, logger);
  registerAccountResumeTools(server, rootDir, logger);
  registerAccountPoolTools(server, rootDir, logger);
  registerProjectTools(server, rootDir, logger);
  registerPlanTools(server, rootDir, logger);
  registerHelpTool(server);

  return { server, rootDir, tasksDir, resultsDir, logsDir, logger };
}


function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * Fast-failure window: if a live worker picks the task up and it dies within
 * AGENT_BRIDGE_SEND_TASK_WAIT_MS (default 6000; 0 disables), return its status so the
 * caller sees the reason immediately. Stops early while the task is still queued
 * behind another task.
 */
async function waitForEarlyOutcome(rootDir: string, taskId: string): Promise<TaskStatusInfo | null> {
  const waitMs = Number(process.env.AGENT_BRIDGE_SEND_TASK_WAIT_MS ?? 6000);
  if (!Number.isFinite(waitMs) || waitMs <= 0) return null;
  let workerPid = 0;
  try {
    workerPid = Number(fs.readFileSync(path.join(rootDir, "logs", "worker.pid"), "utf8").trim());
  } catch {}
  if (!isPidAlive(workerPid)) return null;
  const start = Date.now();
  let last: TaskStatusInfo | null = null;
  while (Date.now() - start < waitMs) {
    await new Promise(r => setTimeout(r, 400));
    try {
      last = readStatus(rootDir, taskId);
    } catch {
      last = null;
    }
    if (!last) continue;
    if (["failed", "cancelled", "completed", "paused_quota"].includes(last.state)) return last;
    if (last.state === "queued" && Date.now() - start > 3500) return last;
  }
  return last;
}
