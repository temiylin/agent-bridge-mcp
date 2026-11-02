import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { resolveBridgeRoot } from "./config.js";
import { resolveGhPath, runGhCommand } from "./github-pr.js";
import { isPidAlive } from "./task-reconcile.js";
import { readStatus } from "./status.js";

export type WorktreeStatus = "idle" | "busy" | "locked";
export type WorktreeTaskMode = "read_write" | "read_only";

export interface WorktreeConfig {
  baseBranch?: string;
  name: string;
  mode?: WorktreeTaskMode;
}

export interface SetupWorktreeOptions {
  worktreeRoot?: string;
  repoDir: string;
  baseBranch?: string;
  worktreeName: string;
  symlinkDirs?: string[];
  logger?: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
  bridgeRoot?: string;
  projectId?: string;
  planId?: string;
  stepId?: string;
  prUrl?: string;
}

export interface SetupWorktreeResult {
  worktreeDir: string;
  created: boolean;
  branch: string;
  record: WorktreeRecord;
}

export interface WorktreeLockInfo {
  locked: boolean;
  locked_by?: string; // taskId, username, or "manual"
  locked_at?: string;
  reason?: string;
  task_id?: string;
  mode?: WorktreeTaskMode;
}

export interface WorktreeRecord {
  worktree_id: string; // e.g. "wt_free_story"
  name: string; // folder name / slug
  path: string; // absolute directory path
  project_id?: string;
  repo_path: string;
  branch: string;
  base_branch?: string;
  status: WorktreeStatus;
  active_task_id?: string;
  active_task_mode?: WorktreeTaskMode;
  active_read_task_ids?: string[];
  task_history: string[];
  task_ids?: string[];
  plan_ids: string[];
  plan_id?: string;
  step_id?: string;
  pr_numbers: number[];
  pr_urls: string[];
  pr_url?: string;
  dirty: boolean;
  dirty_stats?: WorktreeDirtyStats;
  lock?: WorktreeLockInfo;
  created_at: string;
  updated_at: string;
}

export interface WorktreesRegistry {
  version: string;
  worktrees: Record<string, WorktreeRecord>;
}

export interface WorktreeGitInfo {
  path: string;
  name: string;
  head: string;
  branch: string;
  is_main: boolean;
  is_bare: boolean;
  is_detached: boolean;
}

export interface WorktreeDirtyStats {
  is_clean: boolean;
  dirty_count: number;
  staged: number;
  modified: number;
  untracked: number;
  files: { path: string; status: string }[];
}

export interface FileConflictWarning {
  file: string;
  conflicting_worktree: string;
  conflicting_branch: string;
  conflicting_tasks?: string[];
  severity: "high" | "warning";
  description: string;
}

export interface WorktreeRemovalSafetyCheck {
  can_remove: boolean;
  blockers: string[];
  details: {
    is_main: boolean;
    active_tasks: string[];
    locked: boolean;
    lock_reason?: string;
    is_dirty: boolean;
    dirty_count: number;
    pr_open: boolean;
    pr_url?: string;
  };
}

export function extractPrNumberFromUrl(prUrl?: string): number | null {
  if (!prUrl) return null;
  const m = prUrl.match(/\/pull\/(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Resolves the default root directory for git worktrees.
 * Precedence:
 * 1. Explicitly configured worktreeRoot
 * 2. process.env.AGENT_BRIDGE_WORKTREE_ROOT
 * 3. <rootDir>/worktrees
 */
export function resolveWorktreeRoot(bridgeRoot: string = resolveBridgeRoot(), customRoot?: string): string {
  if (customRoot && customRoot.trim()) {
    const raw = customRoot.trim();
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~" + path.sep) || raw.startsWith("~/")) {
      return path.resolve(path.join(os.homedir(), raw.slice(2)));
    }
    return path.resolve(raw);
  }

  const envRoot = process.env.AGENT_BRIDGE_WORKTREE_ROOT;
  if (envRoot && envRoot.trim()) {
    return path.resolve(envRoot.trim());
  }

  return path.join(bridgeRoot, "worktrees");
}

export function getWorktreesRegistryPath(bridgeRoot: string = resolveBridgeRoot()): string {
  return path.join(bridgeRoot, "worktrees.json");
}

/**
 * Loads worktrees.json registry with error recovery.
 */
export function loadWorktreesRegistry(bridgeRoot: string = resolveBridgeRoot()): WorktreesRegistry {
  const filePath = getWorktreesRegistryPath(bridgeRoot);
  if (!fs.existsSync(filePath)) {
    return { version: "1.0.0", worktrees: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.worktrees) {
      return { version: "1.0.0", worktrees: {} };
    }
    return parsed as WorktreesRegistry;
  } catch {
    return { version: "1.0.0", worktrees: {} };
  }
}

/**
 * Saves worktrees.json atomically via temporary file rename.
 */
export function saveWorktreesRegistry(bridgeRoot: string, registry: WorktreesRegistry): void {
  const filePath = getWorktreesRegistryPath(bridgeRoot);
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

/**
 * Acquires an exclusive file lock on worktrees.json.lock and executes mutator.
 */
export function withWorktreesLock<T>(
  bridgeRoot: string = resolveBridgeRoot(),
  mutator: (registry: WorktreesRegistry) => { save: boolean; result: T }
): T {
  if (!fs.existsSync(bridgeRoot)) {
    fs.mkdirSync(bridgeRoot, { recursive: true });
  }
  const lockPath = path.join(bridgeRoot, "worktrees.json.lock");
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
          const stats = fs.statSync(lockPath);
          if (Date.now() - stats.mtimeMs > staleLockMs) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
        } catch {}
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
        } catch {
          const sleepUntil = Date.now() + retryDelayMs;
          while (Date.now() < sleepUntil) {}
        }
        continue;
      }
      throw err;
    }
  }

  if (lockFd === null) {
    throw new Error(`Timeout acquiring lock for worktrees.json after ${maxAttempts * retryDelayMs}ms`);
  }

  try {
    const reg = loadWorktreesRegistry(bridgeRoot);
    const { save, result } = mutator(reg);
    if (save) {
      saveWorktreesRegistry(bridgeRoot, reg);
    }
    return result;
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
    }
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  }
}

