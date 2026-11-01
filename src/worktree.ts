import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { resolveBridgeRoot } from "./config.js";

export interface WorktreeConfig {
  baseBranch?: string;
  name: string;
}

export interface SetupWorktreeOptions {
  worktreeRoot?: string;
  repoDir: string;
  baseBranch?: string;
  worktreeName: string;
  symlinkDirs?: string[];
  logger?: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
}

export interface SetupWorktreeResult {
  worktreeDir: string;
  created: boolean;
  branch: string;
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

/**
 * Creates and setups a Git worktree under worktreeRoot and symlinks specified directories.
 */
export function setupGitWorktree(options: SetupWorktreeOptions): SetupWorktreeResult {
  const { worktreeRoot, repoDir, baseBranch, worktreeName, symlinkDirs = [], logger } = options;

  if (!fs.existsSync(repoDir)) {
    throw new Error(`Repository directory "${repoDir}" does not exist.`);
  }

  const effectiveRoot = resolveWorktreeRoot(undefined, worktreeRoot);
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
        // If destPath exists and is already a symlink pointing to sourcePath, skip
        if (fs.existsSync(destPath) || fs.lstatSync(destPath).isSymbolicLink()) {
          try {
            const isSym = fs.lstatSync(destPath).isSymbolicLink();
            if (isSym) {
              const target = fs.readlinkSync(destPath);
              if (path.resolve(path.dirname(destPath), target) === path.resolve(sourcePath)) {
                continue;
              }
            }
            // If it's a directory or stale symlink, remove it to replace with symlink
            fs.rmSync(destPath, { recursive: true, force: true });
          } catch {}
        }
      } catch {
        // destPath might not exist yet
      }

      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        // Use junction on Windows, dir on unix
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

  return {
    worktreeDir: targetWorktreeDir,
    created,
    branch: targetBranch,
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
  // Use realpath to resolve canonical paths and prevent symlink traversal
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

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
