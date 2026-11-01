import fs from "node:fs";
import path from "node:path";
import { resolveBridgeRoot } from "./config.js";
import { isValidTaskId, resolveSafePath } from "./validator.js";

export interface StashedTaskState {
  taskId: string;
  session_id?: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  prompt: string;
  worktreePath?: string;
  errorSnippet?: string;
  pausedAt: string;
}

export function getQuotaStashDir(rootDir: string = resolveBridgeRoot()): string {
  const dir = path.join(rootDir, "stash");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Checks whether an execution error message / output indicates quota or rate limit exhaustion.
 * Specifically checks for AGY exit codes and standard error strings.
 */
export function isQuotaExhaustedError(
  exitCode: number | null,
  stdout: string,
  stderr: string
): boolean {
  // Only an explicit 429 exit code counts on its own. Other non-zero codes (e.g. agy exit 3
  // with an empty log, or 129/SIGHUP) are NOT quota evidence — require explicit text below.
  if (exitCode === 429) {
    return true;
  }

  const combined = (stdout + "\n" + stderr).toLowerCase();
  if (!combined.trim()) return false;

  const quotaPatterns = [
    /quota\s*(?:exceeded|exhausted|limit|reached)/i,
    /rate\s*limit/i,
    /resource_exhausted/i,
    /account\s*(?:limit|exhausted|quota)/i,
    /out\s*of\s*quota/i,
    /usage\s*limit\s*reached/i,
    /exceeded\s*your\s*current\s*quota/i,
    /too\s*many\s*requests/i,
    /status[:\s]*429/i,
    /insufficient_quota/i,
    /credits?\s*(?:expired|exhausted|depleted)/i,
    /please\s*switch\s*account/i,
    /token\s*limit\s*exceeded/i,
    /free\s*tier\s*quota/i,
  ];

  return quotaPatterns.some((pat) => pat.test(combined));
}

/** Detects explicit evidence that the agy login/credentials are invalid or expired. */
export function isLoginInvalidError(stdout: string, stderr: string): boolean {
  const combined = stdout + "\n" + stderr;
  if (!combined.trim()) return false;
  const patterns = [
    /UNAUTHENTICATED/,
    /invalid_grant/i,
    /\b(?:status|code)[:\s(]*401\b/i,
    /not\s+(?:logged|signed)\s+in/i,
    /please\s+(?:log|sign)\s*in/i,
    /(?:login|session|credentials?|refresh\s*token|oauth\s*token)\s+(?:has\s+)?(?:expired|revoked|invalid)/i,
    /invalid\s+(?:authentication\s+)?credentials/i,
    /re-?authenticate/i,
  ];
  return patterns.some((p) => p.test(combined));
}

export type AgyFailureKind = "quota" | "login" | "other";

/** Classifies a non-zero agent exit. Quota only on explicit evidence. */
export function classifyAgentFailure(exitCode: number | null, stdout: string, stderr: string): AgyFailureKind {
  if (exitCode === 0) return "other";
  if (isQuotaExhaustedError(exitCode, stdout, stderr)) return "quota";
  if (isLoginInvalidError(stdout, stderr)) return "login";
  return "other";
}

/**
 * Parses "Resets in 68h38m30s" style hints into an absolute ISO time.
 * Returns undefined when no hint is present.
 */
export function parseQuotaResetTime(text: string, now: number = Date.now()): string | undefined {
  const m = /resets?\s+in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+)\s*s)?/i.exec(text || "");
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return undefined;
  const sec = (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
  if (sec <= 0) return undefined;
  return new Date(now + sec * 1000).toISOString();
}

/**
 * Stashes the context of a paused quota task so it can be resumed identically.
 */
export function stashQuotaTask(
  rootDir: string,
  state: StashedTaskState
): void {
  if (!isValidTaskId(state.taskId)) {
    throw new Error(`Invalid taskId for quota stash: "${state.taskId}"`);
  }
  const stashDir = getQuotaStashDir(rootDir);
  const targetPath = resolveSafePath(stashDir, rootDir, `${state.taskId}.json`);
  const tmpPath = resolveSafePath(stashDir, rootDir, `${state.taskId}.json.tmp`);

  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Reads a stashed quota task.
 */
export function getStashedQuotaTask(
  rootDir: string,
  taskIdOrSessionId: string
): StashedTaskState | null {
  const stashDir = getQuotaStashDir(rootDir);
  if (!fs.existsSync(stashDir)) return null;

  // 1. Direct taskId match
  if (isValidTaskId(taskIdOrSessionId)) {
    try {
      const p = resolveSafePath(stashDir, rootDir, `${taskIdOrSessionId}.json`);
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8")) as StashedTaskState;
      }
    } catch {}
  }

  // 2. Scan for matching session_id
  let files: string[] = [];
  try {
    files = fs.readdirSync(stashDir);
  } catch {
    return null;
  }

  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    try {
      const raw = fs.readFileSync(path.join(stashDir, f), "utf8");
      const obj = JSON.parse(raw) as StashedTaskState;
      if (obj && (obj.session_id === taskIdOrSessionId || obj.taskId === taskIdOrSessionId)) {
        return obj;
      }
    } catch {}
  }

  return null;
}

/**
 * Removes stashed quota task upon resume.
 */
export function removeStashedQuotaTask(
  rootDir: string,
  taskId: string
): boolean {
  if (!isValidTaskId(taskId)) return false;
  const stashDir = getQuotaStashDir(rootDir);
  try {
    const p = resolveSafePath(stashDir, rootDir, `${taskId}.json`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      return true;
    }
  } catch {}
  return false;
}
