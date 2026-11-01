import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { readStatus, writeStatus, TaskStatusInfo } from "./status.js";
import { isValidTaskId } from "./validator.js";
import { isPidAlive } from "./task-reconcile.js";
import { resolveProject, getProjectRepoPath, ProjectDefinition } from "./project-router.js";
import {
  listGitWorktrees,
  getWorktreeDirtyStats,
  getWorktreeLockState,
  loadWorktreesRegistry,
  resolveWorktreeRoot,
  releaseWorktreeLock,
} from "./worktree.js";
import { dispatchTaskDirect } from "./queue-dispatcher.js";
import { runGhCommand, resolveGhPath } from "./github-pr.js";

export interface TaskDiagnosisReport {
  task_id: string;
  health_status:
    | "healthy_running"
    | "healthy_completed"
    | "process_crashed"
    | "worker_restarted_orphan"
    | "quota_exhausted"
    | "stuck_idle"
    | "failed"
    | "not_found";
  diagnosis: string;
  process: {
    pid?: number;
    is_alive: boolean;
    worker_pid?: number;
    worker_alive: boolean;
  };
  log_analysis: {
    log_exists: boolean;
    log_size_bytes: number;
    last_log_time?: string;
    seconds_silent: number;
    recent_tail?: string;
    detected_errors: string[];
  };
  worktree_state?: {
    worktree_name?: string;
    worktree_path?: string;
    is_clean: boolean;
    dirty_count: number;
    modified_files: string[];
    diff_stat?: string;
  };
  execution_stage?: string;
  can_recover: boolean;
  recommended_action: string;
}

