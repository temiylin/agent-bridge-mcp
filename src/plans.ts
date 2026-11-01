import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveBridgeRoot } from "./config.js";
import { resolveSafePath } from "./validator.js";
import { readStatus } from "./status.js";
import { listAllSessionQueues } from "./queue.js";

export type PlanStepStatus = "todo" | "in_progress" | "done" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  status: PlanStepStatus;
  task_ids: string[];
  pr_urls: string[];
}

export interface Plan {
  id: string;
  project_id?: string;
  title: string;
  context: string;
  version: number;
  created_at: string;
  updated_at: string;
  steps: PlanStep[];
}

export interface PlanSummary {
  id: string;
  project_id?: string;
  title: string;
  version: number;
  created_at: string;
  updated_at: string;
  total_steps: number;
  completed_steps: number;
  status_summary: Record<PlanStepStatus, number>;
}

export interface CreatePlanInput {
  id?: string;
  project_id?: string;
  title: string;
  context?: string;
  steps?: Array<{
    id?: string;
    title: string;
    detail?: string;
    status?: PlanStepStatus;
  }>;
}

export interface UpdatePlanInput {
  title?: string;
  project_id?: string;
  context?: string;
  steps?: Array<{
    id?: string;
    title: string;
    detail?: string;
    status?: PlanStepStatus;
    task_ids?: string[];
    pr_urls?: string[];
  }>;
}

export function isValidPlanId(id: unknown): id is string {
  if (typeof id !== "string" || !id.trim()) return false;
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id.trim());
}

export function generatePlanId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  return `plan_${ts}_${rand}`;
}