/**
 * Dynamically evaluates real-time worktree status, dirty state, and cleans up stale/dead task locks.
 */
export function evaluateWorktreeDynamicStatus(
  bridgeRoot: string,
  record: WorktreeRecord,
  repoDir?: string
): {
  status: WorktreeStatus;
  activeTaskId?: string;
  activeTaskMode?: WorktreeTaskMode;
  activeReadTaskIds: string[];
  dirty: boolean;
  dirtyStats: WorktreeDirtyStats;
  isStaleLockCleared: boolean;
} {
  const dirtyStats = getWorktreeDirtyStats(record.path);
  const dirty = !dirtyStats.is_clean;

  // Scan status/ for alive tasks matching this worktree
  const statusDir = path.join(bridgeRoot, "status");
  const targetResolved = path.resolve(record.path);
  let targetCanonical = targetResolved;
  try {
    if (fs.existsSync(targetResolved)) targetCanonical = fs.realpathSync(targetResolved);
  } catch {}

  let activeWriteTask: { taskId: string; agent?: string; pid?: number } | null = null;
  const activeReadTasks: string[] = [];

  if (fs.existsSync(statusDir)) {
    try {
      const files = fs.readdirSync(statusDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(statusDir, f), "utf8");
          const parsed = JSON.parse(raw);
          if (parsed.state === "running" || parsed.state === "suspected_stalled") {
            let taskDirResolved = parsed.workDir ? path.resolve(parsed.workDir) : "";
            let taskDirCanonical = taskDirResolved;
            try {
              if (fs.existsSync(taskDirResolved)) taskDirCanonical = fs.realpathSync(taskDirResolved);
            } catch {}

            const matchesDir = taskDirCanonical && (taskDirCanonical === targetCanonical || taskDirResolved === targetResolved);
            const matchesName = parsed.worktreeName && parsed.worktreeName === record.name;

            if (matchesDir || matchesName) {
              // Check PID liveness for crash recovery!
              const alive = parsed.pid ? isPidAlive(parsed.pid) : true;
              if (alive) {
                const mode = parsed.worktreeMode || "read_write";
                const tid = parsed.taskId || f.replace(/\.json$/, "");
                if (mode === "read_write") {
                  if (!activeWriteTask) {
                    activeWriteTask = { taskId: tid, agent: parsed.agent, pid: parsed.pid };
                  }
                } else {
                  activeReadTasks.push(tid);
                }
              }
            }
          }
        } catch {}
      }
    } catch {}
  }

  let status: WorktreeStatus = "idle";
  let activeTaskId: string | undefined = undefined;
  let activeTaskMode: WorktreeTaskMode | undefined = undefined;
  let isStaleLockCleared = false;

  if (activeWriteTask) {
    status = "busy";
    activeTaskId = activeWriteTask.taskId;
    activeTaskMode = "read_write";
  } else if (record.lock?.locked) {
    let isStale = false;
    if (record.lock.task_id) {
      const lockStatFile = path.join(bridgeRoot, "status", `${record.lock.task_id}.json`);
      if (fs.existsSync(lockStatFile)) {
        try {
          const raw = fs.readFileSync(lockStatFile, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed.state === "completed" || parsed.state === "failed" || parsed.state === "cancelled") {
            isStale = true;
          } else if (parsed.pid && !isPidAlive(parsed.pid)) {
            isStale = true;
          }
        } catch {}
      } else if (record.lock.locked_at) {
        const ageMs = Date.now() - new Date(record.lock.locked_at).getTime();
        if (ageMs > 300000) {
          isStale = true;
        }
      }
    }
    if (!isStale) {
      status = "locked";
    } else {
      isStaleLockCleared = true;
      status = "idle";
    }
  } else {
    status = "idle";
    if (record.active_task_id) {
      isStaleLockCleared = true;
    }
  }

  return {
    status,
    activeTaskId,
    activeTaskMode,
    activeReadTaskIds: activeReadTasks,
    dirty,
    dirtyStats,
    isStaleLockCleared,
  };
}

/**
 * Upserts a worktree record into worktrees.json with accumulated history and dynamic validation.
 */