export function performTaskDiagnosis(rootDir: string, taskId: string): TaskDiagnosisReport {
  const stat = readStatus(rootDir, taskId);
  if (!stat) {
    return {
      task_id: taskId,
      health_status: "not_found",
      diagnosis: `No status record found for task "${taskId}".`,
      process: { is_alive: false, worker_alive: false },
      log_analysis: { log_exists: false, log_size_bytes: 0, seconds_silent: -1, detected_errors: [] },
      can_recover: false,
      recommended_action: "Check taskId or re-dispatch task.",
    };
  }

  // 1. Process Check
  let taskPidAlive = false;
  if (stat.pid && stat.pid > 0) {
    taskPidAlive = isPidAlive(stat.pid);
  }

  let workerPid: number | undefined;
  let workerAlive = false;
  try {
    const wPidStr = fs.readFileSync(path.join(rootDir, "logs", "worker.pid"), "utf8").trim();
    workerPid = Number(wPidStr);
    if (workerPid > 0) workerAlive = isPidAlive(workerPid);
  } catch {}

  // 2. Log Analysis
  const logFile = path.join(rootDir, "logs", `${taskId}.out`);
  let logExists = false;
  let logSize = 0;
  let lastLogTime: string | undefined;
  let secondsSilent = -1;
  let recentTail: string | undefined;
  const detectedErrors: string[] = [];

  if (fs.existsSync(logFile)) {
    logExists = true;
    try {
      const st = fs.statSync(logFile);
      logSize = st.size;
      lastLogTime = st.mtime.toISOString();
      secondsSilent = Math.max(0, Math.floor((Date.now() - st.mtimeMs) / 1000));

      const rawLog = fs.readFileSync(logFile, "utf8");
      const lines = rawLog.split(/\r?\n/).filter(Boolean);
      recentTail = lines.slice(-15).join("\n");

      // Error scanning
      const lower = rawLog.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("quota exceeded") || lower.includes("429")) {
        detectedErrors.push("Rate limit or quota exhaustion detected in log");
      }
      if (lower.includes("fatal: not a git repository") || lower.includes("merge conflict")) {
        detectedErrors.push("Git conflict or repository error detected in log");
      }
      if (lower.includes("command failed") || lower.includes("enoent") || lower.includes("syntaxerror")) {
        detectedErrors.push("Execution error or missing command detected in log");
      }
    } catch {}
  }

  // 3. Worktree & Dirty State
  let worktreeReport: TaskDiagnosisReport["worktree_state"] = undefined;
  let wtName = stat.worktreeName;
  let wtPath = stat.workDir;

  if (wtName && !wtPath) {
    const reg = loadWorktreesRegistry(rootDir);
    const rec = reg.worktrees[wtName];
    if (rec && fs.existsSync(rec.path)) {
      wtPath = rec.path;
    }
  }

  if (wtPath && fs.existsSync(wtPath)) {
    const dirty = getWorktreeDirtyStats(wtPath);
    let diffStat = "";
    try {
      const diffRes = spawnSync("git", ["diff", "--stat", "HEAD"], { cwd: wtPath, encoding: "utf8", timeout: 3000 });
      if (diffRes.status === 0) diffStat = diffRes.stdout.trim();
    } catch {}

    worktreeReport = {
      worktree_name: wtName,
      worktree_path: wtPath,
      is_clean: dirty.is_clean,
      dirty_count: dirty.dirty_count,
      modified_files: dirty.files.map((f) => f.path),
      diff_stat: diffStat || undefined,
    };
  }

  // 4. Health Classification
  let health: TaskDiagnosisReport["health_status"] = "healthy_running";
  let diagnosis = "";
  let canRecover = false;
  let recommendedAction = "";

  if (stat.state === "completed") {
    health = "healthy_completed";
    diagnosis = `Task completed successfully with exit code ${stat.exitCode ?? 0}.`;
    canRecover = false;
    recommendedAction = "Task is completed. Ready for review or next plan step.";
  } else if (stat.state === "paused_quota") {
    health = "quota_exhausted";
    diagnosis = "Task was paused due to AI provider account quota limits.";
    canRecover = true;
    recommendedAction = "Switch agent account via switch_agent_account or call recover_task.";
  } else if (stat.state === "running") {
    if (!taskPidAlive && stat.pid) {
      health = "process_crashed";
      diagnosis = `Task status indicates state="running", but PID ${stat.pid} is no longer alive. The process terminated unexpectedly.`;
      canRecover = true;
      recommendedAction = worktreeReport && !worktreeReport.is_clean
        ? `Task crashed but preserved ${worktreeReport.dirty_count} modified files in worktree "${wtName}". Call recover_task to resume execution from worktree.`
        : "Process crashed. Call recover_task to re-dispatch.";
    } else if (secondsSilent > 120) {
      health = "stuck_idle";
      diagnosis = `Task process PID ${stat.pid} is alive, but has produced no output for ${secondsSilent}s.`;
      canRecover = true;
      recommendedAction = "Inspect logs via read_task_output or cancel/recover task.";
    } else {
      health = "healthy_running";
      diagnosis = `Task is actively executing (PID ${stat.pid}, updated ${secondsSilent}s ago).`;
      canRecover = false;
      recommendedAction = "Task is running normally. Wait for completion.";
    }
  } else if (stat.state === "failed") {
    health = "failed";
    diagnosis = `Task failed with exit code ${stat.exitCode ?? 1}. Reason: ${stat.reason || "unknown error"}.`;
    canRecover = true;
    recommendedAction = worktreeReport && !worktreeReport.is_clean
      ? `Task failed but left ${worktreeReport.dirty_count} modified files in worktree "${wtName}". Call recover_task with resume_mode="continue_worktree" to pick up modified files.`
      : "Call recover_task with fresh_retry to re-run task.";
  }

  return {
    task_id: taskId,
    health_status: health,
    diagnosis,
    process: {
      pid: stat.pid,
      is_alive: taskPidAlive,
      worker_pid: workerPid,
      worker_alive: workerAlive,
    },
    log_analysis: {
      log_exists: logExists,
      log_size_bytes: logSize,
      last_log_time: lastLogTime,
      seconds_silent: secondsSilent,
      recent_tail: recentTail,
      detected_errors: detectedErrors,
    },
    worktree_state: worktreeReport,
    execution_stage: stat.stage,
    can_recover: canRecover,
    recommended_action: recommendedAction,
  };
}