export function getPlansDir(rootDir: string = resolveBridgeRoot()): string {
  const dir = path.join(rootDir, "plans");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getPlanFilePath(rootDir: string, planId: string): string {
  return path.join(getPlansDir(rootDir), `${planId}.json`);
}

export function getPlanArchiveDir(rootDir: string = resolveBridgeRoot()): string {
  const dir = path.join(getPlansDir(rootDir), "archive");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Strictly loads and validates a plan file without swallowing JSON syntax or schema errors.
 * Throws if the file exists and is corrupted/invalid.
 */
export function loadPlanStrict(rootDir: string, planId: string): Plan | null {
  if (!isValidPlanId(planId)) {
    throw new Error(`Invalid plan_id: "${planId}". Only letters, numbers, hyphens, and underscores are allowed.`);
  }

  const filePath = getPlanFilePath(rootDir, planId);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Failed to parse plan file at "${filePath}": ${err?.message || String(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid plan file at "${filePath}": root must be a JSON object.`);
  }

  if (typeof parsed.id !== "string" || !parsed.id.trim()) {
    throw new Error(`Invalid plan file at "${filePath}": missing "id".`);
  }
  if (typeof parsed.title !== "string") {
    throw new Error(`Invalid plan file at "${filePath}": missing "title".`);
  }
  if (typeof parsed.version !== "number") {
    throw new Error(`Invalid plan file at "${filePath}": missing or invalid "version".`);
  }
  if (!Array.isArray(parsed.steps)) {
    throw new Error(`Invalid plan file at "${filePath}": "steps" must be an array.`);
  }

  const normalizedSteps: PlanStep[] = parsed.steps.map((st: any, idx: number) => {
    const sId = typeof st?.id === "string" && st.id.trim() ? st.id.trim() : `step-${idx + 1}`;
    const sTitle = typeof st?.title === "string" ? st.title.trim() : `Step ${idx + 1}`;
    const sDetail = typeof st?.detail === "string" ? st.detail : "";
    const validStatuses = new Set<PlanStepStatus>(["todo", "in_progress", "done", "failed", "skipped"]);
    const sStatus: PlanStepStatus = validStatuses.has(st?.status) ? st.status : "todo";
    const sTaskIds = Array.isArray(st?.task_ids)
      ? st.task_ids.map((x: any) => String(x).trim()).filter(Boolean)
      : [];
    const sPrUrls = Array.isArray(st?.pr_urls)
      ? st.pr_urls.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    return {
      id: sId,
      title: sTitle,
      detail: sDetail,
      status: sStatus,
      task_ids: sTaskIds,
      pr_urls: sPrUrls,
    };
  });

  return {
    id: parsed.id.trim(),
    project_id: typeof parsed.project_id === "string" && parsed.project_id.trim() ? parsed.project_id.trim() : undefined,
    title: parsed.title.trim(),
    context: typeof parsed.context === "string" ? parsed.context : "",
    version: Math.floor(parsed.version),
    created_at: typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
    steps: normalizedSteps,
  };
}

/**
 * Writes plan data atomically via temp file rename with automatic .bak backup.
 */
function writePlanFileUnchecked(rootDir: string, plan: Plan): void {
  const filePath = getPlanFilePath(rootDir, plan.id);
  const bakPath = `${filePath}.bak`;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, bakPath);
  }

  const tempPath = path.join(dir, `.${plan.id}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(plan, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

/**
 * Acquires an exclusive file lock (`<plan_id>.lock` via O_CREAT | O_EXCL) with retries,
 * re-reads and strictly validates the plan inside the lock, runs `mutator(plan)`,
 * and atomically writes the updated plan with a .bak backup.
 * If the plan file is corrupt/unparseable, refuses to write and leaves the original file untouched.
 */
export function withPlanLock<T>(
  rootDir: string,
  planId: string,
  mutator: (plan: Plan | null) => { save: boolean; result: T }
): T {
  if (!isValidPlanId(planId)) {
    throw new Error(`Invalid plan_id: "${planId}". Only letters, numbers, hyphens, and underscores are allowed.`);
  }

  const plansDir = getPlansDir(rootDir);
  const lockPath = path.join(plansDir, `${planId}.lock`);
  const maxAttempts = 50;
  const retryDelayMs = 40;
  const staleLockMs = 15000;
  let lockFd: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(lockFd, `${process.pid}:${Date.now()}\n`);
      break;
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > staleLockMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
        if (attempt === maxAttempts) {
          throw new Error(`Timed out waiting for lock on plan "${planId}" at "${lockPath}"`);
        }
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, retryDelayMs);
        continue;
      }
      throw err;
    }
  }

  try {
    const plan = loadPlanStrict(rootDir, planId);
    const { save, result } = mutator(plan);
    if (save) {
      if (!plan) {
        throw new Error(`Cannot save non-existent plan "${planId}".`);
      }
      writePlanFileUnchecked(rootDir, plan);
    }
    return result;
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
    }
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  }
}

/**
 * Creates a new plan atomically.
 */
export function createPlan(rootDir: string, input: CreatePlanInput): Plan {
  if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("Plan title must be a non-empty string.");
  }

  const planId = input.id && input.id.trim() ? input.id.trim() : generatePlanId();
  if (!isValidPlanId(planId)) {
    throw new Error(`Invalid plan ID: "${planId}". Only letters, numbers, hyphens, and underscores are allowed.`);
  }

  const existing = loadPlanStrict(rootDir, planId);
  if (existing) {
    throw new Error(`Plan "${planId}" already exists.`);
  }

  const now = new Date().toISOString();
  const normalizedSteps: PlanStep[] = (input.steps || []).map((st, idx) => {
    const sId = st.id && st.id.trim() ? st.id.trim() : `step-${idx + 1}`;
    const sTitle = st.title && st.title.trim() ? st.title.trim() : `Step ${idx + 1}`;
    return {
      id: sId,
      title: sTitle,
      detail: typeof st.detail === "string" ? st.detail : "",
      status: st.status || "todo",
      task_ids: [],
      pr_urls: [],
    };
  });

  const plan: Plan = {
    id: planId,
    project_id: input.project_id && input.project_id.trim() ? input.project_id.trim() : undefined,
    title: input.title.trim(),
    context: typeof input.context === "string" ? input.context : "",
    version: 1,
    created_at: now,
    updated_at: now,
    steps: normalizedSteps,
  };

  return withPlanLock<Plan>(rootDir, planId, (existingPlan) => {
    if (existingPlan) {
      throw new Error(`Plan "${planId}" already exists.`);
    }
    writePlanFileUnchecked(rootDir, plan);
    return { save: false, result: plan };
  });
}

