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
