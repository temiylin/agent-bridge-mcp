import fs from "node:fs";
import path from "node:path";

export type TaskOutcome = "ready" | "blocked" | "failed" | "dropped";

export type ReportSource = "report_json" | "heuristic";

export interface TaskReport {
  outcome: TaskOutcome;
  pr_url: string | null;
  question: string | null;
  summary: string;
  completed_goals?: string[];
  unresolved_issues?: string[];
}

export type TaskStage =
  | "needs_human/failed"
  | "needs_human/quota"
  | "needs_human/stalled"
  | "needs_human/answer"
  | "needs_human/review"
  | "queued"
  | "working"
  | "done";

export interface TaskStageInput {
  /** Legacy task state or status (e.g. "running", "completed", "failed", "timeout", "paused_quota", "suspected_stalled", "queued", "paused", "cancelled") */
  state?: string | null;
  status?: string | null;
  reason?: string | null;
  /** Whether a subsequent follow-up / continuation input has already been dispatched for this failed/timed-out task */
  hasFollowUp?: boolean;
  has_follow_up?: boolean;
  /** Structured or heuristic report object */
  report?: Partial<TaskReport> | null;
  /** Top-level fallback fields when report is flattened */
  outcome?: TaskOutcome | string | null;
  pr_url?: string | null;
  prUrl?: string | null;
  question?: string | null;
  /** Whether the associated PR is open (default true when pr_url is present unless explicitly false or pr_state is closed/merged) */
  pr_open?: boolean;
  prOpen?: boolean;
  pr_state?: string | null;
}

const VALID_OUTCOMES = new Set<TaskOutcome>(["ready", "blocked", "failed", "dropped"]);

/**
 * Derives the unified task stage according to the strict priority order (first match wins):
 * 1. needs_human/failed  : failed or timeout AND no subsequent follow-up input
 * 2. needs_human/quota   : paused_quota
 * 3. needs_human/stalled : suspected_stalled (or stalled)
 * 4. needs_human/answer  : report.question is non-empty
 * 5. needs_human/review  : outcome === "ready" AND pr_url is non-empty AND PR is open
 * 6. queued              : queued or paused
 * 7. working             : running
 * 8. done                : everything else (completed, cancelled, dropped, etc.)
 */
export function deriveStage(task: TaskStageInput): TaskStage {
  const rawState = String(task.state || task.status || "").trim().toLowerCase();
  const rawStatus = String(task.status || task.state || "").trim().toLowerCase();
  const rawReason = String(task.reason || "").trim().toLowerCase();

  const hasFollowUp = Boolean(task.hasFollowUp || task.has_follow_up);

  const isFailedOrTimeout =
    rawState === "failed" ||
    rawState === "timeout" ||
    rawStatus === "failed" ||
    rawStatus === "timeout" ||
    rawStatus.startsWith("failed ") ||
    rawReason === "timeout";

  // 1. needs_human/failed (failed/timeout 且无后续输入)
  if (isFailedOrTimeout && !hasFollowUp) {
    return "needs_human/failed";
  }

  // 2. needs_human/quota (paused_quota)
  if (rawState === "paused_quota" || rawStatus === "paused_quota") {
    return "needs_human/quota";
  }

  // 3. needs_human/stalled (suspected_stalled)
  if (
    rawState === "suspected_stalled" ||
    rawState === "stalled" ||
    rawStatus === "suspected_stalled" ||
    rawStatus === "stalled"
  ) {
    return "needs_human/stalled";
  }

  // 4. needs_human/answer (report.question 非空)
  const questionVal = task.report?.question !== undefined ? task.report.question : task.question;
  if (typeof questionVal === "string" && questionVal.trim().length > 0) {
    return "needs_human/answer";
  }

  // 5. needs_human/review (outcome=ready 且有 pr_url 且 PR open)
  const outcomeVal = (task.report?.outcome || task.outcome || "").toString().trim().toLowerCase();
  const prUrlVal = (
    task.report?.pr_url !== undefined
      ? task.report.pr_url
      : task.pr_url !== undefined
        ? task.pr_url
        : task.prUrl
  );
  const hasPrUrl = typeof prUrlVal === "string" && prUrlVal.trim().length > 0;
  const prStateNorm = String(task.pr_state || "").trim().toLowerCase();
  const isPrOpen =
    task.pr_open !== false &&
    task.prOpen !== false &&
    prStateNorm !== "closed" &&
    prStateNorm !== "merged";

  if (outcomeVal === "ready" && hasPrUrl && isPrOpen) {
    return "needs_human/review";
  }

  // 6. queued
  if (
    rawState === "queued" ||
    rawState === "paused" ||
    rawStatus === "queued" ||
    rawStatus === "paused"
  ) {
    return "queued";
  }

  // 7. working
  if (rawState === "running" || rawStatus === "running") {
    return "working";
  }

  // 8. done
  return "done";
}