/**
 * Retrieves a plan by ID. Checks active plans and optionally archive.
 */
export function getPlan(
  rootDir: string,
  planId: string,
  options?: { includeArchived?: boolean }
): Plan | null {
  if (!isValidPlanId(planId)) return null;

  try {
    const active = loadPlanStrict(rootDir, planId);
    if (active) return active;
  } catch (err) {
    throw err;
  }

  if (options?.includeArchived) {
    const archivePath = path.join(getPlanArchiveDir(rootDir), `${planId}.json`);
    if (fs.existsSync(archivePath)) {
      try {
        const raw = fs.readFileSync(archivePath, "utf8");
        return JSON.parse(raw) as Plan;
      } catch {}
    }
  }

  return null;
}

/**
 * Updates a plan (context, steps, title, project_id).
 * Automatically increments version by 1 and updates updated_at.
 */
export function updatePlan(rootDir: string, planId: string, input: UpdatePlanInput): Plan {
  return withPlanLock<Plan>(rootDir, planId, (plan) => {
    if (!plan) {
      throw new Error(`Plan "${planId}" not found.`);
    }

    let modified = false;

    if (input.title !== undefined && input.title.trim() && input.title.trim() !== plan.title) {
      plan.title = input.title.trim();
      modified = true;
    }

    if (input.project_id !== undefined) {
      const pId = input.project_id ? input.project_id.trim() : undefined;
      if (pId !== plan.project_id) {
        plan.project_id = pId;
        modified = true;
      }
    }

    if (input.context !== undefined && input.context !== plan.context) {
      plan.context = input.context;
      modified = true;
    }

    if (input.steps !== undefined && Array.isArray(input.steps)) {
      const updatedSteps: PlanStep[] = input.steps.map((st, idx) => {
        const sId = st.id && st.id.trim() ? st.id.trim() : `step-${idx + 1}`;
        const sTitle = st.title && st.title.trim() ? st.title.trim() : `Step ${idx + 1}`;
        const sDetail = typeof st.detail === "string" ? st.detail : "";
        const existingStep = plan.steps.find((s) => s.id === sId);

        const validStatuses = new Set<PlanStepStatus>(["todo", "in_progress", "done", "failed", "skipped"]);
        const sStatus: PlanStepStatus = validStatuses.has(st.status as PlanStepStatus)
          ? (st.status as PlanStepStatus)
          : existingStep?.status || "todo";

        const taskIds = Array.isArray(st.task_ids)
          ? st.task_ids
          : existingStep?.task_ids || [];
        const prUrls = Array.isArray(st.pr_urls)
          ? st.pr_urls
          : existingStep?.pr_urls || [];

        return {
          id: sId,
          title: sTitle,
          detail: sDetail,
          status: sStatus,
          task_ids: Array.from(new Set(taskIds)),
          pr_urls: Array.from(new Set(prUrls)),
        };
      });

      plan.steps = updatedSteps;
      modified = true;
    }

    if (modified) {
      plan.version += 1;
      plan.updated_at = new Date().toISOString();
    }

    return { save: modified, result: plan };
  });
}

/**
 * Updates a specific step's status in a plan, and optionally appends taskId and prUrl.
 */
