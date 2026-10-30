import fs from "node:fs";
import { resolveBridgeRoot } from "./config.js";
import { extractLastLines } from "./redaction.js";

export type TaskTerminalStatus = "completed" | "failed" | "timeout" | "cancelled" | "stuck";

export interface TaskCallbackPayload {
  task_id: string;
  project?: string;
  agent: string;
  status: TaskTerminalStatus;
  exit_code: number | null;
  duration_s: number;
  result_path: string;
  log_path: string;
  pr_url?: string;
  last_log_lines?: string[];
}

export interface TaskCallbackOptions {
  url?: string;
  headers?: Record<string, string>;
  project?: string;
  taskId: string;
  agent: string;
  status: TaskTerminalStatus;
  exitCode: number | null;
  durationSeconds: number;
  resultPath: string;
  logPath: string;
  prUrl?: string;
  outputLog?: string;
  logger?: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
}

/**
 * Resolves header dictionary where values may be environment variable names.
 * For each key/value in configured headers:
 * If value starts with "$" or matches an existing process.env variable name, read from env.
 * Otherwise, if process.env[value] is defined, use that secret; fallback to the literal value if not an env var.
 * Secrets are strictly read from env var names rather than forced literals.
 */
export function resolveCallbackHeaders(rawHeaders?: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "agent-bridge-callback/1.0",
  };

  if (!rawHeaders || typeof rawHeaders !== "object") {
    return resolved;
  }

  for (const [key, rawVal] of Object.entries(rawHeaders)) {
    if (typeof rawVal !== "string") continue;
    const val = rawVal.trim();
    if (!val) continue;

    if (val.startsWith("$")) {
      const envName = val.slice(1);
      resolved[key] = process.env[envName] || "";
    } else if (process.env[val] !== undefined) {
      resolved[key] = process.env[val] || "";
    } else {
      resolved[key] = val;
    }
  }

  return resolved;
}

/**
 * Extracts PR URL from output or log text.
 */
export function extractPrUrl(text: string): string | undefined {
  if (!text) return undefined;
  // Match standard GitHub PR urls e.g. https://github.com/org/repo/pull/123
  const match = text.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)/);
  if (match) {
    return match[0];
  }
  return undefined;
}

/**
 * Reads the last 20 lines of a log file or text for failure reporting.
 */
export function extractLast20LogLines(logPathOrText: string): string[] {
  let content = logPathOrText;
  if (fs.existsSync(logPathOrText)) {
    try {
      content = fs.readFileSync(logPathOrText, "utf8");
    } catch {
      content = "";
    }
  }

  const rawLines = extractLastLines(content, 20, 10000);
  if (!rawLines) return [];
  return rawLines.split("\n").filter(Boolean);
}

/**
 * Dispatches completion HTTP POST callback in background with 3x retry and backoff.
 * Non-blocking: returns a promise that resolves immediately or runs asynchronously.
 */
export async function sendCompletionCallback(options: TaskCallbackOptions): Promise<{ success: boolean; attempts: number; error?: string }> {
  const { url, headers, taskId, agent, status, exitCode, durationSeconds, resultPath, logPath, prUrl, outputLog, project, logger } = options;

  if (!url || !url.trim()) {
    return { success: true, attempts: 0 };
  }

  const targetUrl = url.trim();
  const resolvedHeaders = resolveCallbackHeaders(headers);

  let detectedPrUrl = prUrl;
  if (!detectedPrUrl && outputLog) {
    detectedPrUrl = extractPrUrl(outputLog);
  }
  if (!detectedPrUrl && fs.existsSync(logPath)) {
    try {
      const logContent = fs.readFileSync(logPath, "utf8");
      detectedPrUrl = extractPrUrl(logContent);
    } catch {}
  }

  let lastLogLines: string[] | undefined;
  const isFailureState = status === "failed" || status === "timeout" || status === "stuck";
  if (isFailureState) {
    lastLogLines = extractLast20LogLines(outputLog || logPath);
  }

  const payload: TaskCallbackPayload = {
    task_id: taskId,
    project: project || undefined,
    agent,
    status,
    exit_code: exitCode,
    duration_s: durationSeconds,
    result_path: resultPath,
    log_path: logPath,
    ...(detectedPrUrl ? { pr_url: detectedPrUrl } : {}),
    ...(lastLogLines && lastLogLines.length > 0 ? { last_log_lines: lastLogLines } : {}),
  };

  const bodyStr = JSON.stringify(payload);
  const maxAttempts = 3;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(targetUrl, {
        method: "POST",
        headers: resolvedHeaders,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        if (logger) {
          logger("INFO", `Completion callback for task ${taskId} sent successfully to ${targetUrl} (attempt ${attempt})`);
        }
        return { success: true, attempts: attempt };
      } else {
        lastError = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (err: any) {
      lastError = err?.message || String(err);
    }

    if (attempt < maxAttempts) {
      // Exponential backoff: 500ms, 1500ms
      const delayMs = attempt * 500;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (logger) {
    logger("WARN", `Completion callback for task ${taskId} failed after ${maxAttempts} attempts: ${lastError}`);
  }

  return { success: false, attempts: maxAttempts, error: lastError };
}
