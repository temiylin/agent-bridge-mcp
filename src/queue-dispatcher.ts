import fs from "node:fs";
import path from "node:path";
import { generateTaskId, resolveSafePath } from "./validator.js";
import { audit } from "./audit.js";
import { writeStatus, readStatus } from "./status.js";
import { loadAgents } from "./agents.js";
import { resolveTaskAgent } from "./routing.js";
import {
  loadSessionQueue,
  saveSessionQueue,
  listAllSessionQueues,
  QueueItem,
} from "./queue.js";
import { writeRequirement, getRequirement } from "./requirements.js";
import { setTaskWebhook, TaskWebhookConfig } from "./webhook.js";
import {
  resolveProject,
  getProjectRepoPath,
  validateGitRepoPath,
  buildProjectGitRulesPromptNote,
} from "./project-router.js";
import { getTaskReportDir, buildReportJsonPromptInstruction } from "./task-stage.js";
import { getPlan, formatPlanPromptPrefix, setPlanStepStatus, Plan, PlanStep } from "./plans.js";

export interface TaskDispatchParams {
  prompt: string;
  title?: string;
  agent?: string;
  model?: string;
  reasoning_effort?: string;
  continue_session?: boolean;
  session_id?: string;
  account?: string;
  project_id?: string;
  project_dir?: string;
  timeout_seconds?: number;
  on_complete?: TaskWebhookConfig;
  plan_id?: string;
  step_id?: string;
  pr_url?: string;
}

export interface TaskDispatchResult {
  taskId: string;
  taskFilePath: string;
  agentName: string;
  modelParam?: string;
  effortParam?: string;
}

/**
 * Creates and writes a task file under tasks/<taskId>.md and updates status & audit.
 */