export function upsertWorktreeRecord(
  bridgeRoot: string,
  record: Partial<WorktreeRecord> & { name: string; path: string }
): WorktreeRecord {
  return withWorktreesLock(bridgeRoot, (registry) => {
    const cleanName = record.name.trim();
    const existing = registry.worktrees[cleanName];
    const now = new Date().toISOString();

    const wtId = record.worktree_id || existing?.worktree_id || `wt_${cleanName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const newTasks = record.task_history || (record.task_ids ? record.task_ids : []);
    const mergedTasks = Array.from(new Set([...(existing?.task_history || []), ...newTasks]));

    const newPlans = record.plan_ids || (record.plan_id ? [record.plan_id] : []);
    const mergedPlans = Array.from(new Set([...(existing?.plan_ids || []), ...newPlans]));

    const effectivePrUrl = record.pr_url || existing?.pr_url;
    const newPrUrls = record.pr_urls || (effectivePrUrl ? [effectivePrUrl] : []);
    const mergedPrUrls = Array.from(new Set([...(existing?.pr_urls || []), ...newPrUrls]));
    const mergedPrNumbers = Array.from(new Set([
      ...(existing?.pr_numbers || []),
      ...mergedPrUrls.map(extractPrNumberFromUrl).filter((n): n is number => n !== null),
    ]));

    const targetPath = path.resolve(record.path);
    const dirtyStats = getWorktreeDirtyStats(targetPath);

    const baseRecord: WorktreeRecord = {
      worktree_id: wtId,
      name: cleanName,
      path: targetPath,
      branch: record.branch || existing?.branch || cleanName,
      project_id: record.project_id || existing?.project_id,
      repo_path: record.repo_path || existing?.repo_path || "",
      base_branch: record.base_branch || existing?.base_branch,
      status: existing?.status || "idle",
      active_task_id: record.active_task_id || existing?.active_task_id,
      active_task_mode: record.active_task_mode || existing?.active_task_mode,
      active_read_task_ids: record.active_read_task_ids || existing?.active_read_task_ids || [],
      task_history: mergedTasks,
      plan_ids: mergedPlans,
      pr_numbers: mergedPrNumbers,
      pr_urls: mergedPrUrls,
      pr_url: effectivePrUrl,
      dirty: !dirtyStats.is_clean,
      dirty_stats: dirtyStats,
      lock: record.lock !== undefined ? record.lock : existing?.lock,
      created_at: existing?.created_at || record.created_at || now,
      updated_at: now,
    };

    const dyn = evaluateWorktreeDynamicStatus(bridgeRoot, baseRecord);
    baseRecord.status = dyn.status;
    baseRecord.active_task_id = dyn.activeTaskId;
    baseRecord.active_task_mode = dyn.activeTaskMode;
    baseRecord.active_read_task_ids = dyn.activeReadTaskIds;
    baseRecord.dirty = dyn.dirty;
    baseRecord.dirty_stats = dyn.dirtyStats;

    registry.worktrees[cleanName] = baseRecord;
    return { save: true, result: baseRecord };
  });
}

/**
 * Removes a worktree record from worktrees.json.
 */
export function deleteWorktreeRecord(bridgeRoot: string, nameOrPath: string): boolean {
  return withWorktreesLock(bridgeRoot, (registry) => {
    const clean = nameOrPath.trim();
    let keyToRemove: string | null = null;
    if (registry.worktrees[clean]) {
      keyToRemove = clean;
    } else {
      const resolved = path.resolve(clean);
      for (const [k, v] of Object.entries(registry.worktrees)) {
        if (path.resolve(v.path) === resolved) {
          keyToRemove = k;
          break;
        }
      }
    }
    if (keyToRemove && registry.worktrees[keyToRemove]) {
      delete registry.worktrees[keyToRemove];
      return { save: true, result: true };
    }
    return { save: false, result: false };
  });
}

/**
 * Creates and setups a Git worktree under worktreeRoot and symlinks specified directories.
 * Automatically registers the worktree as a first-class resource in worktrees.json.
 */
export function setupGitWorktree(options: SetupWorktreeOptions): SetupWorktreeResult {
  const { worktreeRoot, repoDir, baseBranch, worktreeName, symlinkDirs = [], logger, bridgeRoot, projectId, planId, stepId, prUrl } = options;

  if (!fs.existsSync(repoDir)) {
    throw new Error(`Repository directory "${repoDir}" does not exist.`);
  }

  const effectiveBridgeRoot = bridgeRoot || resolveBridgeRoot();
  const effectiveRoot = resolveWorktreeRoot(effectiveBridgeRoot, worktreeRoot);
  fs.mkdirSync(effectiveRoot, { recursive: true });

  // Sanitize worktree folder name (prevent path traversal)
  const safeName = worktreeName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const targetWorktreeDir = path.join(effectiveRoot, safeName);
  const targetBranch = worktreeName;

  let created = false;

  if (!fs.existsSync(targetWorktreeDir)) {
    // 1. Check if branch already exists in repo
    const checkBranch = spawnSync("git", ["rev-parse", "--verify", targetBranch], {
      cwd: repoDir,
      encoding: "utf8",
    });

    const addArgs = ["worktree", "add"];
    if (checkBranch.status === 0) {
      // Existing branch
      addArgs.push(targetWorktreeDir, targetBranch);
    } else {
      // Create branch based on baseBranch or HEAD
      addArgs.push("-b", targetBranch, targetWorktreeDir);
      if (baseBranch && baseBranch.trim()) {
        addArgs.push(baseBranch.trim());
      }
    }

    const res = spawnSync("git", addArgs, { cwd: repoDir, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git worktree add failed: ${res.stderr || res.stdout || "unknown error"}`);
    }
    created = true;
    if (logger) {
      logger("INFO", `Created git worktree at ${targetWorktreeDir} for branch ${targetBranch}`);
    }
  } else {
    if (logger) {
      logger("INFO", `Reusing existing git worktree at ${targetWorktreeDir}`);
    }
  }

  // 2. Symlink configured directories (e.g. node_modules, build caches)
  for (const dirName of symlinkDirs) {
    if (!dirName || typeof dirName !== "string") continue;
    const cleanDir = dirName.trim();
    if (!cleanDir) continue;

    const sourcePath = path.join(repoDir, cleanDir);
    const destPath = path.join(targetWorktreeDir, cleanDir);

    if (fs.existsSync(sourcePath)) {
      try {
        if (fs.existsSync(destPath) || fs.lstatSync(destPath).isSymbolicLink()) {
          try {
            const isSym = fs.lstatSync(destPath).isSymbolicLink();
            if (isSym) {
              const target = fs.readlinkSync(destPath);
              if (path.resolve(path.dirname(destPath), target) === path.resolve(sourcePath)) {
                continue;
              }
            }
            fs.rmSync(destPath, { recursive: true, force: true });
          } catch {}
        }
      } catch {}

      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.symlinkSync(sourcePath, destPath, process.platform === "win32" ? "junction" : "dir");
        if (logger) {
          logger("INFO", `Symlinked ${sourcePath} -> ${destPath}`);
        }
      } catch (err: any) {
        if (logger) {
          logger("WARN", `Failed to symlink directory ${cleanDir}: ${err?.message || String(err)}`);
        }
      }
    }
  }

  // Auto-record as First-Class Resource in registry
  const record = upsertWorktreeRecord(effectiveBridgeRoot, {
    name: safeName,
    path: targetWorktreeDir,
    branch: targetBranch,
    repo_path: repoDir,
    base_branch: baseBranch,
    project_id: projectId,
    plan_ids: planId ? [planId] : undefined,
    pr_url: prUrl,
    lock: created ? { locked: false } : undefined,
  });

  return {
    worktreeDir: targetWorktreeDir,
    created,
    branch: targetBranch,
    record,
  };
}

/**
 * Discovers the main repository directory for a given worktree by reading its .git pointer file.
 */
