import fs from "node:fs";
import path from "node:path";
import { readStatus, writeStatus, TaskStatusInfo, ACTIVE_STATES } from "./status.js";
import { isValidTaskId } from "./validator.js";

/** True if a process with this pid exists (EPERM counts as alive). */
export function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** Last N non-empty lines of logs/<id>.out and logs/<id>.err (stdout and stderr). */
export function tailTaskLog(rootDir: string, taskId: string, lines = 15, maxChars = 1500): string {
  const parts: string[] = [];
  for (const ext of ["out", "err"]) {
    const p = path.join(rootDir, "logs", `${taskId}.${ext}`);
    try {
      const st = fs.statSync(p);
      if (st.size === 0) continue;
      const fd = fs.openSync(p, "r");
      const len = Math.min(st.size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const tail = buf.toString("utf8").split(/\r?\n/).filter(l => l.trim()).slice(-lines).join("\n");
      if (tail) parts.push(ext === "err" ? `[stderr]\n${tail}` : tail);
    } catch {}
  }
  const s = parts.join("\n");
  return s.length > maxChars ? s.slice(-maxChars) : s;
}

function readLockPid(rootDir: string, taskId: string): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(rootDir, "control", `${taskId}.lock`), "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export interface ReconcileOptions {
  /** Do not touch tasks younger than this (ms). Default 15s. */
  graceMs?: number;
  /** Child dead but worker alive: wait this long for the worker to write final status. Default 90s. */
  childExitGraceMs?: number;
  /** Final state to write for orphaned tasks (cancel_task uses "cancelled"). */
  finalState?: "failed" | "cancelled";
  now?: number;
}

/**
 * Bring a status record in line with reality. A task recorded as running/suspected_stalled
 * whose worker (and agent) processes are gone is rewritten as failed with exitCode null,
 * a reason and the last log lines, its stale lock is removed and a result file is written
 * so the worker never re-claims it. Returns the (possibly updated) status.
 */
export function reconcileTaskStatus(rootDir: string, status: TaskStatusInfo, opts: ReconcileOptions = {}): TaskStatusInfo {
  const taskId = status.taskId;
  if (!taskId || !isValidTaskId(taskId)) return status;
  if (!ACTIVE_STATES.includes(status.state)) return status;
  const now = opts.now ?? Date.now();
  const startedMs = status.startedAt ? new Date(status.startedAt).getTime() : NaN;
  if (Number.isFinite(startedMs) && now - startedMs < (opts.graceMs ?? 15_000)) return status;

  const lockPid = readLockPid(rootDir, taskId);
  const workerPid = status.workerPid ?? lockPid;
  const workerAlive = isPidAlive(workerPid);
  const childAlive = status.pid ? isPidAlive(status.pid) : undefined;

  let why = "";
  if (!workerAlive) {
    if (childAlive) return status; // orphaned but agent still running; leave it alone
    why = workerPid
      ? `worker process ${workerPid} is gone (relay restarted or crashed)${status.pid ? ` and agent pid ${status.pid} is not running` : ""}`
      : "no worker owns this task (no lock / worker pid recorded); relay likely restarted";
  } else if (childAlive === false) {
    let statusAge = Infinity;
    try {
      statusAge = now - fs.statSync(path.join(rootDir, "status", `${taskId}.json`)).mtimeMs;
    } catch {}
    const grace = opts.childExitGraceMs ?? 90_000;
    if (grace > 0 && statusAge < grace) return status;
    why = `agent pid ${status.pid} exited but the worker never recorded a final status`;
  } else {
    return status;
  }

  const finalState = opts.finalState || "failed";
  const finishedAt = new Date(now).toISOString();
  const logTail = tailTaskLog(rootDir, taskId);
  const reason = `${finalState === "cancelled" ? "cancelled; " : ""}process exited without reporting: ${why}${logTail ? "" : "; log is empty"}`;
  const updated: TaskStatusInfo = {
    ...status,
    state: finalState,
    finishedAt,
    exitCode: null,
    reason,
    ...(logTail ? { logTail } : {}),
  };
  try {
    writeStatus(rootDir, taskId, updated);
  } catch {}
  try {
    const lockPath = path.join(rootDir, "control", `${taskId}.lock`);
    if (fs.existsSync(lockPath) && !isPidAlive(readLockPid(rootDir, taskId))) fs.unlinkSync(lockPath);
  } catch {}
  try {
    const resultsDir = path.join(rootDir, "results");
    const resPath = path.join(resultsDir, `${taskId}.md`);
    if (!fs.existsSync(resPath)) {
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        resPath,
        `# Execution Result for ${taskId}\n\n- **Status**: ${finalState} (reconciled)\n- **Agent**: ${status.agent || "(none)"}\n- **Started At**: ${status.startedAt || ""}\n- **Finished At**: ${finishedAt}\n- **Exit Code**: (none)\n- **Reason**: ${reason}\n\n## Output\n\n${logTail || "(no output captured)"}\n`,
        "utf8"
      );
    }
  } catch {}
  return updated;
}

/** Read + reconcile a single task. */
export function readReconciledStatus(rootDir: string, taskId: string, opts?: ReconcileOptions): TaskStatusInfo | null {
  const st = readStatus(rootDir, taskId);
  if (!st) return null;
  return reconcileTaskStatus(rootDir, { taskId, ...st }, opts);
}

/** Reconcile every active status file; returns ids that were changed. */
export function reconcileAllTasks(rootDir: string, opts?: ReconcileOptions): string[] {
  const dir = path.join(rootDir, "status");
  const changed: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return changed;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    if (!isValidTaskId(id)) continue;
    const st = readStatus(rootDir, id);
    if (!st || !ACTIVE_STATES.includes(st.state)) continue;
    const after = reconcileTaskStatus(rootDir, { taskId: id, ...st }, opts);
    if (after.state !== st.state) changed.push(id);
  }
  return changed;
}

/** Newest mtime (ms) under dir, shallow-ish scan bounded by depth/entries; skips heavy dirs. */
export function newestMtime(dir: string | undefined, maxDepth = 3, maxEntries = 3000): number {
  if (!dir) return 0;
  let newest = 0;
  let seen = 0;
  const skip = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next"]);
  const walk = (d: string, depth: number) => {
    if (seen > maxEntries) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > maxEntries) return;
      const p = path.join(d, e.name);
      try {
        const m = fs.lstatSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch {}
      if (e.isDirectory() && depth < maxDepth && !skip.has(e.name)) walk(p, depth + 1);
    }
  };
  try {
    newest = fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
  walk(dir, 1);
  // git index changes when the agent stages/commits
  try {
    const m = fs.statSync(path.join(dir, ".git", "index")).mtimeMs;
    if (m > newest) newest = m;
  } catch {}
  return newest;
}

/** Stall threshold in ms from AGENT_BRIDGE_STALL_MINUTES (default 20; 0 disables). */
export function getStallThresholdMs(): number {
  const raw = process.env.AGENT_BRIDGE_STALL_MINUTES;
  const n = raw === undefined || raw === "" ? 20 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : 0;
}
