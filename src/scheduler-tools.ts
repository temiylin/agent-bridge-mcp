import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { resolveProject, getProjectRepoPath, ProjectDefinition } from "./project-router.js";
import {
  listGitWorktrees,
  getWorktreeDirtyStats,
  getWorktreeLockState,
  loadWorktreesRegistry,
  findActiveTasksInWorktree,
  resolveWorktreeRoot,
} from "./worktree.js";
import { readStatus, TaskStatusInfo } from "./status.js";
import { isPidAlive } from "./task-reconcile.js";
import { dispatchTaskDirect, TaskDispatchParams } from "./queue-dispatcher.js";
import { enqueueTask, loadSessionQueue, saveSessionQueue } from "./queue.js";

export interface CandidateTask {
  id?: string;
  title?: string;
  prompt: string;
  project_id?: string;
  worktree?: string | { name: string; mode?: "read_write" | "read_only"; base_branch?: string };
  worktree_mode?: "read_write" | "read_only";
  target_files?: string[];
  branch?: string;
  session_id?: string;
  after_task_id?: string;
  agent?: string;
  model?: string;
  reasoning_effort?: string;
  plan_id?: string;
  step_id?: string;
  pr_url?: string;
  timeout_seconds?: number;
  notify?: boolean;
}

export interface TaskConflict {
  type: "worktree_write_collision" | "target_file_overlap" | "branch_pr_collision" | "session_lane_collision";
  severity: "blocker" | "warning";
  tasks_involved: string[];
  resource: string;
  reason: string;
  suggested_action: "queue" | "isolate_worktree" | "run_sequential";
}

export interface ActiveTaskSnapshot {
  taskId: string;
  state: string;
  projectId?: string;
  worktreeName?: string;
  worktreeMode?: "read_write" | "read_only";
  pr_url?: string;
  branch?: string;
  session_id?: string;
  pid?: number;
  isAlive: boolean;
}

export function getRunningTasksSnapshots(rootDir: string): ActiveTaskSnapshot[] {
  const statusDir = path.join(rootDir, "status");
  if (!fs.existsSync(statusDir)) return [];
  const files = fs.readdirSync(statusDir).filter((f) => f.endsWith(".json"));
  const active: ActiveTaskSnapshot[] = [];

  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(statusDir, f), "utf8");
      const stat = JSON.parse(raw) as TaskStatusInfo;
      if (stat.state === "running" || stat.state === "queued") {
        const alive = stat.pid ? isPidAlive(stat.pid) : true;
        if (stat.state === "running" && !alive) {
          // Process died
          continue;
        }
        active.push({
          taskId: stat.taskId || f.replace(/\.json$/, ""),
          state: stat.state,
          projectId: stat.projectId,
          worktreeName: stat.worktreeName,
          worktreeMode: stat.worktreeMode || "read_write",
          pr_url: (stat.pr_url && typeof stat.pr_url === "string") ? stat.pr_url : undefined,
          session_id: stat.sessionId,
          pid: stat.pid,
          isAlive: alive,
        });
      }
    } catch {}
  }

  return active;
}

function normalizeCandidateWorktree(task: CandidateTask): { name?: string; mode: "read_write" | "read_only"; base_branch?: string } {
  if (typeof task.worktree === "string" && task.worktree.trim()) {
    return {
      name: task.worktree.trim(),
      mode: task.worktree_mode || "read_write",
    };
  }
  if (task.worktree && typeof task.worktree === "object" && task.worktree.name) {
    return {
      name: task.worktree.name.trim(),
      mode: task.worktree.mode || task.worktree_mode || "read_write",
      base_branch: task.worktree.base_branch,
    };
  }
  return {
    name: undefined,
    mode: task.worktree_mode || "read_write",
  };
}

function normalizeFilePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function doFilesOverlap(filesA?: string[], filesB?: string[]): string[] {
  if (!filesA || !filesB || filesA.length === 0 || filesB.length === 0) return [];
  const setA = new Set(filesA.map(normalizeFilePath));
  const overlapping: string[] = [];
  for (const b of filesB) {
    const normB = normalizeFilePath(b);
    if (setA.has(normB)) {
      overlapping.push(b);
    }
  }
  return overlapping;
}