export function registerRecoveryTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // 1. diagnose_task (P0)
  server.tool(
    "diagnose_task",
    "Deeply diagnose a task: verifies process PID liveness, worker heartbeat, log freshness, error patterns, worktree uncommitted files, and recommends safe recovery actions.",
    {
      task_id: z.string().describe("Task ID to diagnose"),
    },
    async ({ task_id }) => {
      audit(rootDir, { tool: "diagnose_task", taskId: task_id });
      if (!isValidTaskId(task_id)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Invalid task_id "${task_id}".` }],
        };
      }

      const report = performTaskDiagnosis(rootDir, task_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }
  );

  // 2. recover_task (P0)
  server.tool(
    "recover_task",
    "Safely recover an interrupted, crashed, or failed task: resumes in the same worktree without losing modified files, constructs continuity context, and dispatches a recovery task.",
    {
      task_id: z.string().describe("Task ID to recover"),
      resume_mode: z
        .enum(["continue_worktree", "fresh_retry"])
        .default("continue_worktree")
        .describe("Recovery mode: 'continue_worktree' (preserves dirty files in worktree, default) or 'fresh_retry' (cleans worktree or starts anew)"),
      additional_instructions: z.string().optional().describe("Additional guidance for the recovery agent"),
      agent: z.string().optional().describe("Agent override for recovery dispatch"),
      model: z.string().optional().describe("Model override for recovery dispatch"),
      timeout_seconds: z.number().int().positive().optional().describe("Timeout override"),
    },
    async ({ task_id, resume_mode = "continue_worktree", additional_instructions, agent, model, timeout_seconds }) => {
      audit(rootDir, { tool: "recover_task", taskId: task_id });
      if (!isValidTaskId(task_id)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Invalid task_id "${task_id}".` }],
        };
      }

      const diag = performTaskDiagnosis(rootDir, task_id);
      if (diag.health_status === "healthy_running") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Warning: Task "${task_id}" is currently actively running (PID ${diag.process.pid}). Do not recover an active task. Use cancel_task first if you wish to stop it.`,
            },
          ],
        };
      }

      // Read original task prompt & config
      const taskFile = path.join(rootDir, "tasks", `${task_id}.md`);
      let originalPrompt = "";
      if (fs.existsSync(taskFile)) {
        const rawTask = fs.readFileSync(taskFile, "utf8");
        const promptMatch = rawTask.match(/## Prompt\r?\n\r?\n([\s\S]*)$/);
        originalPrompt = promptMatch ? promptMatch[1].trim() : rawTask;
      }

      const oldStatus = readStatus(rootDir, task_id);
      const wtName = oldStatus?.worktreeName;
      const wtState = diag.worktree_state;

      // Construct continuity prompt
      let recoveryPromptPrefix = `[Task Crash Recovery Context]\n` +
        `This task recovers previously interrupted task "${task_id}".\n` +
        `Reason for recovery: ${diag.diagnosis}\n`;

      let retainedFiles: string[] = [];
      if (resume_mode === "continue_worktree" && wtState && !wtState.is_clean) {
        retainedFiles = wtState.modified_files;
        recoveryPromptPrefix += `\nExisting Worktree: "${wtName}"\n` +
          `The following ${retainedFiles.length} files were ALREADY modified by the previous task and are preserved:\n` +
          retainedFiles.map((f) => `- ${f}`).join("\n") +
          `\n\nGit diff summary against base:\n${wtState.diff_stat || "(diff stat unavailable)"}\n\n` +
          `INSTRUCTION: Please inspect git status/diff, verify the existing changes, and continue execution to complete the goal without discarding work.\n\n`;
      }

      if (additional_instructions && additional_instructions.trim()) {
        recoveryPromptPrefix += `\nAdditional Recovery Guidance:\n${additional_instructions.trim()}\n\n`;
      }

      const finalRecoveryPrompt = `${recoveryPromptPrefix}---\nOriginal Task Prompt:\n${originalPrompt}`;

      // Release any stale lock from crashed/interrupted task and mark old status terminal
      if (wtName) {
        try {
          releaseWorktreeLock(rootDir, wtName, true, task_id);
        } catch {}
      }
      if (oldStatus?.state === "running") {
        try {
          writeStatus(rootDir, task_id, {
            ...oldStatus,
            state: "failed",
            reason: `Task crashed or was interrupted. Recovered by new task.`,
          });
        } catch {}
      }

      // Dispatch recovery task
      try {
        const dispatchRes = dispatchTaskDirect(rootDir, {
          prompt: finalRecoveryPrompt,
          title: `Recovery of ${task_id}`,
          agent: agent || oldStatus?.agent,
          model: model || oldStatus?.model,
          reasoning_effort: oldStatus?.reasoningEffort,
          session_id: oldStatus?.sessionId,
          project_id: oldStatus?.projectId,
          plan_id: oldStatus?.plan_id,
          step_id: oldStatus?.step_id,
          pr_url: (oldStatus?.pr_url && typeof oldStatus.pr_url === "string") ? oldStatus.pr_url : undefined,
          previous_task_id: task_id,
          timeout_seconds: timeout_seconds || undefined,
          worktree: wtName
            ? {
                name: wtName,
                mode: "read_write",
              }
            : undefined,
        });

        // Mark old task with recovery pointer
        writeStatus(rootDir, task_id, {
          ...oldStatus,
          state: oldStatus?.state || "failed",
          recoveredByTaskId: dispatchRes.taskId,
          recoveryReason: diag.diagnosis,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  recovered_from_task_id: task_id,
                  resumed_task_id: dispatchRes.taskId,
                  worktree_retained: wtName,
                  resume_mode,
                  retained_files_count: retainedFiles.length,
                  retained_files: retainedFiles,
                  agent: dispatchRes.agentName,
                  model: dispatchRes.modelParam,
                  message: `Task ${task_id} successfully recovered as task ${dispatchRes.taskId}. Modifications preserved in worktree.`,
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
          content: [{ type: "text", text: `Error recovering task "${task_id}": ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // 3. get_handoff_context (P1)
  server.tool(
    "get_handoff_context",
    "Generate a structured handoff dossier for an AI agent taking over a project or worktree: summarizes modified files, Git diff, last task outcome, test results, and next actions.",
    {
      task_id: z.string().optional().describe("Task ID to extract handoff context from"),
      worktree_name: z.string().optional().describe("Worktree name to extract handoff context from"),
      project_id: z.string().optional().describe("Project identifier"),
      repo_path: z.string().optional().describe("Optional git repository path"),
    },
    async ({ task_id, worktree_name, project_id, repo_path }) => {
      audit(rootDir, { tool: "get_handoff_context", taskId: task_id, projectId: project_id });

      let targetTaskId = task_id?.trim();
      let targetWorktree = worktree_name?.trim();
      let targetProjectId = project_id?.trim();

      if (targetTaskId) {
        const stat = readStatus(rootDir, targetTaskId);
        if (stat) {
          if (!targetWorktree && stat.worktreeName) targetWorktree = stat.worktreeName;
          if (!targetProjectId && stat.projectId) targetProjectId = stat.projectId;
        }
      }

      let activeProject: ProjectDefinition | undefined;
      if (targetProjectId) {
        const pRes = resolveProject(rootDir, { projectId: targetProjectId });
        activeProject = pRes.project;
      }

      let cwd = "";
      if (repo_path && repo_path.trim()) {
        cwd = path.resolve(repo_path.trim());
      } else if (activeProject) {
        const pPath = getProjectRepoPath(activeProject);
        if (pPath) cwd = path.resolve(pPath);
      }
      if (!cwd) {
        cwd = path.resolve(rootDir);
      }

      // Locate worktree
      let wtPath = "";
      let currentBranch = "";
      if (targetWorktree) {
        const gitWorktrees = listGitWorktrees(cwd);
        const match = gitWorktrees.find((w) => w.name === targetWorktree || path.resolve(w.path) === path.resolve(targetWorktree));
        if (match) {
          wtPath = match.path;
          currentBranch = match.branch;
        } else {
          const wtRoot = resolveWorktreeRoot(rootDir, activeProject?.worktree_root);
          const cand = path.join(wtRoot, targetWorktree);
          if (fs.existsSync(cand)) {
            wtPath = cand;
            currentBranch = targetWorktree;
          }
        }
      }

      if (!wtPath && cwd && fs.existsSync(path.join(cwd, ".git"))) {
        wtPath = cwd;
        const bRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 3000 });
        currentBranch = bRes.status === 0 ? bRes.stdout.trim() : "main";
      }

      // Dirty files & diff
      const dirty = wtPath ? getWorktreeDirtyStats(wtPath) : { is_clean: true, dirty_count: 0, files: [] as any[] };
      let diffStat = "";
      if (wtPath) {
        try {
          const baseBranch = activeProject?.default_base_branch || "main";
          const dRes = spawnSync("git", ["diff", "--stat", `${baseBranch}...HEAD`], { cwd: wtPath, encoding: "utf8", timeout: 5000 });
          if (dRes.status === 0) diffStat = dRes.stdout.trim();
        } catch {}
      }

      // Last task info
      let lastTaskInfo: any = null;
      if (targetTaskId) {
        const stat = readStatus(rootDir, targetTaskId);
        if (stat) {
          lastTaskInfo = {
            task_id: stat.taskId,
            state: stat.state,
            agent: stat.agent,
            model: stat.model,
            stage: stat.stage,
            outcome: stat.outcome,
            summary: stat.report?.summary,
            completed_goals: stat.report?.completed_goals || [],
            unresolved_issues: stat.report?.unresolved_issues || [],
            pr_url: stat.pr_url,
          };
        }
      }

      // Generate handoff Markdown prompt block
      let handoffPromptBlock = `### AI Handoff Dossier\n` +
        (activeProject ? `- **Project**: ${activeProject.name} (${activeProject.id})\n` : "") +
        (targetWorktree ? `- **Worktree**: ${targetWorktree}\n` : "") +
        `- **Current Branch**: ${currentBranch}\n` +
        (lastTaskInfo ? `- **Preceding Task**: ${lastTaskInfo.task_id} [${lastTaskInfo.state}]\n` : "") +
        (lastTaskInfo?.summary ? `- **Previous Outcome**: ${lastTaskInfo.summary}\n` : "") +
        `- **Modified Files Count**: ${dirty.dirty_count}\n`;

      if (dirty.files.length > 0) {
        handoffPromptBlock += `- **Uncommitted Changes**:\n` +
          dirty.files.map((f: any) => `  * [${f.status}] ${f.path}`).join("\n") + "\n";
      }

      if (diffStat) {
        handoffPromptBlock += `- **Diff vs Base Branch**:\n\`\`\`\n${diffStat}\n\`\`\`\n`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                project_id: activeProject?.id,
                worktree: targetWorktree,
                branch: currentBranch,
                path: wtPath,
                dirty_files_count: dirty.dirty_count,
                modified_files: dirty.files,
                diff_stat: diffStat || "(clean or no diff)",
                preceding_task: lastTaskInfo,
                handoff_prompt_block: handoffPromptBlock,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 4. check_pr_conflicts (P1)
  server.tool(
    "check_pr_conflicts",
    "Inspect all open pull requests for a repository to detect overlapping modified files and merge collision risks before merging.",
    {
      project_id: z.string().optional().describe("Optional project identifier"),
      repo_path: z.string().optional().describe("Optional git repository path"),
      base_branch: z.string().optional().describe("Base branch to diff against (defaults to project base branch or 'main')"),
    },
    async ({ project_id, repo_path, base_branch }) => {
      audit(rootDir, { tool: "check_pr_conflicts", projectId: project_id });

      let activeProject: ProjectDefinition | undefined;
      if (project_id && project_id.trim()) {
        const pRes = resolveProject(rootDir, { projectId: project_id.trim() });
        activeProject = pRes.project;
      }

      let cwd = "";
      if (repo_path && repo_path.trim()) {
        cwd = path.resolve(repo_path.trim());
      } else if (activeProject) {
        const pPath = getProjectRepoPath(activeProject);
        if (pPath) cwd = path.resolve(pPath);
      }
      if (!cwd) cwd = path.resolve(rootDir);

      const ghPath = resolveGhPath();
      if (!ghPath) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: GitHub CLI (gh) is not installed or not in PATH." }],
        };
      }

      const prListRes = runGhCommand(
        ["pr", "list", "--state", "open", "--json", "number,title,headRefName,baseRefName,url,files"],
        cwd
      );

      if (prListRes.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching PR list: ${prListRes.stderr || prListRes.stdout}` }],
        };
      }

      let prs: any[] = [];
      try {
        prs = JSON.parse(prListRes.stdout || "[]");
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "Error parsing PR JSON output from gh CLI." }],
        };
      }

      // Map files to PRs
      const fileToPrs = new Map<string, Array<{ pr_number: number; branch: string; title: string }>>();
      prs.forEach((pr) => {
        const files: string[] = Array.isArray(pr.files) ? pr.files.map((f: any) => (typeof f === "string" ? f : f.path)) : [];
        files.forEach((file) => {
          const norm = file.toLowerCase();
          const list = fileToPrs.get(norm) || [];
          list.push({ pr_number: pr.number, branch: pr.headRefName, title: pr.title });
          fileToPrs.set(norm, list);
        });
      });

      const overlappingFiles: Array<{ file: string; pr_count: number; prs: Array<{ pr_number: number; branch: string; title: string }> }> = [];
      for (const [file, prList] of fileToPrs.entries()) {
        if (prList.length > 1) {
          overlappingFiles.push({
            file,
            pr_count: prList.length,
            prs: prList,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                project_id: activeProject?.id,
                total_open_prs: prs.length,
                has_conflicts: overlappingFiles.length > 0,
                overlapping_files_count: overlappingFiles.length,
                overlapping_files: overlappingFiles,
                open_prs: prs.map((p) => ({
                  number: p.number,
                  title: p.title,
                  branch: p.headRefName,
                  url: p.url,
                  file_count: Array.isArray(p.files) ? p.files.length : 0,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
