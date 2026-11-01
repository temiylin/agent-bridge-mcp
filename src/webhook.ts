import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveBridgeRoot } from "./config.js";
import { isValidTaskId, resolveSafePath } from "./validator.js";
import { getLastLogLine, extractPrUrl } from "./recent-tasks.js";
import { readStatus } from "./status.js";
import { deriveStage, type TaskStage, type TaskOutcome } from "./task-stage.js";

export type WebhookEvent = "completed" | "failed" | "pr_opened" | "stalled" | "timeout" | "stuck" | "overdue" | "cancelled";

export type WebhookPayloadStatus = "completed" | "failed" | "pr_opened" | "stalled" | "timeout" | "stuck" | "overdue" | "cancelled";

export const TERMINAL_WEBHOOK_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "paused_quota",
]);

const inMemoryDeliveredTerminalTasks = new Set<string>();
const inMemoryInFlightTerminalTasks = new Set<string>();

export interface TaskWebhookConfig {
  url: string;
  headers?: Record<string, string>;
  events?: WebhookEvent[];
  secret?: string;
}

export interface WebhookPayload {
  taskId: string;
  session_id?: string;
  status: WebhookPayloadStatus;
  stage?: TaskStage;
  outcome?: TaskOutcome;
  question?: string | null;
  pr_url?: string;
  elapsed_ms?: number;
  last_log_snippet?: string;
  plan_id?: string;
  step_id?: string;
  plan_title?: string;
}