/**
 * Validates raw JSON text against the `$TASK_DIR/report.json` schema:
 * `{"outcome":"ready|blocked|failed|dropped","pr_url":string|null,"question":string|null,"summary":string(<=500字)}`
 */
export function parseAndValidateTaskReport(rawContent: string): {
  valid: boolean;
  report?: TaskReport;
  error?: string;
} {
  if (!rawContent || typeof rawContent !== "string" || !rawContent.trim()) {
    return { valid: false, error: "Empty report content" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err: any) {
    return { valid: false, error: `Invalid JSON: ${err?.message || String(err)}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, error: "Report root must be a JSON object" };
  }

  if (typeof parsed.outcome !== "string" || !VALID_OUTCOMES.has(parsed.outcome as TaskOutcome)) {
    return {
      valid: false,
      error: `Invalid outcome "${String(parsed.outcome)}"; expected ready|blocked|failed|dropped`,
    };
  }

  if (parsed.pr_url !== null && typeof parsed.pr_url !== "string") {
    return { valid: false, error: "pr_url must be string or null" };
  }

  if (parsed.question !== null && typeof parsed.question !== "string") {
    return { valid: false, error: "question must be string or null" };
  }

  if (typeof parsed.summary !== "string") {
    return { valid: false, error: "summary must be a string" };
  }

  // Count Unicode code points (or characters) and enforce <= 500 chars
  const summaryChars = Array.from(parsed.summary);
  if (summaryChars.length > 500) {
    return {
      valid: false,
      error: `summary exceeds maximum length of 500 characters (got ${summaryChars.length})`,
    };
  }

  const normalizedPrUrl =
    typeof parsed.pr_url === "string" && parsed.pr_url.trim().length > 0
      ? parsed.pr_url.trim()
      : null;
  const normalizedQuestion =
    typeof parsed.question === "string" && parsed.question.trim().length > 0
      ? parsed.question.trim()
      : null;

  return {
    valid: true,
    report: {
      outcome: parsed.outcome as TaskOutcome,
      pr_url: normalizedPrUrl,
      question: normalizedQuestion,
      summary: parsed.summary.trim(),
    },
  };
}

/**
 * Extracts a heuristic question from agent output when report.json is missing/invalid.
 * Only triggers when the output explicitly contains a structured question marker or ends with a direct question line.
 */
export function extractHeuristicQuestion(text: string): string | null {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const line = lines[i];
    const m = line.match(/^(?:QUESTION|需要确认|待确认问题|请确认)\s*[:：]\s*(.+)$/i);
    if (m && m[1].trim()) {
      return m[1].trim().slice(0, 300);
    }
  }
  return null;
}

/**
 * Builds a fallback heuristic report when `$TASK_DIR/report.json` is missing or fails schema validation.
 */
export function buildHeuristicTaskReport(params: {
  state: string;
  prUrl?: string | null;
  summaryText?: string | null;
  reason?: string | null;
  rawOutput?: string | null;
}): TaskReport {
  const normState = (params.state || "").trim().toLowerCase();
  const pr_url = params.prUrl && params.prUrl.trim() ? params.prUrl.trim() : null;
  const question = params.rawOutput ? extractHeuristicQuestion(params.rawOutput) : null;

  let outcome: TaskOutcome = "ready";
  if (normState === "cancelled") {
    outcome = "dropped";
  } else if (normState === "failed" || normState === "timeout") {
    outcome = "failed";
  } else if (normState === "paused_quota" || normState === "suspected_stalled" || question) {
    outcome = "blocked";
  } else {
    outcome = "ready";
  }

  const rawSummary = (params.summaryText || params.reason || "").trim();
  const summary = Array.from(rawSummary).slice(0, 500).join("");

  return {
    outcome,
    pr_url,
    question,
    summary,
  };
}

/**
 * Resolves the per-task directory path (`$AGENT_BRIDGE_ROOT/reports/<taskId>`).
 */
export function getTaskReportDir(rootDir: string, taskId: string): string {
  return path.join(rootDir, "reports", taskId);
}

/**
 * Reads `$TASK_DIR/report.json` if present and valid; otherwise falls back to heuristic extraction
 * and marks `report_source = "heuristic"`.
 */
export function readOrFallbackTaskReport(
  taskDir: string,
  fallbackParams: {
    state: string;
    prUrl?: string | null;
    summaryText?: string | null;
    reason?: string | null;
    rawOutput?: string | null;
  }
): { report: TaskReport; report_source: ReportSource; validation_error?: string } {
  const reportPath = path.join(taskDir, "report.json");
  if (fs.existsSync(reportPath)) {
    try {
      const raw = fs.readFileSync(reportPath, "utf8");
      const validated = parseAndValidateTaskReport(raw);
      if (validated.valid && validated.report) {
        // If agent omitted pr_url in report.json but heuristic found one, keep report.json's value unless null & heuristic has it
        return {
          report: validated.report,
          report_source: "report_json",
        };
      }
      return {
        report: buildHeuristicTaskReport(fallbackParams),
        report_source: "heuristic",
        validation_error: validated.error,
      };
    } catch (err: any) {
      return {
        report: buildHeuristicTaskReport(fallbackParams),
        report_source: "heuristic",
        validation_error: err?.message || String(err),
      };
    }
  }

  return {
    report: buildHeuristicTaskReport(fallbackParams),
    report_source: "heuristic",
  };
}

/**
 * Generates the prompt suffix instructing the agent to write `$TASK_DIR/report.json` before exiting.
 */
export function buildReportJsonPromptInstruction(taskDir?: string): string {
  const targetExpr = taskDir ? `${taskDir}/report.json (or $TASK_DIR/report.json)` : `$TASK_DIR/report.json`;
  return (
    `\n\n---\n` +
    `[Structured Report Requirement]\n` +
    `Before finishing, you MUST write a valid JSON file to \`$TASK_DIR/report.json\` (${targetExpr}) with the following exact schema:\n` +
    `{"outcome":"ready|blocked|failed|dropped","pr_url":string|null,"question":string|null,"summary":string(<=500 chars)}\n` +
    `- Use "ready" when your work is complete (include "pr_url" if a PR was created/updated, otherwise null).\n` +
    `- Use "blocked" when you need human clarification (put your question in "question").\n` +
    `- Use "failed" if an unrecoverable error prevented completion.\n` +
    `- Use "dropped" if the task was intentionally skipped or superseded.\n` +
    `- Keep "summary" concise (at most 500 characters).\n`
  );
}

export interface SystemHealthState {
  callback_consecutive_failures: number;
  last_callback_error?: string;
  last_callback_at?: string;
  worker_consecutive_failures: number;
  last_worker_check_at?: string;
  pool_consecutive_failures: number;
  last_pool_error?: string;
}

export interface SystemIssueItem {
  id: "callback_failures" | "pool_paused" | "worker_offline";
  kind: "callback" | "pool" | "worker";
  title: string;
  detail: string;
  consecutiveFailures: number;
}

export function getSystemHealthPath(rootDir: string): string {
  return path.join(rootDir, "status", "_system_health.json");
}

export function readSystemHealth(rootDir: string): SystemHealthState {
  const p = getSystemHealthPath(rootDir);
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        callback_consecutive_failures: Number(data.callback_consecutive_failures) || 0,
        last_callback_error: data.last_callback_error,
        last_callback_at: data.last_callback_at,
        worker_consecutive_failures: Number(data.worker_consecutive_failures) || 0,
        last_worker_check_at: data.last_worker_check_at,
        pool_consecutive_failures: Number(data.pool_consecutive_failures) || 0,
        last_pool_error: data.last_pool_error,
      };
    } catch {}
  }
  return {
    callback_consecutive_failures: 0,
    worker_consecutive_failures: 0,
    pool_consecutive_failures: 0,
  };
}

