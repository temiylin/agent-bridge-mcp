import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveBridgeRoot } from "./config.js";
import { isValidTaskId, resolveSafePath } from "./validator.js";
import { getLastLogLine, extractPrUrl } from "./recent-tasks.js";

export type WebhookEvent = "completed" | "failed" | "pr_opened";

export interface TaskWebhookConfig {
  url: string;
  headers?: Record<string, string>;
  events?: WebhookEvent[];
  secret?: string;
}

export interface WebhookPayload {
  taskId: string;
  session_id?: string;
  status: "completed" | "failed" | "pr_opened";
  pr_url?: string;
  elapsed_ms?: number;
  last_log_snippet?: string;
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
  terminalStatus: "completed" | "failed" | "cancelled" | "paused_quota",
  sessionId?: string,
  elapsedMs?: number
): Promise<void> {
  try {
    const config = getTaskWebhook(rootDir, taskId);
    if (!config) {
      // Opt-in check: no webhook configured for this task -> skip
      return;
    }

    // Determine matching event
    const status = terminalStatus === "completed" ? "completed" : "failed";
    const allowedEvents = config.events || ["completed", "failed"];

    // Check if PR URL exists in outputs
    const outPath = path.join(rootDir, "logs", `${taskId}.out`);
    const resPath = path.join(rootDir, "results", `${taskId}.md`);
    let prUrl: string | undefined = undefined;

    if (fs.existsSync(outPath)) {
      try {
        prUrl = extractPrUrl(fs.readFileSync(outPath, "utf8"));
      } catch {}
    }
    if (!prUrl && fs.existsSync(resPath)) {
      try {
        prUrl = extractPrUrl(fs.readFileSync(resPath, "utf8"));
      } catch {}
    }

    const isPrEvent = !!prUrl && allowedEvents.includes("pr_opened");
    const isStatusEvent = allowedEvents.includes(status);

    if (!isStatusEvent && !isPrEvent) {
      return;
    }

    // Extract last log snippet <= 200 chars
    let snippet = getLastLogLine(outPath, 200);
    if (!snippet && fs.existsSync(resPath)) {
      snippet = getLastLogLine(resPath, 200);
    }

    const payload: WebhookPayload = {
      taskId,
      session_id: sessionId,
      status: (isPrEvent && status === "completed" ? "pr_opened" : status) as any,
      pr_url: prUrl,
      elapsed_ms: elapsedMs,
      last_log_snippet: snippet ? snippet.slice(0, 200) : undefined,
    };

    // Deliver with retry (non-blocking)
    deliverWebhookWithRetry(config.url, payload, config.headers, config.secret).catch(() => {});
  } catch {}
}