export function evaluateTaskConflicts(
  rootDir: string,
  candidateTasks: CandidateTask[],
  projectId?: string,
  repoPath?: string
): {
  has_conflicts: boolean;
  can_parallelize: boolean;
  conflicts: TaskConflict[];
  parallel_groups: string[][];
  running_task_conflicts: TaskConflict[];
} {
  const conflicts: TaskConflict[] = [];
  const runningTaskConflicts: TaskConflict[] = [];
  const activeSnapshots = getRunningTasksSnapshots(rootDir);

  // 1. Check candidate tasks against running tasks
  candidateTasks.forEach((task, idx) => {
    const taskLabel = task.id || task.title || `Task #${idx + 1}`;
    const wt = normalizeCandidateWorktree(task);

    for (const act of activeSnapshots) {
      // Worktree write collision with running task
      if (wt.name && act.worktreeName && wt.name.toLowerCase() === act.worktreeName.toLowerCase()) {
        if (wt.mode === "read_write" || act.worktreeMode === "read_write") {
          const conflict: TaskConflict = {
            type: "worktree_write_collision",
            severity: "blocker",
            tasks_involved: [taskLabel, `Running Task ${act.taskId}`],
            resource: wt.name,
            reason: `Worktree "${wt.name}" is currently occupied by active task ${act.taskId} (${act.state}).`,
            suggested_action: "queue",
          };
          conflicts.push(conflict);
          runningTaskConflicts.push(conflict);
        }
      }

      // Session lane collision with running task
      if (task.session_id && act.session_id && task.session_id === act.session_id) {
        if (!task.after_task_id || task.after_task_id !== act.taskId) {
          const conflict: TaskConflict = {
            type: "session_lane_collision",
            severity: "blocker",
            tasks_involved: [taskLabel, `Running Task ${act.taskId}`],
            resource: `session:${task.session_id}`,
            reason: `Session lane "${task.session_id}" has an active running task ${act.taskId}. Concurrent execution in the same session causes context collisions.`,
            suggested_action: "queue",
          };
          conflicts.push(conflict);
          runningTaskConflicts.push(conflict);
        }
      }

      // PR collision
      if (task.pr_url && act.pr_url && task.pr_url.trim().toLowerCase() === act.pr_url.trim().toLowerCase()) {
        const conflict: TaskConflict = {
          type: "branch_pr_collision",
          severity: "warning",
          tasks_involved: [taskLabel, `Running Task ${act.taskId}`],
          resource: task.pr_url,
          reason: `Both tasks target the same Pull Request "${task.pr_url}". Parallel writes may cause git push conflicts.`,
          suggested_action: "run_sequential",
        };
        conflicts.push(conflict);
        runningTaskConflicts.push(conflict);
      }
    }
  });

  // 2. Cross-check candidate tasks against each other
  const n = candidateTasks.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const taskA = candidateTasks[i];
      const taskB = candidateTasks[j];
      const labelA = taskA.id || taskA.title || `Task #${i + 1}`;
      const labelB = taskB.id || taskB.title || `Task #${j + 1}`;

      const wtA = normalizeCandidateWorktree(taskA);
      const wtB = normalizeCandidateWorktree(taskB);

      // A. Worktree Collision
      if (wtA.name && wtB.name && wtA.name.toLowerCase() === wtB.name.toLowerCase()) {
        if (wtA.mode === "read_write" || wtB.mode === "read_write") {
          conflicts.push({
            type: "worktree_write_collision",
            severity: "blocker",
            tasks_involved: [labelA, labelB],
            resource: wtA.name,
            reason: `Both tasks target worktree "${wtA.name}" with write access. Multiple agents modifying one worktree concurrently will cause uncommitted file clobbering.`,
            suggested_action: "isolate_worktree",
          });
        }
      }

      // B. Target File Overlap
      const overlappingFiles = doFilesOverlap(taskA.target_files, taskB.target_files);
      if (overlappingFiles.length > 0) {
        conflicts.push({
          type: "target_file_overlap",
          severity: "warning",
          tasks_involved: [labelA, labelB],
          resource: overlappingFiles.join(", "),
          reason: `Tasks share overlapping target files: [${overlappingFiles.join(", ")}]. Concurrent modifications are likely to create merge conflicts.`,
          suggested_action: "run_sequential",
        });
      }

      // C. Session lane collision
      if (taskA.session_id && taskB.session_id && taskA.session_id === taskB.session_id) {
        if (taskB.after_task_id !== (taskA.id || labelA)) {
          conflicts.push({
            type: "session_lane_collision",
            severity: "blocker",
            tasks_involved: [labelA, labelB],
            resource: `session:${taskA.session_id}`,
            reason: `Tasks belong to the same session "${taskA.session_id}". They should run sequentially to preserve conversational continuity.`,
            suggested_action: "queue",
          });
        }
      }

      // D. Branch / PR collision
      if (taskA.branch && taskB.branch && taskA.branch.trim().toLowerCase() === taskB.branch.trim().toLowerCase()) {
        conflicts.push({
          type: "branch_pr_collision",
          severity: "warning",
          tasks_involved: [labelA, labelB],
          resource: `branch:${taskA.branch}`,
          reason: `Both tasks target the same git branch "${taskA.branch}". Parallel pushes will reject fast-forward.`,
          suggested_action: "run_sequential",
        });
      }
      if (taskA.pr_url && taskB.pr_url && taskA.pr_url.trim().toLowerCase() === taskB.pr_url.trim().toLowerCase()) {
        conflicts.push({
          type: "branch_pr_collision",
          severity: "warning",
          tasks_involved: [labelA, labelB],
          resource: taskA.pr_url,
          reason: `Both tasks update the same PR "${taskA.pr_url}".`,
          suggested_action: "run_sequential",
        });
      }
    }
  }

  // 3. Compute parallel groups (greedy partition)
  const parallelGroups: string[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < n; i++) {
    if (assigned.has(i)) continue;
    const currentGroup = [candidateTasks[i].id || candidateTasks[i].title || `Task #${i + 1}`];
    assigned.add(i);

    for (let j = i + 1; j < n; j++) {
      if (assigned.has(j)) continue;
      const labelJ = candidateTasks[j].id || candidateTasks[j].title || `Task #${j + 1}`;

      // Check if candidate j conflicts with any member of currentGroup
      const hasConflictWithGroup = conflicts.some((c) => {
        if (c.severity !== "blocker") return false;
        const involvesJ = c.tasks_involved.includes(labelJ);
        const involvesGroupMember = currentGroup.some((m) => c.tasks_involved.includes(m));
        return involvesJ && involvesGroupMember;
      });

      if (!hasConflictWithGroup) {
        currentGroup.push(labelJ);
        assigned.add(j);
      }
    }
    parallelGroups.push(currentGroup);
  }

  const blockerCount = conflicts.filter((c) => c.severity === "blocker").length;
  const hasConflicts = conflicts.length > 0;
  const canParallelize = blockerCount === 0 && candidateTasks.length > 1;

  return {
    has_conflicts: hasConflicts,
    can_parallelize: canParallelize,
    conflicts,
    parallel_groups: parallelGroups,
    running_task_conflicts: runningTaskConflicts,
  };
}