export function writeSystemHealth(rootDir: string, update: Partial<SystemHealthState>): SystemHealthState {
  const current = readSystemHealth(rootDir);
  const next: SystemHealthState = {
    ...current,
    ...update,
  };
  const p = getSystemHealthPath(rootDir);
  const dir = path.dirname(p);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch {}
  return next;
}

export function recordCallbackResult(rootDir: string, success: boolean, errorMsg?: string): SystemHealthState {
  const current = readSystemHealth(rootDir);
  if (success) {
    return writeSystemHealth(rootDir, {
      callback_consecutive_failures: 0,
      last_callback_error: undefined,
      last_callback_at: new Date().toISOString(),
    });
  }
  return writeSystemHealth(rootDir, {
    callback_consecutive_failures: current.callback_consecutive_failures + 1,
    last_callback_error: errorMsg || "Callback delivery failed",
    last_callback_at: new Date().toISOString(),
  });
}

export function recordPoolPauseFailure(rootDir: string, paused: boolean, errorMsg?: string): SystemHealthState {
  const current = readSystemHealth(rootDir);
  if (!paused) {
    return writeSystemHealth(rootDir, {
      pool_consecutive_failures: 0,
      last_pool_error: undefined,
    });
  }
  return writeSystemHealth(rootDir, {
    pool_consecutive_failures: current.pool_consecutive_failures + 1,
    last_pool_error: errorMsg || "Account pool paused / quota exhausted",
  });
}