export function getWebhooksDir(rootDir: string = resolveBridgeRoot()): string {
  const dir = path.join(rootDir, "webhooks");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Saves opt-in per-task webhook configuration atomically.
 */
export function setTaskWebhook(rootDir: string, taskId: string, config: TaskWebhookConfig): void {
  if (!isValidTaskId(taskId)) {
    throw new Error(`Invalid taskId for webhook: "${taskId}"`);
  }
  if (!config.url || typeof config.url !== "string" || !config.url.startsWith("http")) {
    throw new Error(`Invalid webhook URL: "${config.url}". Must be an http/https URL.`);
  }

  const webhooksDir = getWebhooksDir(rootDir);
  const targetPath = resolveSafePath(webhooksDir, rootDir, `${taskId}.json`);
  const tmpPath = resolveSafePath(webhooksDir, rootDir, `${taskId}.json.tmp`);

  const normalizedConfig: TaskWebhookConfig = {
    url: config.url.trim(),
    headers: config.headers,
    events: config.events && Array.isArray(config.events) ? config.events : ["completed", "failed"],
    secret: config.secret ? config.secret.trim() : undefined,
  };

  fs.writeFileSync(tmpPath, JSON.stringify(normalizedConfig, null, 2), "utf8");
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Reads opt-in webhook config for a task. Returns null if not set.
 */
export function getTaskWebhook(rootDir: string, taskId: string): TaskWebhookConfig | null {
  if (!isValidTaskId(taskId)) return null;
  const webhooksDir = getWebhooksDir(rootDir);
  let targetPath: string;
  try {
    targetPath = resolveSafePath(webhooksDir, rootDir, `${taskId}.json`);
  } catch {
    return null;
  }

  if (!fs.existsSync(targetPath)) return null;
  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    return JSON.parse(raw) as TaskWebhookConfig;
  } catch {
    return null;
  }
}

/**
 * Removes opt-in webhook config for a task.
 */
export function clearTaskWebhook(rootDir: string, taskId: string): boolean {
  if (!isValidTaskId(taskId)) return false;
  const webhooksDir = getWebhooksDir(rootDir);
  let targetPath: string;
  try {
    targetPath = resolveSafePath(webhooksDir, rootDir, `${taskId}.json`);
  } catch {
    return false;
  }

  if (fs.existsSync(targetPath)) {
    try {
      fs.unlinkSync(targetPath);
      inMemoryDeliveredTerminalTasks.delete(taskId);
      try {
        const deliveredPath = path.join(webhooksDir, `${taskId}.delivered`);
        if (fs.existsSync(deliveredPath)) fs.unlinkSync(deliveredPath);
      } catch {}
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Computes HMAC-SHA256 signature for body.
 */
export function computeHmacSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Maps worker terminal / alert states to webhook payload status with event-filter fallback.
 */
export function resolveWebhookDelivery(
  terminalStatus: string,
  allowedEvents: WebhookEvent[]
): { deliver: boolean; payloadStatus: WebhookPayloadStatus } | null {
  const normalized = terminalStatus.toLowerCase();

  if (normalized === "completed") {
    return allowedEvents.includes("completed") ? { deliver: true, payloadStatus: "completed" } : null;
  }
  if (normalized === "suspected_stalled" || normalized === "stalled") {
    return allowedEvents.includes("stalled") ? { deliver: true, payloadStatus: "stalled" } : null;
  }
  if (normalized === "overdue") {
    return allowedEvents.includes("overdue") ? { deliver: true, payloadStatus: "overdue" } : null;
  }
  if (normalized === "stuck") {
    return allowedEvents.includes("stuck") ? { deliver: true, payloadStatus: "stuck" } : null;
  }
  if (normalized === "timeout") {
    if (allowedEvents.includes("timeout")) {
      return { deliver: true, payloadStatus: "timeout" };
    }
    if (allowedEvents.includes("failed")) {
      return { deliver: true, payloadStatus: "failed" };
    }
    return null;
  }
  if (normalized === "cancelled") {
    if (allowedEvents.includes("cancelled")) {
      return { deliver: true, payloadStatus: "cancelled" };
    }
    if (allowedEvents.includes("failed")) {
      return { deliver: true, payloadStatus: "failed" };
    }
    return null;
  }
  if (normalized === "paused_quota") {
    return allowedEvents.includes("failed") ? { deliver: true, payloadStatus: "failed" } : null;
  }
  // failed and other error states
  return allowedEvents.includes("failed") ? { deliver: true, payloadStatus: "failed" } : null;
}

/**
 * Delivers webhook with retries. NEVER throws or blocks caller.
 */
export async function deliverWebhookWithRetry(
  url: string,
  payload: WebhookPayload,
  headers?: Record<string, string>,
  secret?: string,
  maxRetries: number = 2
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "agent-bridge-mcp/1.0",
    ...(headers || {}),
  };

  if (secret) {
    reqHeaders["X-Agent-Bridge-Signature"] = computeHmacSignature(body, secret);
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        method: "POST",
        headers: reqHeaders,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        return true;
      }
      // Non-2xx response: retry if attempts remain
    } catch {
      // Network/timeout error: retry if attempts remain
    }

    if (attempt <= maxRetries) {
      // Exponential backoff: 300ms, 600ms
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }

  return false;
}

/**
 * Triggers completion webhook for a task if opt-in configured.
 * Safely executes in background without throwing.
 */
export async function triggerTaskWebhook(
  rootDir: string,
  taskId: string,
  terminalStatus: "completed" | "failed" | "cancelled" | "paused_quota" | "suspected_stalled" | "timeout" | "overdue" | "stuck" | string,
  sessionId?: string,
  elapsedMs?: number
): Promise<void> {
  try {
    const config = getTaskWebhook(rootDir, taskId);
    if (!config) {
      // Opt-in check: no webhook configured for this task -> skip
      return;
    }

    const allowedEvents = config.events || ["completed", "failed"];
    const resolved = resolveWebhookDelivery(terminalStatus, allowedEvents);
    if (!resolved) {
      return;
    }

    // Check if PR URL exists in status report or outputs
    const outPath = path.join(rootDir, "logs", `${taskId}.out`);
    const resPath = path.join(rootDir, "results", `${taskId}.md`);
    const statusInfo = readStatus(rootDir, taskId);
    let prUrl: string | undefined = (statusInfo?.pr_url ?? statusInfo?.report?.pr_url) || undefined;

    if (!prUrl && fs.existsSync(outPath)) {
      try {
        prUrl = extractPrUrl(fs.readFileSync(outPath, "utf8"));
      } catch {}
    }
    if (!prUrl && fs.existsSync(resPath)) {
      try {
        prUrl = extractPrUrl(fs.readFileSync(resPath, "utf8"));
      } catch {}
    }

    const isPrEvent = !!prUrl && allowedEvents.includes("pr_opened") && resolved.payloadStatus === "completed";

    if (!isPrEvent && !resolved.deliver) {
      return;
    }

    // Deduplicate terminal webhooks so each task fires at most once for terminal states
    const isTerminal = !isPrEvent && (
      TERMINAL_WEBHOOK_STATUSES.has(resolved.payloadStatus) ||
      TERMINAL_WEBHOOK_STATUSES.has(terminalStatus.toLowerCase())
    );
    const webhooksDir = getWebhooksDir(rootDir);
    const deliveredPath = path.join(webhooksDir, `${taskId}.delivered`);
    if (isTerminal) {
      if (
        inMemoryDeliveredTerminalTasks.has(taskId) ||
        inMemoryInFlightTerminalTasks.has(taskId) ||
        fs.existsSync(deliveredPath)
      ) {
        return;
      }
      inMemoryInFlightTerminalTasks.add(taskId);
    }

    // Extract last log snippet <= 200 chars
    let snippet = getLastLogLine(outPath, 200);
    if (!snippet && fs.existsSync(resPath)) {
      snippet = getLastLogLine(resPath, 200);
    }

    const effectiveOutcome: TaskOutcome | undefined =
      statusInfo?.outcome ??
      statusInfo?.report?.outcome ??
      (terminalStatus === "cancelled"
        ? "dropped"
        : terminalStatus === "failed" || terminalStatus === "timeout"
          ? "failed"
          : terminalStatus === "paused_quota" || terminalStatus === "suspected_stalled" || terminalStatus === "stalled"
            ? "blocked"
            : "ready");

    const effectiveQuestion = statusInfo?.question ?? statusInfo?.report?.question ?? null;

    const effectiveStage =
      statusInfo?.stage ||
      deriveStage({
        state: terminalStatus,
        status: resolved.payloadStatus,
        report: statusInfo?.report,
        outcome: effectiveOutcome,
        pr_url: prUrl || null,
        question: effectiveQuestion,
        pr_open: statusInfo?.pr_open,
        hasFollowUp: statusInfo?.hasFollowUp,
      });

    const payload: WebhookPayload = {
      taskId,
      session_id: sessionId,
      status: isPrEvent ? "pr_opened" : resolved.payloadStatus,
      stage: effectiveStage,
      outcome: effectiveOutcome,
      question: effectiveQuestion,
      pr_url: prUrl,
      elapsed_ms: elapsedMs,
      last_log_snippet: snippet ? snippet.slice(0, 200) : undefined,
      ...(statusInfo?.plan_id || statusInfo?.planId ? { plan_id: statusInfo.plan_id || statusInfo.planId } : {}),
      ...(statusInfo?.step_id || statusInfo?.stepId ? { step_id: statusInfo.step_id || statusInfo.stepId } : {}),
      ...(statusInfo?.plan_title || statusInfo?.planTitle ? { plan_title: statusInfo.plan_title || statusInfo.planTitle } : {}),
    };

    // Deliver with retry and only persist .delivered after successful delivery
    deliverWebhookWithRetry(config.url, payload, config.headers, config.secret)
      .then((ok) => {
        inMemoryInFlightTerminalTasks.delete(taskId);
        if (ok && isTerminal) {
          inMemoryDeliveredTerminalTasks.add(taskId);
          try {
            fs.writeFileSync(deliveredPath, resolved.payloadStatus, "utf8");
          } catch {}
        }
      })
      .catch(() => {
        inMemoryInFlightTerminalTasks.delete(taskId);
      });
  } catch {}
}