export function registerSchedulerTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // 1. check_task_conflicts (P0)
  server.tool(
    "check_task_conflicts",
    "Analyze candidate tasks against each other and against active running tasks for worktree write locks, target file collisions, branch/PR overlaps, and session lane conflicts before dispatching.",
    {
      tasks: z
        .array(
          z.object({
            id: z.string().optional().describe("Optional task identifier or label"),
            title: z.string().optional().describe("Task title"),
            prompt: z.string().describe("Task prompt"),
            project_id: z.string().optional().describe("Project identifier"),
            worktree: z
              .union([
                z.string(),
                z.object({
                  name: z.string(),
                  mode: z.enum(["read_write", "read_only"]).optional(),
                  base_branch: z.string().optional(),
                }),
              ])
              .optional()
              .describe("Target Git worktree name or spec"),
            worktree_mode: z.enum(["read_write", "read_only"]).optional().describe("Worktree lock mode"),
            target_files: z.array(z.string()).optional().describe("List of files or globs expected to be modified"),
            branch: z.string().optional().describe("Target Git branch"),
            session_id: z.string().optional().describe("Session lane ID"),
            after_task_id: z.string().optional().describe("Dependent task ID"),
            agent: z.string().optional().describe("Target agent"),
            model: z.string().optional().describe("Target model"),
          })
        )
        .describe("Array of candidate tasks to evaluate"),
      project_id: z.string().optional().describe("Optional default project identifier"),
      repo_path: z.string().optional().describe("Optional git repository path"),
    },
    async ({ tasks, project_id, repo_path }) => {
      audit(rootDir, { tool: "check_task_conflicts", projectId: project_id });
      const analysis = evaluateTaskConflicts(rootDir, tasks as CandidateTask[], project_id, repo_path);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                total_candidate_tasks: tasks.length,
                has_conflicts: analysis.has_conflicts,
                can_parallelize: analysis.can_parallelize,
                conflict_count: analysis.conflicts.length,
                conflicts: analysis.conflicts,
                parallel_groups: analysis.parallel_groups,
                running_tasks_analyzed: analysis.running_task_conflicts.length,
                running_task_conflicts: analysis.running_task_conflicts,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 2. schedule_tasks (P0)
  server.tool(
    "schedule_tasks",
    "Intelligently schedule and execute a batch of tasks: automatically runs non-conflicting tasks in parallel across isolated worktrees, and queues conflicting or dependent tasks with proper sequencing.",
    {
      tasks: z
        .array(
          z.object({
            title: z.string().optional().describe("Task title"),
            prompt: z.string().describe("Task prompt"),
            project_id: z.string().optional().describe("Project identifier"),
            worktree: z
              .union([
                z.string(),
                z.object({
                  name: z.string(),
                  mode: z.enum(["read_write", "read_only"]).optional(),
                  base_branch: z.string().optional(),
                }),
              ])
              .optional()
              .describe("Worktree name or spec"),
            worktree_mode: z.enum(["read_write", "read_only"]).optional().describe("Worktree mode"),
            target_files: z.array(z.string()).optional().describe("Files expected to be touched"),
            branch: z.string().optional().describe("Target branch"),
            agent: z.string().optional().describe("Agent to dispatch to"),
            model: z.string().optional().describe("Model override"),
            reasoning_effort: z.string().optional().describe("Reasoning effort"),
            session_id: z.string().optional().describe("Session lane ID"),
            after_task_id: z.string().optional().describe("Predecessor task ID"),
            plan_id: z.string().optional().describe("Execution plan ID"),
            step_id: z.string().optional().describe("Plan step ID"),
            pr_url: z.string().optional().describe("Pull Request URL"),
            timeout_seconds: z.number().int().positive().optional().describe("Execution timeout"),
            notify: z.boolean().optional().describe("Notify device"),
          })
        )
        .describe("Tasks to schedule"),
      project_id: z.string().optional().describe("Project identifier fallback"),
      auto_worktree: z.boolean().optional().describe("Auto-assign isolated worktrees if tasks lack one (default: false)"),
      max_parallel: z.number().int().positive().optional().describe("Maximum tasks to dispatch concurrently (default: 3)"),
    },
    async ({ tasks, project_id, auto_worktree = false, max_parallel = 3 }) => {
      audit(rootDir, { tool: "schedule_tasks", projectId: project_id });
      if (!tasks || tasks.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: No tasks provided to schedule." }],
        };
      }

      const candidateList: CandidateTask[] = tasks.map((t, idx) => ({
        ...t,
        id: `candidate_${idx + 1}`,
        project_id: t.project_id || project_id,
      }));

      // Evaluate conflicts
      const evalRes = evaluateTaskConflicts(rootDir, candidateList, project_id);

      const dispatched: any[] = [];
      const queued: any[] = [];
      const errors: string[] = [];

      // Determine which tasks can be dispatched immediately
      // The first parallel group (filtered against running task blocker conflicts) can run now
      const runningBlockerResources = new Set(
        evalRes.running_task_conflicts.filter((c) => c.severity === "blocker").map((c) => c.resource.toLowerCase())
      );

      const firstGroupLabels = evalRes.parallel_groups[0] || [];
      const immediateDispatchCandidates: CandidateTask[] = [];
      const queueCandidates: CandidateTask[] = [];

      candidateList.forEach((task) => {
        const label = task.id!;
        const wt = normalizeCandidateWorktree(task);
        const isBlockedByRunning =
          (wt.name && runningBlockerResources.has(wt.name.toLowerCase())) ||
          (task.session_id && runningBlockerResources.has(`session:${task.session_id}`.toLowerCase()));

        if (firstGroupLabels.includes(label) && !isBlockedByRunning && immediateDispatchCandidates.length < max_parallel) {
          immediateDispatchCandidates.push(task);
        } else {
          queueCandidates.push(task);
        }
      });

      // 1. Dispatch immediate tasks
      for (const t of immediateDispatchCandidates) {
        try {
          let wtArg: any = undefined;
          let wtName = typeof t.worktree === "string" ? t.worktree : t.worktree?.name;
          if (!wtName && auto_worktree) {
            const slug = (t.title || "worktree").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 30);
            wtName = `auto-${slug}-${Date.now().toString(36)}`;
          }

          if (wtName) {
            wtArg = {
              name: wtName,
              mode: t.worktree_mode || (typeof t.worktree === "object" ? t.worktree?.mode : undefined) || "read_write",
              base_branch: typeof t.worktree === "object" ? t.worktree?.base_branch : undefined,
            };
          }

          const res = dispatchTaskDirect(rootDir, {
            prompt: t.prompt,
            title: t.title,
            agent: t.agent,
            model: t.model,
            reasoning_effort: t.reasoning_effort,
            session_id: t.session_id,
            project_id: t.project_id || project_id,
            plan_id: t.plan_id,
            step_id: t.step_id,
            pr_url: t.pr_url,
            previous_task_id: t.after_task_id,
            timeout_seconds: t.timeout_seconds,
            worktree: wtArg,
          });

          dispatched.push({
            task_id: res.taskId,
            title: t.title,
            agent: res.agentName,
            model: res.modelParam,
            worktree: wtArg?.name,
            worktree_mode: wtArg?.mode,
          });
        } catch (err: any) {
          errors.push(`Failed to dispatch "${t.title || t.prompt.slice(0, 30)}": ${err?.message || String(err)}`);
        }
      }

      // 2. Enqueue deferred / conflicting tasks
      // Pick a predecessor taskId to link if appropriate
      const predecessorTaskId = dispatched[0]?.task_id;

      for (const q of queueCandidates) {
        try {
          const sessId = q.session_id || project_id || "default";
          const item = enqueueTask(rootDir, {
            session_id: sessId,
            after_task_id: q.after_task_id || predecessorTaskId,
            prompt: q.prompt,
            mode: "auto",
            options: {
              title: q.title,
              agent: q.agent,
              model: q.model,
              reasoning_effort: q.reasoning_effort,
              project_id: q.project_id || project_id,
              plan_id: q.plan_id,
              step_id: q.step_id,
              pr_url: q.pr_url,
              worktree: q.worktree,
              worktree_mode: q.worktree_mode,
            },
          });

          queued.push({
            queue_id: item.id,
            session_id: sessId,
            title: q.title,
            position: item.position,
            after_task_id: q.after_task_id || predecessorTaskId,
            reason: "Queued to prevent concurrent worktree or session collision",
          });
        } catch (err: any) {
          errors.push(`Failed to enqueue "${q.title || q.prompt.slice(0, 30)}": ${err?.message || String(err)}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: errors.length === 0,
                dispatched_count: dispatched.length,
                queued_count: queued.length,
                dispatched,
                queued,
                conflicts_mitigated: evalRes.conflicts.length,
                conflicts: evalRes.conflicts,
                errors: errors.length > 0 ? errors : undefined,
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