export function findRepoFromWorktree(worktreeDir: string): string | undefined {
  const gitPath = path.join(worktreeDir, ".git");
  if (!fs.existsSync(gitPath)) return undefined;
  try {
    const stat = fs.lstatSync(gitPath);
    if (stat.isDirectory()) return worktreeDir;
    const content = fs.readFileSync(gitPath, "utf8");
    const m = content.match(/^gitdir:\s*(.+)$/m);
    if (!m) return undefined;
    const gitdir = path.resolve(worktreeDir, m[1].trim());
    const commondirFile = path.join(gitdir, "commondir");
    if (fs.existsSync(commondirFile)) {
      const rel = fs.readFileSync(commondirFile, "utf8").trim();
      const common = path.resolve(gitdir, rel);
      const mainRepoDir = path.dirname(common);
      if (fs.existsSync(mainRepoDir)) return mainRepoDir;
    }
  } catch {}
  return undefined;
}

/**
 * Lists all active git worktrees directly from Git command output (`git worktree list --porcelain`).
 */
export function listGitWorktrees(repoDir: string): WorktreeGitInfo[] {
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return [];
  }
  const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 8000,
  });
  if (res.status !== 0 || !res.stdout.trim()) {
    return [];
  }

  const entries: WorktreeGitInfo[] = [];
  const blocks = res.stdout.split(/\r?\n\r?\n/);
  const canonicalRepo = fs.existsSync(repoDir) ? fs.realpathSync(repoDir) : path.resolve(repoDir);

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let wtPath = "";
    let head = "";
    let branch = "";
    let isBare = false;
    let isDetached = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wtPath = line.substring(9).trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.substring(5).trim();
      } else if (line.startsWith("branch ")) {
        const fullBranch = line.substring(7).trim();
        branch = fullBranch.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        isBare = true;
      } else if (line === "detached") {
        isDetached = true;
      }
    }

    if (!wtPath) continue;

    let canonicalWt = wtPath;
    try {
      if (fs.existsSync(wtPath)) {
        canonicalWt = fs.realpathSync(wtPath);
      }
    } catch {}

    const isMain = canonicalWt === canonicalRepo || path.resolve(wtPath) === path.resolve(repoDir);
    const repoBase = path.basename(repoDir);
    let name = isMain ? "main" : path.basename(wtPath);
    if (!isMain && (name === repoBase || name === "vision_hub")) {
      const parentDir = path.basename(path.dirname(wtPath));
      if (parentDir && parentDir !== "/" && parentDir !== "." && parentDir !== "worktrees" && parentDir !== "tmp") {
        name = parentDir;
      } else if (branch && !isDetached) {
        name = branch.replace(/^feat\/|^fix\/|^codex\//, "").replace(/\//g, "-");
      }
    }

    entries.push({
      path: wtPath,
      name,
      head,
      branch: branch || (isDetached ? `detached at ${head.slice(0, 8)}` : "HEAD"),
      is_main: isMain,
      is_bare: isBare,
      is_detached: isDetached,
    });
  }

  // Ensure unique, collision-free names across all worktrees
  const seenNames = new Map<string, number>();
  for (const entry of entries) {
    if (entry.is_main) {
      entry.name = "main";
      continue;
    }
    const count = seenNames.get(entry.name) || 0;
    if (count > 0) {
      const suffix = entry.branch && !entry.is_detached && entry.branch !== entry.name
        ? entry.branch.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
        : Math.abs(entry.path.split("").reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(36).slice(0, 4);
      entry.name = `${entry.name}-${suffix}`;
    }
    seenNames.set(entry.name, (seenNames.get(entry.name) || 0) + 1);
  }

  return entries;
}

/**
 * Returns dirty stats (modified, staged, untracked counts) for a worktree.
 */
export function getWorktreeDirtyStats(worktreePath: string): WorktreeDirtyStats {
  if (!fs.existsSync(worktreePath)) {
    return { is_clean: true, dirty_count: 0, staged: 0, modified: 0, untracked: 0, files: [] };
  }
  const res = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.status !== 0) {
    return { is_clean: true, dirty_count: 0, staged: 0, modified: 0, untracked: 0, files: [] };
  }

  // NOTE: Git porcelain lines have fixed column layout:
  // Position 0: Index status (staged)
  // Position 1: Worktree status (unstaged / modified)
  // Position 2: Space separator
  // Position 3+: File path
  // DO NOT trim lines before slicing columns, or leading space for unstaged files is lost!
  const rawLines = res.stdout.split(/\r?\n/).filter((l) => l.length >= 3);
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  const files: { path: string; status: string }[] = [];

  for (const line of rawLines) {
    const x = line[0];
    const y = line[1];
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.replace(/^"|"$/g, "");

    if (x === "?" && y === "?") {
      untracked++;
      files.push({ path: filePath, status: "??" });
    } else {
      const isStaged = x !== " " && x !== "?";
      const isModified = y !== " " && y !== "?";
      if (isStaged) staged++;
      if (isModified) modified++;
      files.push({ path: filePath, status: `${x}${y}`.trim() });
    }
  }

  const dirty_count = files.length;
  return {
    is_clean: dirty_count === 0,
    dirty_count,
    staged,
    modified,
    untracked,
    files,
  };
}

/**
 * Scans status/ directory to find all tasks actively running or queued in a worktree path.
 */
export function findActiveTasksInWorktree(
  bridgeRoot: string,
  worktreePath: string
): { taskId: string; state: string; stage?: string; agent?: string; startedAt?: string; mode?: WorktreeTaskMode }[] {
  const statusDir = path.join(bridgeRoot, "status");
  if (!fs.existsSync(statusDir)) return [];

  const targetResolved = path.resolve(worktreePath);
  let targetCanonical = targetResolved;
  try {
    if (fs.existsSync(targetResolved)) {
      targetCanonical = fs.realpathSync(targetResolved);
    }
  } catch {}

  const active: { taskId: string; state: string; stage?: string; agent?: string; startedAt?: string; mode?: WorktreeTaskMode }[] = [];
  try {
    const files = fs.readdirSync(statusDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(statusDir, f), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.state === "running" || parsed.state === "suspected_stalled" || parsed.state === "queued") {
          // Dynamic crash recovery: if state is running but PID is dead, it is not an active task
          if (parsed.state === "running" && parsed.pid && !isPidAlive(parsed.pid)) {
            continue;
          }
          let taskDirResolved = parsed.workDir ? path.resolve(parsed.workDir) : "";
          let taskDirCanonical = taskDirResolved;
          try {
            if (fs.existsSync(taskDirResolved)) {
              taskDirCanonical = fs.realpathSync(taskDirResolved);
            }
          } catch {}

          if (taskDirCanonical && (taskDirCanonical === targetCanonical || taskDirResolved === targetResolved)) {
            active.push({
              taskId: parsed.taskId || f.replace(/\.json$/, ""),
              state: parsed.state,
              stage: parsed.stage,
              agent: parsed.agent,
              startedAt: parsed.startedAt,
              mode: parsed.worktreeMode || "read_write",
            });
          }
        }
      } catch {}
    }
  } catch {}
  return active;
}

