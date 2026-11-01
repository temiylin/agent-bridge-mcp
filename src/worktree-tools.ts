import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { resolveProject, getProjectRepoPath, ProjectDefinition } from "./project-router.js";
import {
  listGitWorktrees,
  getWorktreeDirtyStats,
  getWorktreeLockState,
  acquireWorktreeLock,
  releaseWorktreeLock,
  detectWorktreeFileConflicts,
  checkWorktreeRemovalSafety,
  setupGitWorktree,
  removeGitWorktree,
  resolveWorktreeRoot,
  loadWorktreesRegistry,
  findActiveTasksInWorktree,
  upsertWorktreeRecord,
  evaluateWorktreeDynamicStatus,
} from "./worktree.js";
import { runGhCommand, resolveGhPath } from "./github-pr.js";

function resolveRepoAndProject(
  rootDir: string,
  repoPath?: string,
  projectId?: string
): { cwd: string; project?: ProjectDefinition } {
  let project: ProjectDefinition | undefined;
  if (projectId && projectId.trim()) {
    const res = resolveProject(rootDir, { projectId: projectId.trim() });
    if (res.project) {
      project = res.project;
    }
  }

  let cwd = "";
  if (repoPath && typeof repoPath === "string" && repoPath.trim().length > 0) {
    cwd = path.resolve(repoPath.trim());
  } else if (project) {
    const pPath = getProjectRepoPath(project);
    if (pPath) cwd = path.resolve(pPath);
  }

  if (!cwd) {
    const envRepo = process.env.AGENT_BRIDGE_REPO;
    if (envRepo && typeof envRepo === "string" && envRepo.trim().length > 0) {
      cwd = path.resolve(envRepo.trim());
    } else {
      cwd = path.resolve(rootDir);
    }
  }

  return { cwd, project };
}