export function dispatchTaskDirect(
  rootDir: string,
  params: TaskDispatchParams
): TaskDispatchResult {
  const tasksDir = path.join(rootDir, "tasks");
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
  }

  let effectivePlan: Plan | null = null;
  let effectiveStep: PlanStep | null = null;
  let planPromptPrefix = "";
  if (params.plan_id && params.plan_id.trim()) {
    const cleanPlanId = params.plan_id.trim();
    if (!params.step_id || !params.step_id.trim()) {
      throw new Error("step_id is required when plan_id is provided.");
    }
    const cleanStepId = params.step_id.trim();
    effectivePlan = getPlan(rootDir, cleanPlanId);
    if (!effectivePlan) {
      throw new Error(`Plan "${cleanPlanId}" not found.`);
    }
    effectiveStep = effectivePlan.steps.find((s) => s.id === cleanStepId) || null;
    if (!effectiveStep) {
      throw new Error(`Step "${cleanStepId}" not found in plan "${cleanPlanId}".`);
    }
    planPromptPrefix = formatPlanPromptPrefix(rootDir, effectivePlan, effectiveStep);
  }

  const effectiveProjectId =
    (params.project_id && params.project_id.trim()) ||
    (effectivePlan?.project_id && effectivePlan.project_id.trim()) ||
    undefined;

  const projectResolution = resolveProject(rootDir, {
    projectId: effectiveProjectId,
    projectDir: params.project_dir,
  });
  const matchedProject = projectResolution.project;
  const configuredRepoPath = getProjectRepoPath(matchedProject);

  if (matchedProject && !params.project_dir && configuredRepoPath) {
    const pathCheck = validateGitRepoPath(configuredRepoPath);
    if (!pathCheck.valid) {
      throw new Error(`Project "${matchedProject.id}" repository path is invalid or has moved: ${pathCheck.error}`);
    }
  }

  const prompt = params.prompt;
  let registry: ReturnType<typeof loadAgents> = {};
  try {
    registry = loadAgents(rootDir);
  } catch {}

  let agentName = "";
  const effectiveAgentArg =
    params.agent && params.agent.trim().length > 0 && params.agent.trim().toLowerCase() !== "auto"
      ? params.agent.trim()
      : matchedProject?.default_agent && matchedProject.default_agent.toLowerCase() !== "auto"
        ? matchedProject.default_agent.trim()
        : "";

  if (effectiveAgentArg) {
    agentName = effectiveAgentArg;
  } else {
    const resolved = resolveTaskAgent(rootDir, prompt);
    agentName = resolved.agent;
  }

  const effectiveModel = params.model?.trim() || matchedProject?.default_model;
  const effectiveAccount = params.account?.trim() || matchedProject?.default_account;
  const effectiveTimeout =
    params.timeout_seconds && params.timeout_seconds > 0
      ? params.timeout_seconds
      : matchedProject?.default_timeout_seconds && matchedProject.default_timeout_seconds > 0
        ? matchedProject.default_timeout_seconds
        : undefined;
  const effectiveProjectDir = params.project_dir || configuredRepoPath;

  const taskId = generateTaskId();
  const taskFilePath = resolveSafePath(tasksDir, rootDir, `${taskId}.md`);
  const createdAt = new Date().toISOString();
  const taskTitle = params.title && params.title.trim().length > 0 ? params.title.trim() : `Task ${taskId}`;

  let headerMeta = `- **Task ID**: ${taskId}\n- **Agent**: ${agentName}\n`;
  if (matchedProject?.id) headerMeta += `- **Project ID**: ${matchedProject.id}\n`;
  if (matchedProject?.name) headerMeta += `- **Project Name**: ${matchedProject.name}\n`;
  if (matchedProject?.repo) headerMeta += `- **Project Repo**: ${matchedProject.repo}\n`;
  if (matchedProject?.slack_webhook_env) headerMeta += `- **Slack Webhook Env**: ${matchedProject.slack_webhook_env}\n`;
  if (effectiveProjectDir) headerMeta += `- **Project Dir**: ${effectiveProjectDir}\n`;
  if (projectResolution.channelId) headerMeta += `- **Slack Channel**: ${projectResolution.channelId}\n`;
  if (matchedProject?.callback_url) headerMeta += `- **Callback URL**: ${matchedProject.callback_url}\n`;
  if (matchedProject?.callback_headers) headerMeta += `- **Callback Headers**: ${JSON.stringify(matchedProject.callback_headers)}\n`;
  if (effectiveModel) headerMeta += `- **Model**: ${effectiveModel}\n`;
  if (params.reasoning_effort) headerMeta += `- **Reasoning Effort**: ${params.reasoning_effort.trim().toLowerCase()}\n`;
  if (params.continue_session) headerMeta += `- **Continue Session**: true\n`;
  if (params.session_id && params.session_id.trim()) headerMeta += `- **Session ID**: ${params.session_id.trim()}\n`;
  if (effectiveAccount) headerMeta += `- **Account**: ${effectiveAccount}\n`;
  if (effectiveTimeout) headerMeta += `- **Hard Timeout Seconds**: ${effectiveTimeout}\n`;
  const cleanPrUrl = params.pr_url && params.pr_url.trim().length > 0 ? params.pr_url.trim() : undefined;
  if (cleanPrUrl) headerMeta += `- **PR URL**: ${cleanPrUrl}\n`;
  if (effectivePlan) {
    headerMeta += `- **Plan ID**: ${effectivePlan.id}\n`;
    headerMeta += `- **Plan Step ID**: ${effectiveStep!.id}\n`;
    headerMeta += `- **Plan Version**: ${effectivePlan.version}\n`;
    headerMeta += `- **Plan Title**: ${effectivePlan.title}\n`;
  }
  headerMeta += `- **Created At**: ${createdAt}\n`;

  const gitPromptNote = buildProjectGitRulesPromptNote(matchedProject);
  const taskReportDir = getTaskReportDir(rootDir, taskId);
  const reportPromptNote = prompt.includes("[Structured Report Requirement]")
    ? ""
    : buildReportJsonPromptInstruction(taskReportDir);
  const promptWithPlan = planPromptPrefix ? `${planPromptPrefix}${prompt}` : prompt;
  const content = `# ${taskTitle}\n\n${headerMeta}---\n\n## Prompt\n\n${promptWithPlan}${gitPromptNote}${reportPromptNote}\n`;

  fs.writeFileSync(taskFilePath, content, "utf8");

  audit(rootDir, {
    tool: "queue-dispatcher",
    taskId,
    agent: agentName || undefined,
    state: "dispatched",
  });

  if (effectivePlan && effectiveStep) {
    try {
      setPlanStepStatus(rootDir, effectivePlan.id, effectiveStep.id, "in_progress", { taskId, ...(cleanPrUrl ? { prUrl: cleanPrUrl } : {}) });
    } catch {}
  }

  try {
    writeStatus(rootDir, taskId, {
      state: "queued",
      projectId: matchedProject?.id,
      projectName: matchedProject?.name,
      agent: agentName,
      model: effectiveModel || undefined,
      reasoningEffort: params.reasoning_effort || undefined,
      account: effectiveAccount || undefined,
      startedAt: createdAt,
      ...(effectivePlan ? {
        plan_id: effectivePlan.id,
        step_id: effectiveStep!.id,
        plan_version: effectivePlan.version,
        plan_title: effectivePlan.title,
      } : {}),
      ...(cleanPrUrl ? {
        pr_url: cleanPrUrl,
        pr_urls: [cleanPrUrl],
        pr_open: true,
      } : {}),
    });
  } catch {}

  // If on_complete webhook is opted in for this task, attach it now
  if (params.on_complete && params.on_complete.url) {
    try {
      setTaskWebhook(rootDir, taskId, params.on_complete);
    } catch {}
  }

  return {
    taskId,
    taskFilePath,
    agentName,
    modelParam: params.model,
    effortParam: params.reasoning_effort,
  };
}