/**
 * Formats full prompt environment context when the next AI takes over an existing worktree.
 * Automatically injects branch, dirty files, PR details, and previous tasks history.
 */
export function formatWorktreePromptContext(
  bridgeRoot: string,
  worktreeNameOrPath: string,
  repoDir?: string
): {
  prefix: string;
  worktree: WorktreeRecord | null;
  prUrl?: string;
  projectId?: string;
} {
  const reg = loadWorktreesRegistry(bridgeRoot);
  const clean = worktreeNameOrPath.trim();
  let record: WorktreeRecord | undefined = reg.worktrees[clean];
  if (!record) {
    const resolved = path.resolve(clean);
    record = Object.values(reg.worktrees).find((w) => path.resolve(w.path) === resolved);
  }

  if (!record) {
    return {
      prefix: "",
      worktree: null,
    };
  }

  const dyn = evaluateWorktreeDynamicStatus(bridgeRoot, record, repoDir);
  const lines: string[] = [
    `[Worktree Environment: ${record.name}]`,
    `- Worktree ID: ${record.worktree_id}`,
    `- Branch: ${record.branch}${record.base_branch ? ` (based on ${record.base_branch})` : ""}`,
    `- Working Tree: ${dyn.dirty ? `dirty (${dyn.dirtyStats.dirty_count} files changed: ${dyn.dirtyStats.staged} staged, ${dyn.dirtyStats.modified} modified, ${dyn.dirtyStats.untracked} untracked)` : "clean"}`,
  ];

  if (dyn.dirtyStats.files.length > 0) {
    const previewFiles = dyn.dirtyStats.files.slice(0, 5).map((f) => `${f.status} ${f.path}`);
    lines.push(`- Changed Files in Worktree: ${previewFiles.join(", ")}${dyn.dirtyStats.files.length > 5 ? ` (and ${dyn.dirtyStats.files.length - 5} more)` : ""}`);
  }

  const effectivePrUrl = record.pr_url || (record.pr_urls && record.pr_urls.length > 0 ? record.pr_urls[record.pr_urls.length - 1] : undefined);
  if (effectivePrUrl) {
    const prNum = extractPrNumberFromUrl(effectivePrUrl);
    lines.push(`- Associated Pull Request: ${effectivePrUrl}${prNum ? ` (#${prNum})` : ""}`);
  }

  if (record.task_history && record.task_history.length > 0) {
    lines.push(`- Previous Tasks in this Worktree (${record.task_history.length} total):`);
    const recentTaskIds = record.task_history.slice(-3);
    for (const tid of recentTaskIds) {
      try {
        const st = readStatus(bridgeRoot, tid);
        if (st) {
          const outcome = st.outcome || st.state;
          const summary = st.report?.summary || (st as any).summary || "";
          lines.push(`  * ${tid} (${st.agent || "agent"}): ${outcome}${summary ? ` - "${summary.slice(0, 120)}"` : ""}`);
        } else {
          lines.push(`  * ${tid}`);
        }
      } catch {
        lines.push(`  * ${tid}`);
      }
    }
  }

  lines.push(`- Instruction: You are working inside this dedicated worktree. Continue from the current branch and preserve existing uncommitted progress.`);

  return {
    prefix: lines.join("\n") + "\n\n",
    worktree: record,
    prUrl: effectivePrUrl,
    projectId: record.project_id,
  };
}

/**
 * Returns current lock status of a worktree, checking both active tasks and explicit locks.
 */
export function getWorktreeLockState(
  bridgeRoot: string,
  nameOrPath: string,
  repoDir?: string
): {
  locked: boolean;
  status: WorktreeStatus;
  lockedByTaskId?: string;
  agent?: string;
  lock?: WorktreeLockInfo;
  activeTasks: { taskId: string; state: string; agent?: string; mode?: WorktreeTaskMode }[];
} {
  const reg = loadWorktreesRegistry(bridgeRoot);
  const clean = nameOrPath.trim();
  let record: WorktreeRecord | undefined = reg.worktrees[clean];
  if (!record) {
    const resolved = path.resolve(clean);
    record = Object.values(reg.worktrees).find((w) => path.resolve(w.path) === resolved);
  }

  const effectivePath = record ? record.path : path.resolve(resolveWorktreeRoot(bridgeRoot), clean);
  const activeTasks = findActiveTasksInWorktree(bridgeRoot, effectivePath);

  // If an active write task is running in this worktree, it is locked
  const activeWriteTask = activeTasks.find((t) => (t.mode || "read_write") === "read_write");
  if (activeWriteTask) {
    return {
      locked: true,
      status: "busy",
      lockedByTaskId: activeWriteTask.taskId,
      agent: activeWriteTask.agent,
      lock: {
        locked: true,
        locked_by: activeWriteTask.taskId,
        task_id: activeWriteTask.taskId,
        locked_at: activeWriteTask.startedAt,
        reason: `Writing task execution in progress (${activeWriteTask.state})`,
        mode: "read_write",
      },
      activeTasks,
    };
  }

  // Otherwise check explicit lock in registry
  if (record?.lock?.locked) {
    let isStale = false;
    if (record.lock.task_id) {
      const lockStatFile = path.join(bridgeRoot, "status", `${record.lock.task_id}.json`);
      if (fs.existsSync(lockStatFile)) {
        try {
          const raw = fs.readFileSync(lockStatFile, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed.state === "completed" || parsed.state === "failed" || parsed.state === "cancelled") {
            isStale = true;
          } else if (parsed.pid && !isPidAlive(parsed.pid)) {
            isStale = true;
          }
        } catch {}
      } else if (record.lock.locked_at) {
        const ageMs = Date.now() - new Date(record.lock.locked_at).getTime();
        if (ageMs > 300000) {
          isStale = true;
        }
      }
    }
    if (!isStale) {
      return {
        locked: true,
        status: "locked",
        lockedByTaskId: record.lock.task_id,
        lock: record.lock,
        activeTasks,
      };
    }
  }

  return {
    locked: false,
    status: "idle",
    activeTasks,
  };
}

/**
 * Acquires an exclusive write lock on a worktree (or registers a read-only task).
 */
export function acquireWorktreeLock(
  bridgeRoot: string,
  nameOrPath: string,
  lockInfo: WorktreeLockInfo,
  force: boolean = false
): { success: boolean; error?: string; lock?: WorktreeLockInfo } {
  return withWorktreesLock<{ success: boolean; error?: string; lock?: WorktreeLockInfo }>(bridgeRoot, (registry) => {
    const clean = nameOrPath.trim();
    let record: WorktreeRecord | undefined = registry.worktrees[clean];
    if (!record) {
      const resolved = path.resolve(clean);
      record = Object.values(registry.worktrees).find((w) => path.resolve(w.path) === resolved);
    }

    const currentLock = getWorktreeLockState(bridgeRoot, nameOrPath);
    const requestedMode = lockInfo.mode || "read_write";

    if (requestedMode === "read_write" && currentLock.locked && !force) {
      if (currentLock.lockedByTaskId && currentLock.lockedByTaskId !== lockInfo.task_id) {
        return {
          save: false,
          result: {
            success: false,
            error: `Worktree "${nameOrPath}" is currently occupied by active writing task "${currentLock.lockedByTaskId}". Pass force: true to override.`,
          },
        };
      }
      if (currentLock.lock && currentLock.lock.locked_by !== lockInfo.locked_by && !currentLock.lockedByTaskId) {
        return {
          save: false,
          result: {
            success: false,
            error: `Worktree "${nameOrPath}" is already locked by "${currentLock.lock.locked_by}" (${currentLock.lock.reason || "no reason"}). Pass force: true to override.`,
          },
        };
      }
    }

    const now = new Date().toISOString();
    const effectiveLock: WorktreeLockInfo = {
      locked: true,
      locked_by: lockInfo.locked_by || lockInfo.task_id || "caller",
      locked_at: now,
      reason: lockInfo.reason || "Locked for writing task",
      task_id: lockInfo.task_id,
      mode: requestedMode,
    };

    if (record) {
      if (requestedMode === "read_write") {
        record.lock = effectiveLock;
        record.status = "busy";
        record.active_task_id = lockInfo.task_id;
        record.active_task_mode = "read_write";
      } else {
        if (lockInfo.task_id) {
          record.active_read_task_ids = Array.from(new Set([...(record.active_read_task_ids || []), lockInfo.task_id]));
        }
      }
      record.updated_at = now;
      if (lockInfo.task_id && !record.task_history?.includes(lockInfo.task_id)) {
        record.task_history = [...(record.task_history || []), lockInfo.task_id];
      }
    } else {
      registry.worktrees[clean] = {
        worktree_id: `wt_${clean.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        name: clean,
        path: path.resolve(resolveWorktreeRoot(bridgeRoot), clean),
        branch: clean,
        repo_path: "",
        status: requestedMode === "read_write" ? "busy" : "idle",
        active_task_id: requestedMode === "read_write" ? lockInfo.task_id : undefined,
        active_task_mode: requestedMode === "read_write" ? "read_write" : undefined,
        active_read_task_ids: requestedMode === "read_only" && lockInfo.task_id ? [lockInfo.task_id] : [],
        task_history: lockInfo.task_id ? [lockInfo.task_id] : [],
        plan_ids: [],
        pr_numbers: [],
        pr_urls: [],
        dirty: false,
        lock: effectiveLock,
        created_at: now,
        updated_at: now,
      };
    }

    return {
      save: true,
      result: {
        success: true,
        lock: effectiveLock,
      },
    };
  });
}

/**
 * Releases an exclusive write lock on a worktree.
 */
export function releaseWorktreeLock(
  bridgeRoot: string,
  nameOrPath: string,
  force: boolean = false,
  taskId?: string
): { success: boolean; error?: string } {
  return withWorktreesLock<{ success: boolean; error?: string; lock?: WorktreeLockInfo }>(bridgeRoot, (registry) => {
    const clean = nameOrPath.trim();
    let record: WorktreeRecord | undefined = registry.worktrees[clean];
    if (!record) {
      const resolved = path.resolve(clean);
      record = Object.values(registry.worktrees).find((w) => path.resolve(w.path) === resolved);
    }

    const effectivePath = record ? record.path : path.resolve(resolveWorktreeRoot(bridgeRoot), clean);
    const activeTasks = findActiveTasksInWorktree(bridgeRoot, effectivePath);

    if (activeTasks.length > 0 && !force) {
      const otherActiveWriteTasks = activeTasks.filter((t) => t.taskId !== taskId && (t.mode || "read_write") === "read_write");
      if (otherActiveWriteTasks.length > 0) {
        return {
          save: false,
          result: {
            success: false,
            error: `Cannot release worktree lock: Writing task "${otherActiveWriteTasks[0].taskId}" is actively executing. Stop or wait for the task to finish, or pass force: true.`,
          },
        };
      }
    }

    if (record) {
      record.lock = { locked: false };
      record.status = "idle";
      if (taskId && record.active_task_id === taskId) {
        record.active_task_id = undefined;
        record.active_task_mode = undefined;
      }
      if (taskId && record.active_read_task_ids) {
        record.active_read_task_ids = record.active_read_task_ids.filter((id) => id !== taskId);
      }
      record.updated_at = new Date().toISOString();
      return { save: true, result: { success: true } };
    }

    return { save: false, result: { success: true } };
  });
}

/**
 * Detects cross-task file conflicts by comparing modified and uncommitted files across all active worktrees.
 */
export function detectWorktreeFileConflicts(
  targetWorktreePath: string,
  repoDir: string,
  baseBranch: string = "main"
): FileConflictWarning[] {
  const warnings: FileConflictWarning[] = [];
  if (!fs.existsSync(targetWorktreePath) || !fs.existsSync(repoDir)) {
    return warnings;
  }

  // 1. Get changed files for target worktree
  const targetDirty = getWorktreeDirtyStats(targetWorktreePath);
  const targetDirtyFiles = new Set(targetDirty.files.map((f) => f.path));

  // Query committed files on target worktree ahead of base branch
  const targetDiffRes = spawnSync("git", ["diff", "--name-only", `${baseBranch}...HEAD`], {
    cwd: targetWorktreePath,
    encoding: "utf8",
    timeout: 5000,
  });
  const targetCommittedFiles =
    targetDiffRes.status === 0
      ? new Set(targetDiffRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
      : new Set<string>();

  const allTargetFiles = new Set([...targetDirtyFiles, ...targetCommittedFiles]);
  if (allTargetFiles.size === 0) return warnings;

  // 2. Discover relevant worktrees for this repo (focusing on Agent Bridge managed worktrees)
  const allWorktrees = listGitWorktrees(repoDir);
  const registry = loadWorktreesRegistry();
  const bridgeWorktreeRoot = resolveWorktreeRoot();

  let targetCanonical = targetWorktreePath;
  try {
    targetCanonical = fs.realpathSync(targetWorktreePath);
  } catch {}

  const candidateWorktrees = allWorktrees.filter((wt) => {
    if (wt.is_main) return false;
    if (!fs.existsSync(wt.path)) return false;
    const isTracked = !!registry.worktrees[wt.name] || Object.values(registry.worktrees).some((w) => path.resolve(w.path) === path.resolve(wt.path));
    const isUnderBridge = path.resolve(wt.path).startsWith(bridgeWorktreeRoot);
    return isTracked || isUnderBridge;
  });

  const targetList = candidateWorktrees.length > 0 ? candidateWorktrees : allWorktrees.filter((w) => !w.is_main && fs.existsSync(w.path)).slice(0, 5);

  for (const wt of targetList) {
    let wtCanonical = wt.path;
    try {
      wtCanonical = fs.realpathSync(wt.path);
    } catch {
      continue;
    }
    if (wtCanonical === targetCanonical) continue; // Skip self

    const otherDirty = getWorktreeDirtyStats(wt.path);
    const otherDiffRes = spawnSync("git", ["diff", "--name-only", `${baseBranch}...HEAD`], {
      cwd: wt.path,
      encoding: "utf8",
      timeout: 5000,
    });
    const otherFiles = new Set([
      ...otherDirty.files.map((f) => f.path),
      ...(otherDiffRes.status === 0 ? otherDiffRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []),
    ]);

    for (const file of allTargetFiles) {
      if (otherFiles.has(file)) {
        const bothDirty = targetDirtyFiles.has(file) && otherDirty.files.some((f) => f.path === file);
        warnings.push({
          file,
          conflicting_worktree: wt.name,
          conflicting_branch: wt.branch,
          severity: bothDirty ? "high" : "warning",
          description: bothDirty
            ? `File "${file}" has uncommitted modifications in both current worktree and "${wt.name}". High probability of merge collision.`
            : `File "${file}" is modified in both current worktree and "${wt.name}" (branch: ${wt.branch}). Potential merge conflict.`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Checks safety preconditions before removing a worktree:
 * 1. Target is not main repo root
 * 2. No active tasks executing
 * 3. Not explicitly locked
 * 4. No uncommitted modifications
 * 5. Associated PR is not still OPEN
 */
export function checkWorktreeRemovalSafety(
  bridgeRoot: string,
  nameOrPath: string,
  repoDir?: string
): WorktreeRemovalSafetyCheck {
  const blockers: string[] = [];
  const clean = nameOrPath.trim();
  const reg = loadWorktreesRegistry(bridgeRoot);
  let record: WorktreeRecord | undefined = reg.worktrees[clean];
  if (!record) {
    const resolved = path.resolve(clean);
    record = Object.values(reg.worktrees).find((w) => w.worktree_id === clean || path.resolve(w.path) === resolved);
  }

  let effectivePath: string;
  if (record) {
    effectivePath = record.path;
  } else if (path.isAbsolute(clean) && fs.existsSync(clean)) {
    effectivePath = path.resolve(clean);
  } else if (repoDir && fs.existsSync(path.join(repoDir, ".git"))) {
    const gts = listGitWorktrees(repoDir);
    const match = gts.find((g) => g.path === clean || g.name === clean || g.branch === clean || path.resolve(g.path) === path.resolve(clean));
    if (match) {
      effectivePath = match.path;
    } else if (clean === "main" || clean === "wt_main") {
      effectivePath = path.resolve(repoDir);
    } else {
      effectivePath = path.resolve(resolveWorktreeRoot(bridgeRoot), clean);
    }
  } else if (clean === "main" || clean === "wt_main") {
    effectivePath = repoDir ? path.resolve(repoDir) : path.resolve(resolveWorktreeRoot(bridgeRoot), clean);
  } else {
    effectivePath = path.resolve(resolveWorktreeRoot(bridgeRoot), clean);
  }

  const effectiveRepo = repoDir || record?.repo_path || findRepoFromWorktree(effectivePath);

  // 1. Check if main repo
  let isMain = false;
  if (effectiveRepo) {
    try {
      const mainCanon = fs.realpathSync(effectiveRepo);
      const wtCanon = fs.existsSync(effectivePath) ? fs.realpathSync(effectivePath) : path.resolve(effectivePath);
      if (mainCanon === wtCanon || path.resolve(effectivePath) === path.resolve(effectiveRepo) || clean === "main" || clean === "wt_main") {
        isMain = true;
        blockers.push("Target directory is the main Git repository root and cannot be removed as a worktree.");
      }
    } catch {
      if (path.resolve(effectivePath) === path.resolve(effectiveRepo) || clean === "main" || clean === "wt_main") {
        isMain = true;
        blockers.push("Target directory is the main Git repository root and cannot be removed as a worktree.");
      }
    }
  }
  if (!isMain && (clean === "main" || clean === "wt_main")) {
    isMain = true;
    blockers.push("Target directory is the main Git repository root and cannot be removed as a worktree.");
  }

  // 2. Check running tasks
  const activeTasks = findActiveTasksInWorktree(bridgeRoot, effectivePath);
  if (activeTasks.length > 0) {
    const tids = activeTasks.map((t) => t.taskId);
    blockers.push(`Active task(s) currently executing in this worktree: [${tids.join(", ")}].`);
  }

  // 3. Check lock
  let isLocked = false;
  let lockReason: string | undefined;
  if (record?.lock?.locked) {
    isLocked = true;
    lockReason = record.lock.reason;
    blockers.push(`Worktree is explicitly locked by "${record.lock.locked_by}" (${record.lock.reason || "no reason"}).`);
  }

  // 4. Check dirty files
  const dirty = getWorktreeDirtyStats(effectivePath);
  if (!dirty.is_clean) {
    blockers.push(`Worktree has ${dirty.dirty_count} uncommitted modification(s) (${dirty.staged} staged, ${dirty.modified} modified, ${dirty.untracked} untracked).`);
  }

  // 5. Check open PR
  let prOpen = false;
  const prUrl = record?.pr_url || (record?.pr_urls && record.pr_urls.length > 0 ? record.pr_urls[record.pr_urls.length - 1] : undefined);
  if (prUrl) {
    let checkDone = false;
    const ghBin = resolveGhPath();
    if (ghBin && effectiveRepo) {
      try {
        const ghRes = runGhCommand(["pr", "view", prUrl, "--json", "state,number,title"], effectiveRepo, 10000);
        if (ghRes.exitCode === 0) {
          const prData = JSON.parse(ghRes.stdout);
          if (prData.state === "OPEN") {
            prOpen = true;
            blockers.push(`Associated PR #${prData.number} ("${prData.title}") is currently OPEN and unmerged. Retaining workspace for review and testing.`);
            checkDone = true;
          } else {
            checkDone = true;
          }
        }
      } catch {}
    }

    if (!checkDone) {
      const statusDir = path.join(bridgeRoot, "status");
      if (fs.existsSync(statusDir)) {
        try {
          const files = fs.readdirSync(statusDir).filter((f) => f.endsWith(".json"));
          for (const f of files) {
            try {
              const statusRaw = fs.readFileSync(path.join(statusDir, f), "utf8");
              const parsed = JSON.parse(statusRaw);
              if (parsed.pr_url === prUrl && parsed.pr_open === true) {
                prOpen = true;
                blockers.push(`Associated PR (${prUrl}) is marked open. Retaining worktree workspace for review.`);
                break;
              }
            } catch {}
          }
        } catch {}
      }
    }
  }

  return {
    can_remove: blockers.length === 0,
    blockers,
    details: {
      is_main: isMain,
      active_tasks: activeTasks.map((t) => t.taskId),
      locked: isLocked,
      lock_reason: lockReason,
      is_dirty: !dirty.is_clean,
      dirty_count: dirty.dirty_count,
      pr_open: prOpen,
      pr_url: prUrl,
    },
  };
}

/**
 * Safely removes a git worktree that is confirmed to reside under the bridge worktrees root.
 * Enforces that workDir:
 * 1. Is an absolute path
 * 2. Strictly resides within the bridge worktrees root directory (no path traversal, never outside)
 * 3. Is not the worktree root itself or any parent directory
 *
 * Uses `git worktree remove --force <worktreeDir>` executed in the repo or fallback to safe rmSync within the root.
 */
export function removeGitWorktree(
  bridgeRoot: string,
  worktreeDir: string,
  repoDir?: string,
  logger?: (level: "INFO" | "WARN" | "ERROR", msg: string) => void
): { success: boolean; error?: string } {
  const rawRoot = path.resolve(resolveWorktreeRoot(bridgeRoot));
  let effectiveRoot = rawRoot;
  try {
    if (fs.existsSync(rawRoot)) {
      effectiveRoot = fs.realpathSync(rawRoot);
    }
  } catch {}

  const rawTarget = path.resolve(worktreeDir);
  let targetDir = rawTarget;
  try {
    if (fs.existsSync(rawTarget)) {
      targetDir = fs.realpathSync(rawTarget);
    }
  } catch {}

  // Strict containment check: targetDir must be a subdirectory of effectiveRoot
  const rel = path.relative(effectiveRoot, targetDir);
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      success: false,
      error: `Worktree path "${targetDir}" is outside bridge worktree root "${effectiveRoot}". Removal refused for security.`,
    };
  }

  if (!fs.existsSync(targetDir)) {
    deleteWorktreeRecord(bridgeRoot, targetDir);
    return { success: true };
  }

  // 1. Resolve repoDir: use provided repoDir or inspect worktree's .git pointer
  const effectiveRepoDir = (repoDir && fs.existsSync(repoDir)) ? repoDir : findRepoFromWorktree(targetDir);

  if (effectiveRepoDir && fs.existsSync(effectiveRepoDir)) {
    try {
      const res = spawnSync("git", ["worktree", "remove", "--force", targetDir], {
        cwd: effectiveRepoDir,
        encoding: "utf8",
      });
      if (res.status === 0) {
        if (logger) logger("INFO", `Removed git worktree via git at ${targetDir}`);
        deleteWorktreeRecord(bridgeRoot, targetDir);
        return { success: true };
      }
      if (logger) {
        logger("WARN", `git worktree remove failed: ${res.stderr || res.stdout || "unknown"}; falling back to clean removal within worktree root`);
      }
    } catch (e: any) {
      if (logger) logger("WARN", `git worktree remove exception: ${e?.message}`);
    }
  }

  // 2. Safe removal strictly inside effectiveRoot, followed by git worktree prune in repo
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    if (logger) logger("INFO", `Safely removed worktree directory at ${targetDir}`);

    if (effectiveRepoDir && fs.existsSync(effectiveRepoDir)) {
      try {
        const pruneRes = spawnSync("git", ["worktree", "prune"], {
          cwd: effectiveRepoDir,
          encoding: "utf8",
        });
        if (pruneRes.status === 0) {
          if (logger) logger("INFO", `Pruned git worktrees in ${effectiveRepoDir}`);
        } else if (logger) {
          logger("WARN", `git worktree prune warning: ${pruneRes.stderr || pruneRes.stdout || "unknown"}`);
        }
      } catch (e: any) {
        if (logger) logger("WARN", `git worktree prune exception: ${e?.message}`);
      }
    }

    deleteWorktreeRecord(bridgeRoot, targetDir);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
