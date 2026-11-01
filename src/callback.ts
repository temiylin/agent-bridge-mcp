import fs from "node:fs";
import { resolveBridgeRoot } from "./config.js";
import { extractLastLines } from "./redaction.js";
import { isAllowedCallbackEnvVarName } from "./project-router.js";

export type TaskTerminalStatus = "completed" | "failed" | "timeout" | "cancelled" | "stuck" | "overdue";

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

export interface ResolveCallbackHeadersOptions {
  /**
   * When true (e.g. headers originating from `projects.json`), bare strings are NOT sent as plain literals;
   * every header must reference a whitelisted environment variable (`^AGENT_BRIDGE_CB_[A-Z0-9_]+$` or `allowedEnv`),
   * and any undefined variable throws an error so the callback is aborted rather than sent with an empty/raw value.
   */
  strictEnvOnly?: boolean;
  allowedEnv?: string[];
}

export interface TaskCallbackOptions {
  url?: string;
  headers?: Record<string, string>;
  strictHeaders?: boolean;
  allowedEnv?: string[];
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
 * Resolves header dictionary where values reference environment variable names:
 * - Supports `"$VAR"`, `"${VAR}"`, `"Bearer $VAR"` / `"Bearer ${VAR}"`, or bare `"VAR"`.
 * - Any `$VAR` / `${VAR}` reference that is undefined or empty in `process.env` throws an Error so the request is NOT sent.
 * - When `options.strictEnvOnly` is true (or when `$VAR` is used), also enforces the callback env var whitelist
 *   (`^AGENT_BRIDGE_CB_[A-Z0-9_]+$` or `options.allowedEnv`) and rejects bare non-env literal strings.
 */
export function resolveCallbackHeaders(
  rawHeaders?: Record<string, string>,
  options?: ResolveCallbackHeadersOptions
): Record<string, string> {
  const resolved: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "agent-bridge-callback/1.0",
  };

  if (!rawHeaders || typeof rawHeaders !== "object") {
    return resolved;
  }

  const strict = Boolean(options?.strictEnvOnly);
  const allowedEnv = options?.allowedEnv;

  for (const [key, rawVal] of Object.entries(rawHeaders)) {
    if (typeof rawVal !== "string") continue;
    const val = rawVal.trim();
    if (!val) continue;

    // 1. Value contains $VAR or ${VAR} (e.g. "$AGENT_BRIDGE_CB_TOKEN" or "Bearer $AGENT_BRIDGE_CB_TOKEN")
    if (val.includes("$")) {
      const m = val.match(/^(?:([A-Za-z0-9._-]+)\s+)?\$(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))$/);
      if (!m) {
        throw new Error(
          `Invalid callback header "${key}" format: "${val}". Expected "$AGENT_BRIDGE_CB_XXX" or "Bearer $AGENT_BRIDGE_CB_XXX".`
        );
      }
      const prefix = m[1];
      const envName = m[2] || m[3];
      if (strict) {
        const wl = isAllowedCallbackEnvVarName(envName, allowedEnv);
        if (!wl.allowed) {
          throw new Error(`Callback header "${key}" rejected: ${wl.reason}`);
        }
      }
      const secretVal = process.env[envName];
      if (secretVal === undefined || secretVal === "") {
        throw new Error(
          `Callback header "${key}" references environment variable "${envName}" which is not set in process.env.`
        );
      }
      resolved[key] = prefix ? `${prefix} ${secretVal}` : secretVal;
      continue;
    }

    // 2. Bare string without '$'
    if (strict) {
      if (!/^[A-Z_][A-Z0-9_]{1,127}$/.test(val)) {
        throw new Error(
          `Project callback header "${key}" must reference an environment variable (e.g. "$AGENT_BRIDGE_CB_TOKEN"), not a raw literal.`
        );
      }
      const wl = isAllowedCallbackEnvVarName(val, allowedEnv);
      if (!wl.allowed) {
        throw new Error(`Callback header "${key}" rejected: ${wl.reason}`);
      }
      const secretVal = process.env[val];
      if (secretVal === undefined || secretVal === "") {
        throw new Error(
          `Callback header "${key}" references environment variable "${val}" which is not set in process.env.`
        );
      }
      resolved[key] = secretVal;
      continue;
    }

    // Non-strict legacy task-level header: if it looks like an uppercase env var name, require it from process.env
    if (/^[A-Z_][A-Z0-9_]{1,127}$/.test(val)) {
      const secretVal = process.env[val];
      if (secretVal === undefined || secretVal === "") {
        throw new Error(
          `Callback header "${key}" references environment variable "${val}" which is not set in process.env.`
        );
      }
      resolved[key] = secretVal;
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
  const {
    url,
    headers,
    strictHeaders,
    allowedEnv,
    taskId,
    agent,
    status,
    exitCode,
    durationSeconds,
    resultPath,
    logPath,
    prUrl,
    outputLog,
    project,
    logger,
  } = options;

  if (!url || !url.trim()) {
    return { success: true, attempts: 0 };
  }

  const targetUrl = url.trim();
  let resolvedHeaders: Record<string, string>;
  try {
    resolvedHeaders = resolveCallbackHeaders(headers, {
      strictEnvOnly: strictHeaders !== undefined ? strictHeaders : Boolean(project),
      allowedEnv,
    });
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (logger) {
      logger("ERROR", `Completion callback for task ${taskId} aborted: ${errMsg}`);
    }
    return { success: false, attempts: 0, error: errMsg };
  }

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