/**
 * Conversation lane key: tasks with the same session (or continue_session) in the same project_dir
 * must not run concurrently (avoids corrupting local agy/codex conversation state).
 */
export function conversationLaneKey(
  sessionId?: string,
  projectDir?: string,
  continueSession?: boolean
): string | undefined {
  const sid = sessionId?.trim();
  if (!sid && !continueSession) return undefined;
  let dir = "";
  if (projectDir && projectDir.trim()) {
    try {
      dir = path.resolve(projectDir.trim());
    } catch {
      dir = projectDir.trim();
    }
  }
  const sessionPart = sid || "__continue__";
  return `${dir}\0${sessionPart}`;
}

function taskFileConversationLane(rootDir: string, taskId: string): string | undefined {
  const taskPath = path.join(rootDir, "tasks", `${taskId}.md`);
  if (!fs.existsSync(taskPath)) return undefined;
  try {
    const content = fs.readFileSync(taskPath, "utf8");
    const sessionMatch = content.match(/- \*\*Session ID\*\*:\s*([^\r\n]+)/i);
    const sessionId = sessionMatch ? sessionMatch[1].trim() : undefined;
    const contMatch = content.match(/- \*\*Continue Session\*\*:\s*([^\r\n]+)/i);
    const continueSession = contMatch ? /^true$/i.test(contMatch[1].trim()) : false;
    const dirMatch = content.match(/- \*\*Project Dir\*\*:\s*([^\r\n]+)/i);
    const projectDir = dirMatch ? dirMatch[1].trim() : undefined;
    return conversationLaneKey(sessionId, projectDir, continueSession);
  } catch {
    return undefined;
  }
}

/**
 * True when another in-flight task occupies the same conversation lane.
 */
export function isConversationLaneBusy(
  rootDir: string,
  sessionId?: string,
  projectDir?: string,
  continueSession?: boolean,
  excludeTaskId?: string
): boolean {
  const lane = conversationLaneKey(sessionId, projectDir, continueSession);
  if (!lane) return false;
  const statusDir = path.join(rootDir, "status");
  if (!fs.existsSync(statusDir)) return false;

  let files: string[] = [];
  try {
    files = fs.readdirSync(statusDir);
  } catch {
    return false;
  }

  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    const taskId = file.replace(/\.json$/, "");
    if (excludeTaskId && taskId === excludeTaskId) continue;
    try {
      const raw = fs.readFileSync(path.join(statusDir, file), "utf8");
      const info = JSON.parse(raw);
      if (!info || (info.state !== "queued" && info.state !== "running")) continue;
      const otherLane = taskFileConversationLane(rootDir, taskId);
      if (otherLane === lane) return true;
    } catch {}
  }
  return false;
}

/**
 * Checks whether a given session has an active in-flight task (queued or running).
 */
export function isSessionBusy(rootDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  return isConversationLaneBusy(rootDir, sessionId, undefined, false);
}

/**
 * Dispatches the next ready item in the session queue if not paused and not busy.
 */