export function registerWorktreeTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // 1. list_worktrees (P0)
  server.tool(
    "list_worktrees",
    "List all Git worktrees for a project or repository, including branch names, HEAD commits, dirty working tree status, associated PRs, active/recent tasks, and lock status.",
    {
      project_id: z.string().optional().describe("Optional project identifier to locate the workspace repository"),
      repo_path: z.string().optional().describe("Local git repository path. Defaults to project workspace or current repo"),
      include_dirty_stats: z.boolean().optional().describe("Whether to calculate modified/staged file counts per worktree (default: true)"),
    },
    async ({ project_id, repo_path, include_dirty_stats = true }) => {
      audit(rootDir, { tool: "list_worktrees", projectId: project_id });
      const { cwd, project: activeProject } = resolveRepoAndProject(rootDir, repo_path, project_id);
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Path "${cwd}" is not a Git repository.` }],
        };
      }

      const gitWorktrees = listGitWorktrees(cwd);
      const registry = loadWorktreesRegistry(rootDir);

      const items = gitWorktrees.map((wt) => {
        const lockState = getWorktreeLockState(rootDir, wt.name, cwd);
        const activeTasks = findActiveTasksInWorktree(rootDir, wt.path);
        const regRecord = registry.worktrees[wt.name] || Object.values(registry.worktrees).find((w) => path.resolve(w.path) === path.resolve(wt.path));
        const dirty = getWorktreeDirtyStats(wt.path);
        const dyn = regRecord
          ? evaluateWorktreeDynamicStatus(rootDir, regRecord, cwd)
          : {
              status: lockState.locked ? (lockState.lockedByTaskId ? "busy" : "locked") : "idle",
              activeTaskId: lockState.lockedByTaskId,
              activeReadTaskIds: [],
              dirty: !dirty.is_clean,
              dirtyStats: dirty,
            };

        const safety = checkWorktreeRemovalSafety(rootDir, wt.name, cwd);
        const worktreeId = regRecord?.worktree_id || `wt_${wt.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const prUrls = regRecord?.pr_urls || (regRecord?.pr_url ? [regRecord.pr_url] : []);
        const prNumbers = regRecord?.pr_numbers || [];

        return {
          worktree_id: worktreeId,
          project_id: regRecord?.project_id || activeProject?.id,
          name: wt.name,
          path: wt.path,
          branch: wt.branch,
          status: dyn.status,
          active_task_id: dyn.activeTaskId,
          task_history: regRecord?.task_history || [],
          plan_ids: regRecord?.plan_ids || [],
          pr_numbers: prNumbers,
          pr_urls: prUrls,
          pr_url: regRecord?.pr_url || prUrls[0],
          dirty: dyn.dirty,
          dirty_stats: include_dirty_stats ? dyn.dirtyStats : undefined,
          head: wt.head,
          is_main: wt.is_main,
          is_bare: wt.is_bare,
          is_detached: wt.is_detached,
          lock_info: lockState.lock,
          active_tasks: activeTasks,
          can_safely_remove: safety.can_remove,
          removal_blockers: safety.blockers.length > 0 ? safety.blockers : undefined,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                project_id: activeProject?.id,
                repo_path: cwd,
                total_worktrees: items.length,
                worktrees: items,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 2. worktree_status (P0)
  server.tool(
    "worktree_status",
    "Inspect comprehensive status of a specific Git worktree: dirty files, commit diff vs base branch, active tasks, associated PR status, lock state, and cross-task file conflict warnings.",
    {
      name: z.string().describe("Worktree name or directory path (e.g. 'mobile-sidebar-safe-area')"),
      project_id: z.string().optional().describe("Optional project identifier"),
      repo_path: z.string().optional().describe("Optional repo path"),
      base_branch: z.string().optional().describe("Base branch to diff against (defaults to project default_base_branch or 'main')"),
      check_conflicts: z.boolean().optional().describe("Whether to check for cross-task file modifications in other active worktrees (default: true)"),
    },
    async ({ name, project_id, repo_path, base_branch, check_conflicts = true }) => {
      audit(rootDir, { tool: "worktree_status", projectId: project_id });
      const cleanName = name.trim();
      const { cwd, project: activeProject } = resolveRepoAndProject(rootDir, repo_path, project_id);

      // Locate worktree directory
      const gitWorktrees = listGitWorktrees(cwd);
      let targetWt = gitWorktrees.find((w) => w.name === cleanName || path.resolve(w.path) === path.resolve(cleanName));
      if (!targetWt) {
        const potentialPath = path.resolve(cleanName);
        if (fs.existsSync(potentialPath)) {
          targetWt = {
            path: potentialPath,
            name: path.basename(potentialPath),
            head: "",
            branch: "",
            is_main: potentialPath === path.resolve(cwd),
            is_bare: false,
            is_detached: false,
          };
        } else {
          const defaultWtRoot = resolveWorktreeRoot(rootDir, activeProject?.worktree_root);
          const candidate = path.join(defaultWtRoot, cleanName);
          if (fs.existsSync(candidate)) {
            targetWt = {
              path: candidate,
              name: cleanName,
              head: "",
              branch: cleanName,
              is_main: false,
              is_bare: false,
              is_detached: false,
            };
          }
        }
      }

      if (!targetWt || !fs.existsSync(targetWt.path)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Worktree "${cleanName}" not found on filesystem or in Git repository.` }],
        };
      }

      const wtPath = targetWt.path;
      const effectiveBase = (base_branch && base_branch.trim()) || activeProject?.default_base_branch || "main";

      // 1. Current Branch & HEAD
      const branchRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath, encoding: "utf8", timeout: 3000 });
      const currentBranch = branchRes.status === 0 ? branchRes.stdout.trim() : targetWt.branch;

      const headRes = spawnSync("git", ["log", "-1", "--oneline"], { cwd: wtPath, encoding: "utf8", timeout: 3000 });
      const headCommit = headRes.status === 0 ? headRes.stdout.trim() : targetWt.head;

      // 2. Dirty stats
      const dirty = getWorktreeDirtyStats(wtPath);

      // 3. Commits ahead of base
      const logRes = spawnSync("git", ["log", `${effectiveBase}..HEAD`, "--oneline"], { cwd: wtPath, encoding: "utf8", timeout: 5000 });
      const commitsAhead = logRes.status === 0 ? logRes.stdout.split(/\r?\n/).filter(Boolean) : [];

      // 4. Diff stat
      const diffStatRes = spawnSync("git", ["diff", "--stat", `${effectiveBase}...HEAD`], { cwd: wtPath, encoding: "utf8", timeout: 5000 });
      const diffStat = diffStatRes.status === 0 ? diffStatRes.stdout.trim() : "";

      // 5. Lock state & Active tasks
      const lockState = getWorktreeLockState(rootDir, targetWt.name, cwd);
      const activeTasks = findActiveTasksInWorktree(rootDir, wtPath);

      // 6. Linked PR & Plan details
      const registry = loadWorktreesRegistry(rootDir);
      const record = registry.worktrees[targetWt.name] || Object.values(registry.worktrees).find((w) => path.resolve(w.path) === path.resolve(wtPath));
      const dyn = record
        ? evaluateWorktreeDynamicStatus(rootDir, record, cwd)
        : {
            status: lockState.locked ? (lockState.lockedByTaskId ? "busy" : "locked") : "idle",
            activeTaskId: lockState.lockedByTaskId,
            activeReadTaskIds: [],
            dirty: !dirty.is_clean,
            dirtyStats: dirty,
          };

      // 7. Safety check
      const safety = checkWorktreeRemovalSafety(rootDir, targetWt.name, cwd);

      // 8. Cross-task file conflicts
      const conflictWarnings = check_conflicts ? detectWorktreeFileConflicts(wtPath, cwd, effectiveBase) : [];

      const worktreeId = record?.worktree_id || `wt_${targetWt.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      const prUrls = record?.pr_urls || (record?.pr_url ? [record.pr_url] : []);
      const prNumbers = record?.pr_numbers || [];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                worktree_id: worktreeId,
                project_id: record?.project_id || activeProject?.id,
                name: targetWt.name,
                branch: currentBranch,
                status: dyn.status,
                active_task_id: dyn.activeTaskId,
                task_history: record?.task_history || [],
                plan_ids: record?.plan_ids || [],
                pr_numbers: prNumbers,
                pr_urls: prUrls,
                pr_url: record?.pr_url || prUrls[0],
                dirty: dyn.dirty,
                worktree: {
                  name: targetWt.name,
                  path: wtPath,
                  branch: currentBranch,
                  head_commit: headCommit,
                  is_main: targetWt.is_main,
                  base_branch: effectiveBase,
                },
                git_status: {
                  is_clean: dirty.is_clean,
                  dirty_count: dirty.dirty_count,
                  staged_count: dirty.staged,
                  modified_count: dirty.modified,
                  untracked_count: dirty.untracked,
                  dirty_files: dirty.files,
                  commits_ahead_count: commitsAhead.length,
                  commits_ahead: commitsAhead.slice(0, 5),
                  diff_stat: diffStat || "(no diff against base branch)",
                },
                concurrency_and_locks: {
                  is_locked: lockState.locked,
                  lock_info: lockState.lock,
                  active_tasks: activeTasks,
                  running_task_count: activeTasks.length,
                },
                pr_and_plan: {
                  pr_url: record?.pr_url || safety.details.pr_url,
                  pr_open: safety.details.pr_open,
                  plan_id: record?.plan_id,
                  step_id: record?.step_id,
                },
                cross_task_conflicts: {
                  detected_conflicts_count: conflictWarnings.length,
                  warnings: conflictWarnings,
                },
                safety_check: {
                  can_safely_remove: safety.can_remove,
                  blockers: safety.blockers,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 3. create_worktree (P1)
  server.tool(
    "create_worktree",
    "Create an isolated Git worktree for parallel feature development without immediately dispatching an agent. Checks out or creates a feature branch from base branch and sets up directory symlinks.",
    {
      name: z.string().describe("Unique worktree name/slug (e.g. 'mobile-sidebar-safe-area')"),
      project_id: z.string().optional().describe("Optional project identifier to inherit workspace defaults"),
      repo_path: z.string().optional().describe("Optional git repository path"),
      base_branch: z.string().optional().describe("Base branch to branch off from (defaults to project default_base_branch or HEAD)"),
      lock: z.boolean().optional().describe("Whether to acquire an exclusive lock immediately upon creation (default: false)"),
      lock_reason: z.string().optional().describe("Optional reason for locking"),
      plan_id: z.string().optional().describe("Optional execution plan ID to associate with"),
      step_id: z.string().optional().describe("Optional plan step ID"),
      pr_url: z.string().optional().describe("Optional PR URL to link"),
    },
    async ({ name, project_id, repo_path, base_branch, lock = false, lock_reason, plan_id, step_id, pr_url }) => {
      audit(rootDir, { tool: "create_worktree", projectId: project_id });
      const cleanName = name.trim();
      if (!cleanName || cleanName.includes("..") || /[\s~^:?*\[\\]/.test(cleanName)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Invalid worktree name "${cleanName}". Must not contain spaces, dots, or invalid git characters.` }],
        };
      }

      const { cwd, project: activeProject } = resolveRepoAndProject(rootDir, repo_path, project_id);
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Path "${cwd}" is not a Git repository.` }],
        };
      }

      const effectiveBase = (base_branch && base_branch.trim()) || activeProject?.default_base_branch || "HEAD";

      try {
        const wtRes = setupGitWorktree({
          repoDir: cwd,
          worktreeName: cleanName,
          baseBranch: effectiveBase,
          worktreeRoot: activeProject?.worktree_root,
          symlinkDirs: activeProject?.symlink_dirs,
          bridgeRoot: rootDir,
          projectId: activeProject?.id,
          logger: (lvl, msg) => logger[lvl.toLowerCase() as "info" | "warn" | "error"](msg),
        });

        if (plan_id || step_id || pr_url) {
          upsertWorktreeRecord(rootDir, {
            name: cleanName,
            path: wtRes.worktreeDir,
            plan_id: plan_id?.trim(),
            step_id: step_id?.trim(),
            pr_url: pr_url?.trim(),
          });
        }

        let locked = false;
        if (lock) {
          const lockRes = acquireWorktreeLock(rootDir, cleanName, {
            locked: true,
            locked_by: "caller",
            reason: lock_reason || "Locked upon creation",
          });
          locked = lockRes.success;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  worktree_id: wtRes.record.worktree_id,
                  name: cleanName,
                  path: wtRes.worktreeDir,
                  branch: wtRes.branch,
                  base_branch: effectiveBase,
                  created: wtRes.created,
                  locked,
                  status: locked ? "locked" : "idle",
                  project_id: activeProject?.id,
                  repo_path: cwd,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error creating worktree: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // 4. lock_worktree (P0)
  server.tool(
    "lock_worktree",
    "Manage exclusive write locks on a Git worktree to prevent race conditions when multiple AI agents run in parallel.",
    {
      name: z.string().describe("Worktree name or directory path (e.g. 'mobile-sidebar-safe-area')"),
      action: z.enum(["lock", "unlock", "status"]).default("lock").describe("Action to perform: 'lock' (default), 'unlock', or 'status'"),
      mode: z.enum(["read_write", "read_only"]).optional().describe("Worktree task mode: 'read_write' (exclusive write lock, default) or 'read_only' (concurrent read)"),
      project_id: z.string().optional().describe("Optional project identifier"),
      repo_path: z.string().optional().describe("Optional repo path"),
      reason: z.string().optional().describe("Optional reason for locking (e.g. 'Reserved for AGY mobile sidebar refactor')"),
      task_id: z.string().optional().describe("Optional task ID to bind the lock to"),
      force: z.boolean().optional().describe("Force lock or unlock regardless of current holder or running task (default: false)"),
    },
    async ({ name, action = "lock", mode = "read_write", project_id, repo_path, reason, task_id, force = false }) => {
      audit(rootDir, { tool: "lock_worktree", projectId: project_id });
      const cleanName = name.trim();
      const { cwd } = resolveRepoAndProject(rootDir, repo_path, project_id);

      if (action === "status") {
        const state = getWorktreeLockState(rootDir, cleanName, cwd);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  name: cleanName,
                  status: state.status,
                  locked: state.locked,
                  lock_info: state.lock,
                  active_tasks: state.activeTasks,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (action === "lock") {
        const lockRes = acquireWorktreeLock(
          rootDir,
          cleanName,
          {
            locked: true,
            locked_by: task_id || "caller",
            task_id,
            reason: reason || "Explicit write lock requested",
            mode,
          },
          force
        );

        if (!lockRes.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error locking worktree: ${lockRes.error}` }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Worktree "${cleanName}" locked successfully.`,
                  lock: lockRes.lock,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (action === "unlock") {
        const unlockRes = releaseWorktreeLock(rootDir, cleanName, force, task_id);
        if (!unlockRes.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error unlocking worktree: ${unlockRes.error}` }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Worktree "${cleanName}" unlocked successfully.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `Error: Unknown action "${action}".` }],
      };
    }
  );

  // 5. remove_worktree (P1)
  server.tool(
    "remove_worktree",
    "Safely remove an idle Git worktree after verifying safety conditions (no active tasks, no uncommitted changes, no open unmerged PRs, not locked). Retains PR workspaces until merged or accepted.",
    {
      name: z.string().describe("Worktree name or directory path (e.g. 'mobile-sidebar-safe-area')"),
      project_id: z.string().optional().describe("Optional project identifier"),
      repo_path: z.string().optional().describe("Optional repo path"),
      force: z.boolean().optional().describe("Override safety checks (dirty files, open PR, lock) and force removal (default: false)"),
      delete_branch: z.boolean().optional().describe("Also delete local Git branch after worktree removal (default: false)"),
    },
    async ({ name, project_id, repo_path, force = false, delete_branch = false }) => {
      audit(rootDir, { tool: "remove_worktree", projectId: project_id });
      const cleanName = name.trim();
      const { cwd, project: activeProject } = resolveRepoAndProject(rootDir, repo_path, project_id);

      // Locate worktree
      const gitWorktrees = listGitWorktrees(cwd);
      let targetWt = gitWorktrees.find((w) => w.name === cleanName || path.resolve(w.path) === path.resolve(cleanName));
      if (!targetWt) {
        const potentialPath = path.resolve(cleanName);
        if (fs.existsSync(potentialPath)) {
          targetWt = {
            path: potentialPath,
            name: path.basename(potentialPath),
            head: "",
            branch: "",
            is_main: potentialPath === path.resolve(cwd),
            is_bare: false,
            is_detached: false,
          };
        }
      }

      if (!targetWt) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Worktree "${cleanName}" not found.` }],
        };
      }

      // Precondition safety check
      const safety = checkWorktreeRemovalSafety(rootDir, targetWt.name, cwd);
      if (!safety.can_remove && !force) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Cannot safely remove worktree "${targetWt.name}":\n` +
                safety.blockers.map((b) => `- ${b}`).join("\n") +
                `\n\nTo override these safeguards and permanently remove the workspace, pass force: true.`,
            },
          ],
        };
      }

      const branchToDelete = targetWt.branch;
      const removeRes = removeGitWorktree(
        rootDir,
        targetWt.path,
        cwd,
        (lvl, msg) => logger[lvl.toLowerCase() as "info" | "warn" | "error"](msg)
      );

      if (!removeRes.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error removing worktree directory: ${removeRes.error}` }],
        };
      }

      let branchDeleted = false;
      let branchDeleteError: string | undefined;
      if (delete_branch && branchToDelete && !targetWt.is_main) {
        const branchDelArgs = force ? ["branch", "-D", branchToDelete] : ["branch", "-d", branchToDelete];
        const delRes = spawnSync("git", branchDelArgs, { cwd, encoding: "utf8", timeout: 5000 });
        if (delRes.status === 0) {
          branchDeleted = true;
        } else {
          branchDeleteError = delRes.stderr || delRes.stdout || "Branch deletion failed";
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: `Worktree "${targetWt.name}" successfully removed.`,
                path: targetWt.path,
                branch: branchToDelete,
                branch_deleted: branchDeleted,
                ...(branchDeleteError ? { branch_delete_warning: branchDeleteError } : {}),
                forced: force,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 6. acquire_worktree_lock (P0)
  server.tool(
    "acquire_worktree_lock",
    "Acquire exclusive write lock (or shared read lock) on a Git worktree before executing tasks, preventing multiple AI agents from colliding.",
    {
      name: z.string().describe("Worktree name or path (e.g. 'mobile-sidebar-safe-area')"),
      mode: z.enum(["read_write", "read_only"]).default("read_write").describe("Lock mode: 'read_write' (exclusive writer, default) or 'read_only' (shared reader)"),
      task_id: z.string().optional().describe("Task ID holding the lock"),
      reason: z.string().optional().describe("Reason for locking"),
      force: z.boolean().optional().describe("Force acquisition even if held (default: false)"),
      project_id: z.string().optional().describe("Optional project identifier"),
      repo_path: z.string().optional().describe("Optional repo path"),
    },
    async ({ name, mode = "read_write", task_id, reason, force = false, project_id, repo_path }) => {
      audit(rootDir, { tool: "acquire_worktree_lock", projectId: project_id });
      const cleanName = name.trim();
      const lockRes = acquireWorktreeLock(
        rootDir,
        cleanName,
        {
          locked: true,
          locked_by: task_id || "caller",
          task_id,
          reason: reason || "Explicit write lock acquired",
          mode,
        },
        force
      );

      if (!lockRes.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error acquiring worktree lock: ${lockRes.error}` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: `Worktree "${cleanName}" lock acquired successfully (${mode}).`,
                lock: lockRes.lock,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 7. release_worktree_lock (P0)
  server.tool(
    "release_worktree_lock",
    "Release an acquired lock on a Git worktree so subsequent AI agents or tasks can safely proceed.",
    {
      name: z.string().describe("Worktree name or path (e.g. 'mobile-sidebar-safe-area')"),
      task_id: z.string().optional().describe("Task ID releasing the lock"),
      force: z.boolean().optional().describe("Force release even if owned by another task (default: false)"),
      project_id: z.string().optional().describe("Optional project identifier"),
      repo_path: z.string().optional().describe("Optional repo path"),
    },
    async ({ name, task_id, force = false, project_id, repo_path }) => {
      audit(rootDir, { tool: "release_worktree_lock", projectId: project_id });
      const cleanName = name.trim();
      const unlockRes = releaseWorktreeLock(rootDir, cleanName, force, task_id);
      if (!unlockRes.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error releasing worktree lock: ${unlockRes.error}` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: `Worktree "${cleanName}" lock released successfully.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 8. verify_worktree (P1)
  server.tool(
    "verify_worktree",
    "Run independent automated tests or verification commands directly inside a worktree before PR creation or merge.",
    {
      name: z.string().describe("Worktree name or directory path (e.g. 'mobile-sidebar-safe-area')"),
      project_id: z.string().optional().describe("Optional project identifier to infer verification configuration"),
      repo_path: z.string().optional().describe("Optional repo path"),
      command: z.string().optional().describe("Custom test or verification command (defaults to project.verify_pr.command or 'npm test')"),
      timeout_seconds: z.number().int().positive().optional().describe("Command execution timeout in seconds (default: 300)"),
    },
    async ({ name, project_id, repo_path, command, timeout_seconds = 300 }) => {
      audit(rootDir, { tool: "verify_worktree", projectId: project_id });
      const cleanName = name.trim();
      const { cwd, project: activeProject } = resolveRepoAndProject(rootDir, repo_path, project_id);

      // Locate worktree path
      const gitWorktrees = listGitWorktrees(cwd);
      let targetWt = gitWorktrees.find((w) => w.name === cleanName || path.resolve(w.path) === path.resolve(cleanName));
      if (!targetWt) {
        const potentialPath = path.resolve(cleanName);
        if (fs.existsSync(potentialPath)) {
          targetWt = {
            path: potentialPath,
            name: path.basename(potentialPath),
            head: "",
            branch: "",
            is_main: potentialPath === path.resolve(cwd),
            is_bare: false,
            is_detached: false,
          };
        } else {
          const defaultWtRoot = resolveWorktreeRoot(rootDir, activeProject?.worktree_root);
          const candidate = path.join(defaultWtRoot, cleanName);
          if (fs.existsSync(candidate)) {
            targetWt = {
              path: candidate,
              name: cleanName,
              head: "",
              branch: cleanName,
              is_main: false,
              is_bare: false,
              is_detached: false,
            };
          }
        }
      }

      if (!targetWt || !fs.existsSync(targetWt.path)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Worktree "${cleanName}" not found.` }],
        };
      }

      const wtPath = targetWt.path;
      const testCmd = command?.trim() || activeProject?.verify_pr?.command || "npm test";
      const startTime = Date.now();

      try {
        const execRes = spawnSync(testCmd, {
          cwd: wtPath,
          shell: true,
          encoding: "utf8",
          timeout: timeout_seconds * 1000,
          env: {
            ...process.env,
            CI: "1",
            NODE_ENV: "test",
          },
        });

        const durationMs = Date.now() - startTime;
        const exitCode = execRes.status ?? (execRes.signal ? 128 : 1);
        const success = exitCode === 0;

        return {
          isError: !success,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success,
                  worktree_name: targetWt.name,
                  worktree_path: wtPath,
                  command: testCmd,
                  exit_code: exitCode,
                  duration_ms: durationMs,
                  stdout: execRes.stdout ? execRes.stdout.slice(-10000) : "",
                  stderr: execRes.stderr ? execRes.stderr.slice(-5000) : "",
                  error: execRes.error?.message,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error executing verification in worktree "${cleanName}": ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );
}