export function setPlanStepStatus(
  rootDir: string,
  planId: string,
  stepId: string,
  status: PlanStepStatus,
  extra?: { taskId?: string; prUrl?: string }
): { success: boolean; plan: Plan; step?: PlanStep } {
  return withPlanLock<{ success: boolean; plan: Plan; step?: PlanStep }>(rootDir, planId, (plan) => {
    if (!plan) {
      throw new Error(`Plan "${planId}" not found.`);
    }

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`Step "${stepId}" not found in plan "${planId}".`);
    }

    step.status = status;
    if (extra?.taskId && !step.task_ids.includes(extra.taskId)) {
      step.task_ids.push(extra.taskId);
    }
    if (extra?.prUrl && !step.pr_urls.includes(extra.prUrl)) {
      step.pr_urls.push(extra.prUrl);
    }

    plan.version += 1;
    plan.updated_at = new Date().toISOString();

    return {
      save: true,
      result: { success: true, plan, step },
    };
  });
}

/**
 * Checks whether any task associated with a plan is currently running, queued, or paused in status/ or queue/.
 */
export function hasActiveTasksForPlan(rootDir: string, planId: string): { active: boolean; taskId?: string; state?: string } {
  // 1. Check status/ directory
  const statusDir = path.join(rootDir, "status");
  if (fs.existsSync(statusDir)) {
    try {
      const files = fs.readdirSync(statusDir);
      for (const f of files) {
        if (!f.endsWith(".json") || f.endsWith(".tmp") || f.startsWith("_")) continue;
        try {
          const raw = fs.readFileSync(path.join(statusDir, f), "utf8");
          const st = JSON.parse(raw);
          if (st && (st.plan_id === planId || st.planId === planId)) {
            const activeStates = new Set(["running", "queued", "paused", "paused_quota", "suspected_stalled"]);
            if (activeStates.has(st.state)) {
              return { active: true, taskId: st.taskId || f.replace(/\.json$/, ""), state: st.state };
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Check queue/ directory
  try {
    const queueStates = listAllSessionQueues(rootDir);
    for (const q of queueStates) {
      for (const item of q.items) {
        if (item.status === "dispatched") continue;
        const optPlanId = item.options?.plan_id || item.options?.planId;
        if (optPlanId === planId) {
          return { active: true, taskId: item.id, state: "queued" };
        }
      }
    }
  } catch {}

  return { active: false };
}

/**
 * Archives a plan by moving it from plans/<id>.json to plans/archive/<id>.json.
 * Refuses if any associated task is running or queued.
 */
export function archivePlan(rootDir: string, planId: string): { success: boolean; message?: string; error?: string } {
  if (!isValidPlanId(planId)) {
    return { success: false, error: `Invalid plan_id: "${planId}".` };
  }

  const activeCheck = hasActiveTasksForPlan(rootDir, planId);
  if (activeCheck.active) {
    return {
      success: false,
      error: `Cannot archive plan "${planId}": task "${activeCheck.taskId}" is currently ${activeCheck.state}. Wait for tasks to complete or cancel them first.`,
    };
  }

  return withPlanLock<{ success: boolean; message?: string; error?: string }>(rootDir, planId, (plan) => {
    if (!plan) {
      return { save: false, result: { success: false, error: `Plan "${planId}" not found.` } };
    }

    const srcPath = getPlanFilePath(rootDir, planId);
    const archiveDir = getPlanArchiveDir(rootDir);
    let destPath = path.join(archiveDir, `${planId}.json`);
    if (fs.existsSync(destPath)) {
      destPath = path.join(archiveDir, `${planId}_${Date.now()}.json`);
    }

    try {
      fs.renameSync(srcPath, destPath);
    } catch (err: any) {
      return { save: false, result: { success: false, error: `Failed to archive plan: ${err?.message || String(err)}` } };
    }

    return { save: false, result: { success: true, message: `Plan "${planId}" successfully archived.` } };
  });
}

/**
 * Lists plans in compact summary form.
 */
export function listPlans(
  rootDir: string,
  filter?: { projectId?: string; includeArchived?: boolean }
): PlanSummary[] {
  const plansDir = getPlansDir(rootDir);
  let files: string[] = [];
  try {
    files = fs.readdirSync(plansDir);
  } catch {
    return [];
  }

  const summaries: PlanSummary[] = [];
  const filterProj = filter?.projectId ? filter.projectId.trim().toLowerCase() : undefined;

  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".tmp") || f.endsWith(".bak") || f.startsWith(".")) continue;
    const planId = f.replace(/\.json$/, "");
    try {
      const plan = loadPlanStrict(rootDir, planId);
      if (!plan) continue;

      if (filterProj && (plan.project_id || "").toLowerCase() !== filterProj) {
        continue;
      }

      const statusSummary: Record<PlanStepStatus, number> = {
        todo: 0,
        in_progress: 0,
        done: 0,
        failed: 0,
        skipped: 0,
      };

      for (const step of plan.steps) {
        if (step.status in statusSummary) {
          statusSummary[step.status]++;
        } else {
          statusSummary.todo++;
        }
      }

      summaries.push({
        id: plan.id,
        project_id: plan.project_id,
        title: plan.title,
        version: plan.version,
        created_at: plan.created_at,
        updated_at: plan.updated_at,
        total_steps: plan.steps.length,
        completed_steps: statusSummary.done,
        status_summary: statusSummary,
      });
    } catch {}
  }

  summaries.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return summaries;
}

/**
 * Formats the structured plan prefix to be injected at the very beginning of the prompt.
 * If the markdown context is > 4000 characters, truncates to ~4000 characters and directs the agent to read the full file.
 */
export function formatPlanPromptPrefix(rootDir: string, plan: Plan, step: PlanStep): string {
  const planFilePath = getPlanFilePath(rootDir, plan.id);
  const rawContext = (plan.context || "").trim();

  let formattedContext: string;
  if (rawContext.length > 4000) {
    const truncated = rawContext.slice(0, 4000);
    formattedContext = `${truncated}\n\n[Context truncated due to length. For the complete plan context and details, read the full plan file at: ${planFilePath}]`;
  } else {
    formattedContext = rawContext || "(No background context provided)";
  }

  return (
    `# Plan: ${plan.title} (Step: ${step.title})\n` +
    `Plan ID: ${plan.id} | Step ID: ${step.id} | Version: ${plan.version}${plan.project_id ? ` | Project: ${plan.project_id}` : ""}\n\n` +
    `## Plan Context\n` +
    `${formattedContext}\n\n` +
    `## Current Step: ${step.title}\n` +
    `${step.detail || "(No step detail)"}\n\n` +
    `---\n\n`
  );
}

/**
 * Records task completion or failure back into the associated plan step.
 * - Appends taskId to step.task_ids
 * - Appends prUrl to step.pr_urls
 * - Success -> done; Failure -> failed; NEVER overwrites "skipped"
 * - Does not dispatch next step
 */
export function recordTaskResultInPlan(
  rootDir: string,
  params: {
    planId: string;
    stepId: string;
    taskId: string;
    state: string;
    outcome?: string | null;
    prUrl?: string | null;
  }
): boolean {
  if (!isValidPlanId(params.planId)) return false;

  try {
    return withPlanLock<boolean>(rootDir, params.planId, (plan) => {
      if (!plan) return { save: false, result: false };

      const step = plan.steps.find((s) => s.id === params.stepId);
      if (!step) return { save: false, result: false };

      if (!step.task_ids.includes(params.taskId)) {
        step.task_ids.push(params.taskId);
      }

      if (params.prUrl && params.prUrl.trim() && !step.pr_urls.includes(params.prUrl.trim())) {
        step.pr_urls.push(params.prUrl.trim());
      }

      // "成功→done，失败→failed（不覆盖人工设置的 skipped）"
      if (step.status !== "skipped") {
        const normState = params.state.trim().toLowerCase();
        const normOutcome = params.outcome ? params.outcome.trim().toLowerCase() : undefined;
        if (normOutcome === "failed" || normState === "failed" || normState === "timeout") {
          step.status = "failed";
        } else if (normOutcome === "ready" || normState === "completed") {
          step.status = "done";
        }
      }

      plan.updated_at = new Date().toISOString();
      return { save: true, result: true };
    });
  } catch {
    return false;
  }
}