export function dispatchNextInQueue(rootDir: string, sessionId: string): QueueItem | null {
  const state = loadSessionQueue(rootDir, sessionId);
  if (state.paused) return null;
  if (state.items.length === 0) return null;

  // Enforce single in-flight task per session
  if (isSessionBusy(rootDir, sessionId)) {
    return null;
  }

  // Find first queued item
  const nextItemIndex = state.items.findIndex((it) => it.status === "queued");
  if (nextItemIndex === -1) return null;

  const item = state.items[nextItemIndex];

  if (item.mode === "notify") {
    // mode=notify: just mark ready so caller can decide
    item.status = "ready";
    saveSessionQueue(rootDir, state);
    return item;
  }

  // mode=auto: dispatch task now!
  const dispatchRes = dispatchTaskDirect(rootDir, {
    prompt: item.prompt,
    title: item.options?.title,
    agent: item.options?.agent,
    model: item.options?.model,
    reasoning_effort: item.options?.reasoning_effort,
    continue_session: true, // Auto queue continues same session
    session_id: sessionId,
    account: item.options?.account,
    project_id: item.options?.project_id || item.options?.project,
    project_dir: item.options?.project_dir,
    timeout_seconds: item.options?.timeout_seconds,
    on_complete: item.options?.on_complete,
    plan_id: item.options?.plan_id || item.options?.planId,
    step_id: item.options?.step_id || item.options?.stepId,
  });

  // Remove or mark dispatched. The spec says:
  // "when a task completes successfully, the worker auto-dispatches the next queued item for that session"
  item.status = "dispatched";
  item.dispatched_at = new Date().toISOString();
  item.dispatched_task_id = dispatchRes.taskId;

  // If this item was linked to a requirement, update requirement too
  if (item.options?.requirement_id) {
    const req = getRequirement(rootDir, item.options.requirement_id);
    if (req) {
      req.status = "dispatched";
      req.task_id = dispatchRes.taskId;
      req.dispatched_at = item.dispatched_at;
      req.updated_at = new Date().toISOString();
      writeRequirement(rootDir, req);
    }
  }

  // Remove the dispatched item from queue list to keep queue orderly
  state.items.splice(nextItemIndex, 1);
  saveSessionQueue(rootDir, state);

  return item;
}

/**
 * Hook called when a task finishes (completed or failed/cancelled).
 */
export function onTaskFinished(
  rootDir: string,
  taskId: string,
  status: "completed" | "failed" | "cancelled" | "paused_quota",
  sessionId?: string,
  reason?: string
): void {
  // If session_id not passed directly, try to discover from task file
  let session = sessionId;
  if (!session) {
    const taskPath = path.join(rootDir, "tasks", `${taskId}.md`);
    if (fs.existsSync(taskPath)) {
      try {
        const content = fs.readFileSync(taskPath, "utf8");
        const match = content.match(/- \*\*Session ID\*\*:\s*([^\r\n]+)/i);
        if (match) session = match[1].trim();
      } catch {}
    }
  }

  // If still no session, check whether any queue has after_task_id == taskId
  if (!session) {
    const allQueues = listAllSessionQueues(rootDir);
    for (const q of allQueues) {
      if (q.items.some((it) => it.after_task_id === taskId)) {
        session = q.session_id;
        break;
      }
    }
  }

  if (!session) return;

  if (status === "completed") {
    // Task succeeded: auto-dispatch next queued item for that session
    dispatchNextInQueue(rootDir, session);
  } else if (status === "paused_quota") {
    // Quota exhausted: pause queue temporarily with quota reason (do NOT permanently fail the queue)
    const state = loadSessionQueue(rootDir, session);
    state.paused = true;
    state.pause_reason = `paused_quota: ${reason || "Account quota exhausted. Session history is preserved on machine; resume with resume_after_account_switch."}`;
    saveSessionQueue(rootDir, state);
  } else {
    // Task failed or cancelled: pause that session's queue and record reason
    const state = loadSessionQueue(rootDir, session);
    state.paused = true;
    state.pause_reason = `Task ${taskId} ended with status "${status}"${reason ? `: ${reason}` : ""}`;
    saveSessionQueue(rootDir, state);
  }
}

/**
 * Reconciles queues on startup or recovery.
 * Items whose trigger task (after_task_id) already finished or whose session is idle get processed.
 */
export function reconcileQueues(rootDir: string): void {
  const allQueues = listAllSessionQueues(rootDir);
  for (const q of allQueues) {
    if (q.paused || q.items.length === 0) continue;

    // Check if session is currently busy
    if (isSessionBusy(rootDir, q.session_id)) continue;

    // Check the first queued item
    const firstQueued = q.items.find((it) => it.status === "queued");
    if (!firstQueued) continue;

    // If it has after_task_id, check if that task is completed
    if (firstQueued.after_task_id) {
      const afterStatus = readStatus(rootDir, firstQueued.after_task_id);
      if (afterStatus) {
        if (afterStatus.state === "completed") {
          dispatchNextInQueue(rootDir, q.session_id);
        } else if (afterStatus.state === "failed" || afterStatus.state === "cancelled") {
          q.paused = true;
          q.pause_reason = `Trigger task ${firstQueued.after_task_id} failed with state "${afterStatus.state}"`;
          saveSessionQueue(rootDir, q);
        }
      } else {
        // If trigger task has no status, check if result file exists
        const resultFile = path.join(rootDir, "results", `${firstQueued.after_task_id}.md`);
        if (fs.existsSync(resultFile)) {
          dispatchNextInQueue(rootDir, q.session_id);
        }
      }
    } else {
      // No after_task_id specified and session is idle -> dispatch next
      dispatchNextInQueue(rootDir, q.session_id);
    }
  }
}