/**
 * Computes active system issues for the Home Console.
 * Strictly returns ONLY items whose consecutive failure / pause count is >= 3.
 * When all items have < 3 consecutive failures, returns `[]` so the UI hides the section completely.
 */
export function computeSystemIssues(
  rootDir: string,
  options?: {
    workerAlive?: boolean;
    pausedPoolCount?: number;
  }
): SystemIssueItem[] {
  let health = readSystemHealth(rootDir);

  if (options?.workerAlive !== undefined) {
    if (options.workerAlive) {
      if (health.worker_consecutive_failures > 0) {
        health = writeSystemHealth(rootDir, {
          worker_consecutive_failures: 0,
          last_worker_check_at: new Date().toISOString(),
        });
      }
    } else {
      health = writeSystemHealth(rootDir, {
        worker_consecutive_failures: health.worker_consecutive_failures + 1,
        last_worker_check_at: new Date().toISOString(),
      });
    }
  }

  const issues: SystemIssueItem[] = [];

  // 1. Callback consecutive failures >= 3
  if (health.callback_consecutive_failures >= 3) {
    issues.push({
      id: "callback_failures",
      kind: "callback",
      title: `回调连续失败 (${health.callback_consecutive_failures} 次)`,
      detail: health.last_callback_error || "Webhook/Callback 投递连续失败",
      consecutiveFailures: health.callback_consecutive_failures,
    });
  }

  // 2. Account pool consecutive quota pauses or >= 3 paused profiles
  const poolFailCount = Math.max(
    health.pool_consecutive_failures || 0,
    options?.pausedPoolCount || 0
  );
  if (poolFailCount >= 3) {
    issues.push({
      id: "pool_paused",
      kind: "pool",
      title: `账号池暂停告警 (${poolFailCount} 次/个)`,
      detail: health.last_pool_error || `${poolFailCount} 个账号或连续任务因配额/登录问题暂停`,
      consecutiveFailures: poolFailCount,
    });
  }

  // 3. Worker offline consecutive checks >= 3
  if (health.worker_consecutive_failures >= 3) {
    issues.push({
      id: "worker_offline",
      kind: "worker",
      title: `Worker 掉线 (连续 ${health.worker_consecutive_failures} 次检测未响应)`,
      detail: "后台 Worker 进程未运行或 PID 已失效，新任务将无法执行",
      consecutiveFailures: health.worker_consecutive_failures,
    });
  }

  return issues;
}
