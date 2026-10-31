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
  // Exit code 429 or specific AGY quota exit codes
  if (exitCode === 429 || exitCode === 129) {
    return true;
  }

  const combined = (stdout + "\n" + stderr).toLowerCase();

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
