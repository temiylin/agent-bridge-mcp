import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Standard instructions injected during MCP initialization (InitializeResult.instructions).
 * Clients (ChatGPT, Claude, Codex, Cursor, Antigravity) automatically inject these instructions
 * into the AI model's context upon connection.
 */
export const SERVER_INSTRUCTIONS = `Agent Bridge MCP connects conversational AI to local development environments with strict safety sandboxing and zero open ports.

Core Capabilities & Calling Guidelines:

1. Project-Aware Tasks (projects.json & project_id):
   - Check registered projects via list_projects.
   - When dispatching tasks via send_task or enqueue_task, pass project_id to inherit workspace repo_path, default_base_branch, push_remote, forbidden_remotes, default_agent/model, timeout, and callbacks.
   - If a task references a plan_id that is already bound to a project, project_id is inherited automatically without passing it again.
   - Requirements can be saved with project_id (save_requirement), and dispatching a requirement (dispatch_requirement) automatically propagates project_id to the created task, and can directly target plan_id and step_id.
   - git_push and merge_and_deploy strictly enforce forbidden_remotes against resolved push URLs to prevent pushing to forbidden remotes.

2. Multi-Step Execution Plans (feat/plans):
   - For multi-phase or complex work, create a plan via create_plan({ title, context, steps: [...] }).
   - Dispatch tasks referencing plan_id and step_id. The server automatically injects the plan title, context summary (truncated with file path note if >4000 chars), and step details into the prompt.
   - The dispatched step is marked in_progress. When the task completes, the worker automatically writes back success (done) or failure (failed) to the plan step (preserving skipped).
   - Track progress via get_plan or list_plans, and visualize in the Web Console Plan Drawer.

3. Task Stages & Structured Reporting ($TASK_DIR/report.json):
   - Tasks progress through 8 unified stages evaluated in priority order:
     needs_human/failed > needs_human/quota > needs_human/stalled > needs_human/answer > needs_human/review > queued > working > done.
   - Dispatched agents must write a summary to $TASK_DIR/report.json before exiting:
     {"outcome":"ready|blocked|failed|dropped","pr_url":string|null,"question":string|null,"summary":string(<=500 chars)}
   - When report.json is missing/invalid, heuristic fallback extracts outcomes.
   - Inspect stage via get_task_status or list_tasks_summary to determine required human actions.

4. Account Pool & agy-sdk:
   - Native agy-sdk stream-json runner enables direct NDJSON processing without Python wrappers.
   - Pool profiles (~/agent-bridge/agy-profiles/<alias>) provide complete account isolation with Cockpit quota tracking.

5. PR Linkage & Workflow Integration:
   - Pass pr_url to send_task or enqueue_task to associate an existing PR with a task upfront (automatically reflected in plan steps).
   - Pass task_id to pr_create to automatically attach newly opened PRs to the corresponding task.
   - Call attach_pr_to_task({ task_id, pr_url }) anytime to link PRs to existing tasks and execution plan steps.

6. High-Leverage Developer Intelligence & Workflows:
   - Call project_summary({ project_id }) for an instant 360° snapshot of working tree cleanliness, active plan progress, draft requirements, and running tasks in a single turn.
   - Query branch topology via git_branches and safely fork feature branches via git_create_branch.
   - Pass previous_task_id to send_task or enqueue_task to chain tasks across agents or steps without context loss.

7. Multi-AI Worktree Management & Concurrency Locks:
   - Worktrees are first-class reusable environments associated with projects, plans, tasks, and PRs.
   - Call list_worktrees and worktree_status to monitor working directory dirty stats, locks, commits ahead, and PR links.
   - acquire_worktree_lock / release_worktree_lock enforces single-writer / multi-reader safety with automatic crash recovery (dead task locks auto-cleared).
   - remove_worktree strictly prevents deleting worktrees with dirty files, open PRs, or running tasks unless force: true.
   - verify_worktree runs isolated test suites inside worktrees prior to PR creation.

8. Intelligent Scheduling & Crash Recovery:
   - Call check_task_conflicts to detect worktree write collisions, overlapping target files, PR conflicts, and session collisions.
   - Call schedule_tasks to automatically parallelize non-conflicting tasks across isolated worktrees and queue conflicting ones.
   - diagnose_task performs 360° health checks (PID alive, worker alive, log freshness, uncommitted diffs).
   - recover_task safely resumes interrupted/crashed tasks in the same worktree without losing modified files.
   - get_handoff_context extracts full handoff dossiers for seamless AI takeovers.

9. Call help({ topic }) at any time for detailed syntax, workflows, and parameter recipes.`;

export const HELP_TOPICS = [
  "overview",
  "projects",
  "plans",
  "stages",
  "tasks",
  "pool",
  "git",
  "worktrees",
  "scheduler",
  "recovery",
  "all",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export function getHelpContent(topic?: string): string {
  const norm = (topic || "overview").toLowerCase().trim();

  switch (norm) {
    case "projects":
      return `### Project Configuration Management (\`projects.json\`)

Projects allow callers to dispatch tasks without repeating repository paths, branch rules, remote targets, and callback configurations.

#### Key MCP Tools:
- \`project_summary\`: Unified 360° overview of project Git status, active execution plans, draft requirements, and active/recent tasks in 1 turn.
- \`add_project\`: Register a project. Validates that \`repo_path\` exists and is a valid Git repository.
- \`list_projects\`: List registered projects, paths, and status.
- \`update_project\`: Modify project fields.
- \`remove_project\`: Safely remove a project (refused if tasks are currently running or queued).
- \`list_project_tasks\`: List tasks associated with a project.

#### Inherited Defaults when passing \`project_id\`:
When \`project_id\` is passed to \`send_task\` or \`enqueue_task\`, the task inherits:
- \`repo_path\`: Repository root on local machine.
- \`default_base_branch\`: Git base branch (e.g. \`develop\`).
- \`push_remote\`: Allowed remote for Git push (e.g. \`github\`).
- \`forbidden_remotes\`: Disallowed remote URLs (e.g. \`["gitee.com"]\`).
- \`default_agent\` & \`default_model\`: Preferred agent executable and model.
- \`default_timeout_seconds\`: Soft overdue and hard kill limits.
- \`callback_url\` & \`callback_headers\`: Webhook completion callbacks.

*Tip*: If a task or queue item references a \`plan_id\` that is associated with a \`project_id\`, \`project_id\` and all its settings are inherited automatically. Likewise, \`dispatch_requirement\` automatically forwards the requirement's \`project_id\` to the task.

#### Security Guardrails:
1. **URL-based \`forbidden_remotes\`**: \`git_push\` and \`merge_and_deploy\` resolve the target remote's push URL (\`git remote get-url --push <remote>\`) and match against host/path rules (e.g., matching \`gitee.com\` or \`ssh://git@gitee.com/...\`). Pushes to forbidden remotes are strictly blocked.
2. **Environment Variable Whitelist in \`callback_headers\`**: Callback headers only accept environment variables matching \`^AGENT_BRIDGE_CB_[A-Z0-9_]+$\` or explicitly listed in \`allowed_env\`. References like \`"Bearer $AGENT_BRIDGE_CB_TOKEN"\` are resolved safely. System variables (\`HOME\`, \`PATH\`, \`GITHUB_TOKEN\`) and raw secrets are rejected.`;

    case "plans":
      return `### Multi-Step Execution Plans (\`feat/plans\`)

Execution plans orchestrate complex, multi-stage engineering tasks (e.g. architectural migrations, multi-module feature development) across multiple agent turns.

#### Plan Schema & Storage:
- Saved under \`~/agent-bridge/plans/<plan_id>.json\`.
- Atomic writes with \`.bak\` backup on corrupt detection and \`O_EXCL\` file locks (\`<plan_id>.lock\`).
- Structure:
  \`\`\`json
  {
    "id": "refactor-auth-v2",
    "project_id": "core-backend",
    "title": "Refactor Authentication Architecture",
    "context": "# Background and Migration Steps...",
    "version": 1,
    "steps": [
      {
        "id": "step-1-schema",
        "title": "Define User Model Schema",
        "detail": "Update schema.prisma and migrations",
        "status": "todo",
        "task_ids": [],
        "pr_urls": []
      }
    ]
  }
  \`\`\`

#### Key MCP Tools:
- \`create_plan\`: Create a new structured plan with steps.
- \`get_plan\`: Inspect full plan details, step statuses, linked task IDs, and PR URLs.
- \`update_plan\`: Update context and step descriptions (increments \`version\`).
- \`list_plans\`: List plan summaries (supports filtering by \`project_id\`).
- \`set_plan_step_status\`: Manually update a step's status (\`todo\`, \`in_progress\`, \`done\`, \`failed\`, \`skipped\`).
- \`archive_plan\`: Archive completed/obsolete plans (strictly blocked if linked tasks are active).

#### Workflow Integration:
1. **Dispatching with Plan**: Pass \`plan_id\` and \`step_id\` to \`send_task\` or \`enqueue_task\`.
2. **Prompt Context Injection**: The server automatically injects plan title, context summary (truncated with file path note if >4000 chars), and current step detail before the prompt.
3. **Execution Tracking**: The step is marked \`in_progress\` and freezes \`plan_version\`.
4. **Automatic Writeback**: When the agent finishes, the worker appends \`task_id\` and \`pr_url\` to the step, and updates status to \`done\` (success) or \`failed\` (failure). If the step was manually marked \`skipped\`, it is preserved.`;

    case "stages":
      return `### Unified Task Stages & Structured Reporting

Agent Bridge derives a unified \`stage\` for every task to give callers and human operators an instant, unambiguous signal on what is happening and what action is required.

#### 8-Stage Priority Hierarchy (First Match Wins):
1. \`needs_human/failed\`: Task failed or hard-timed out, and no subsequent continuation input has been dispatched. Action: Retry or provide new instructions.
2. \`needs_human/quota\`: Task paused due to API quota exhaustion (\`paused_quota\`). Action: Switch account or wait for quota reset.
3. \`needs_human/stalled\`: Suspected stalled (\`suspected_stalled\`) after exceeding inactivity thresholds with no event progress. Action: Inspect or cancel.
4. \`needs_human/answer\`: Agent reported a blocking question (\`report.question\` is non-empty). Action: Human must answer the question.
5. \`needs_human/review\`: Code is ready and an associated PR is currently open (\`outcome === "ready"\` with open PR). Action: Human review and merge PR.
6. \`queued\`: Task is queued or paused in session queue.
7. \`working\`: Task is actively executing (\`running\`).
8. \`done\`: Task finished cleanly (or was dropped/cancelled).

#### Structured Agent Report (\`$TASK_DIR/report.json\`):
Agents are instructed in their prompt to output a report before terminating:
\`\`\`json
{
  "outcome": "ready|blocked|failed|dropped",
  "pr_url": "https://github.com/org/repo/pull/123",
  "question": null,
  "summary": "Implemented schema migrations and unit tests pass (max 500 chars)"
}
\`\`\`
- Worker strictly parses and validates \`report.json\` (\`report_source: "report_json"\`).
- If missing or invalid, worker falls back to heuristic regex extraction (\`report_source: "heuristic"\`).

#### Web Console Action-Oriented Home:
The web dashboard (\`http://localhost:38080\`) features 3 focused sections:
- **待处理**: Displays all \`needs_human/*\` tasks with quick action buttons (Open PR, Retry, Resume Queue, View Question).
- **系统问题**: Displays critical issues (consecutive failures >= 3); completely hidden when healthy.
- **执行中**: Displays current \`working\` and \`queued\` tasks.`;

    case "tasks":
      return `### Task Dispatching, Queue & Session Continuity

#### Dispatching Tasks:
- \`send_task\`: Dispatch immediate task.
  - \`prompt\`: Prompt text.
  - \`project_id\`: Optional project ID to inherit configurations.
  - \`plan_id\` & \`step_id\`: Optional execution plan linkage.
  - \`previous_task_id\`: Optional previous task ID to inherit context from (summary, outcome, PR URL, project linkage).
  - \`session_id\`: Named conversation lane for multi-turn continuity (e.g. \`"auth_refactor"\`).
  - \`continue_session\`: Set to \`true\` to resume the agent's prior conversational context.
  - \`notify\`: Boolean or object configuring desktop notifications.
  - \`notify.timeout_seconds\`: Soft overdue alert threshold (does not kill process).
  - \`timeout_seconds\`: Hard timeout threshold (sends SIGTERM/SIGKILL).

#### Multi-Agent Task Chaining:
- Pass \`previous_task_id\` in \`send_task\` or \`enqueue_task\` to automatically inherit:
  - Previous task outcome, summary, and blocking question as prompt context prefix.
  - Associated PR URL and project binding without manually copying them.

#### Auto Task Queue (\`enqueue_task\`):
- Queues tasks behind in-flight sessions.
- \`list_queue\`: List queued tasks with positions and status.
- \`reorder_queue\`: Reorder queue positions.
- \`pause_queue\` / \`resume_queue\`: Temporarily hold or resume automatic dispatching.
- \`update_queue_item\` / \`cancel_queue_item\`: Surgically edit or cancel queued items.

#### Task Cancellation:
- \`cancel_task({ task_id })\`: Signals cancellation immediately (\`state: "cancelled"\`), sends SIGTERM to the process tree, escalating to SIGKILL after 2s grace period. Emits terminal callback without duplicate noise.`;

    case "pool":
      return `### agy Multi-Account Pool & Cockpit Tools

Manages multiple isolated Antigravity (\`agy\`) CLI accounts concurrently on a single machine.

#### Profile Architecture:
- Each profile resides under \`~/agent-bridge/agy-profiles/<alias>/\`.
- Non-secret configurations (\`~/.gitconfig\`, \`~/.ssh\`, \`~/.config/gh\`) are symlinked.
- OAuth tokens and credentials are NEVER copied across profiles or exposed via MCP.
- Strict one-account-one-directory invariant.

#### MCP Tools:
- \`pool_status\`: View account profiles, in-flight task counts, and Cockpit quota fractions.
- \`pool_init_profile\`: Initialize isolated directory with safe symlinks and print login command:
  \`HOME=~/agent-bridge/agy-profiles/<alias> agy\`
- \`pool_pause\` / \`pool_resume\`: Pause or resume a profile from task routing.
- \`pool_bind_email\`: Bind profile to Cockpit email for quota tracking.
- \`pool_sync_auth\`: Sync safe non-secret configuration updates.
- \`pool_remove_profile\`: Safely remove an idle profile directory.
- \`resume_after_account_switch\`: Resume a quota-paused task on a ready profile.`;

    case "git":
      return `### Git Operations & GitHub PR Lifecycle

#### Git Tools:
- \`repo_status\`: Read-only Git branch, unstaged/staged file status, and recent commits.
- \`git_branches\`: List local and remote branches with current HEAD indicator and tracking upstreams.
- \`git_create_branch\`: Safely create and checkout a new feature branch from verified base branch.
- \`git_diff\`: Compare working tree or branch diffs (\`--stat\` supported).
- \`git_check_fast_forward\`: Verify whether incoming branch can be fast-forward merged.
- \`git_log\`: Query commit history across branch ranges (\`<base>..<head>\`).
- \`git_fetch\`: Safely fetch commits and remote branch references.
- \`git_push\`: Push branch/commits (strictly guarded by project \`forbidden_remotes\` URLs and refspec safety).

#### GitHub PR Tools (via host \`gh\` CLI):
- \`pr_list\`: List open/closed PRs.
- \`pr_view\`: Inspect PR title, body, and Codex P0/P1/P2 review comments.
- \`pr_diff\`: Inspect PR patch diff.
- \`pr_checks\`: View CI / GitHub Actions checks.
- \`pr_create\`: Create a new pull request.
- \`pr_review\`: Post review comments (\`COMMENT\`, \`APPROVE\`, \`REQUEST_CHANGES\`).
- \`pr_merge\`: Merge PR (fast-forward, merge commit, or squash).
- \`verify_pr\`: Run automated test commands configured in project settings.
- \`merge_and_deploy\`: Merge PR branch to target, push remote, and restart configured services.`;

    case "worktrees":
      return `### Git Worktree Lifecycle & Concurrency Locks

Worktrees are first-class, reusable engineering environments tied to projects, plans, tasks, and PRs.

#### Key MCP Tools:
- \`list_worktrees\`: List all project worktrees with metadata: branch names, dirty state, active task, associated PRs, and removal safety.
- \`worktree_status\`: Comprehensive inspection: uncommitted files, commits ahead of base branch, diff stats, locks, and cross-task file conflict warnings.
- \`create_worktree\`: Create an isolated worktree branch and symlink directories without immediately dispatching an agent.
- \`lock_worktree\`: Manage write/read locks on a worktree (\`action: "lock" | "unlock" | "status"\`).
- \`acquire_worktree_lock\`: Acquire exclusive writer lock (or shared reader lock).
- \`release_worktree_lock\`: Release an acquired lock.
- \`remove_worktree\`: Safely removes idle worktrees after verifying safety preconditions (no uncommitted files, no open PRs, no running tasks). Override with \`force: true\`.
- \`verify_worktree\`: Run tests or lint directly inside a worktree before creating a PR.

#### Crash Recovery & Lock Safety:
Locks are dynamically verified against actual process PIDs (\`isPidAlive\`) and status files. If a worker process crashes, stale locks are automatically recovered.`;

    case "scheduler":
      return `### Intelligent Task Scheduling & Conflict Detection

The scheduler analyzes tasks for concurrency conflicts, allowing safe parallel execution across multiple agents while preventing file collisions.

#### Key MCP Tools:
- \`check_task_conflicts\`: Compares candidate tasks against each other and active running tasks for:
  1. Worktree write collisions (two tasks modifying the same worktree)
  2. Target file overlaps (overlapping modified file sets or globs)
  3. Git branch and PR collisions
  4. Session lane collisions (tasks sharing the same session without sequencing)
  Returns \`can_parallelize\`, detected conflict details, and optimal \`parallel_groups\`.
- \`schedule_tasks\`: Automatically schedules a batch of tasks: dispatches non-conflicting tasks in parallel across isolated worktrees, and queues conflicting or dependent tasks with proper sequencing.`;

    case "recovery":
      return `### Task Health Diagnosis & Crash Recovery

Tools for diagnosing process health, analyzing logs, and recovering interrupted tasks without losing worktree progress.

#### Key MCP Tools:
- \`diagnose_task\`: Deep 360° health diagnosis: checks process PID liveness, worker heartbeat, log freshness, error patterns (quota, git, runtime), uncommitted files in worktree, and execution stages. Classifies health into \`healthy_running\`, \`healthy_completed\`, \`process_crashed\`, \`worker_restarted_orphan\`, \`quota_exhausted\`, \`stuck_idle\`, or \`failed\`.
- \`recover_task\`: Resumes an interrupted or crashed task inside the same worktree: summarizes existing modified files, diff stats, and instructions into a continuity prompt, and dispatches a resumption task without discarding work.
- \`get_handoff_context\`: Generates a structured handoff dossier summarizing modified files, git status, test results, and next actions for seamless AI takeovers.
- \`check_pr_conflicts\`: Scans open Pull Requests across the repository to flag overlapping modified files and potential merge collisions.`;

    case "all":
      return [
        getHelpContent("overview"),
        getHelpContent("projects"),
        getHelpContent("plans"),
        getHelpContent("stages"),
        getHelpContent("tasks"),
        getHelpContent("pool"),
        getHelpContent("git"),
        getHelpContent("worktrees"),
        getHelpContent("scheduler"),
        getHelpContent("recovery"),
      ].join("\n\n---\n\n");

    case "overview":
    default:
      return `## Agent Bridge MCP — Feature Guide & Overview

Agent Bridge connects conversational AI (ChatGPT, Codex, Claude, Gemini/Antigravity) safely to your local development environment with zero open ports and strict sandbox guardrails.

### Quick Topic Navigation
Call \`help({ topic: "<topic>" })\` for in-depth documentation:
- \`help({ topic: "projects" })\`: Project configurations (\`projects.json\`), \`project_id\` inheritance, and URL-based \`forbidden_remotes\` guardrails.
- \`help({ topic: "plans" })\`: Multi-step execution plans (\`feat/plans\`), step tracking, prompt context injection, and completion writebacks.
- \`help({ topic: "stages" })\`: 8-level unified task stages (\`needs_human/*\`), \`$TASK_DIR/report.json\` schema, and action console.
- \`help({ topic: "tasks" })\`: Task dispatching, session continuity (\`session_id\`), timeouts, queue sequencing, and cancellation.
- \`help({ topic: "pool" })\`: agy multi-account pool, isolated profiles, and Cockpit quota tracking.
- \`help({ topic: "git" })\`: Git operations, GitHub PR lifecycle (\`pr_*\`), automated verification, and deploy.
- \`help({ topic: "worktrees" })\`: Git worktree lifecycle, concurrency locks, dynamic crash recovery, and verification.
- \`help({ topic: "scheduler" })\`: Multi-task conflict detection, worktree write collision mitigation, and intelligent batch scheduling.
- \`help({ topic: "recovery" })\`: Task health diagnosis, crash recovery with worktree diff preservation, and AI handoff context.
- \`help({ topic: "all" })\`: Full comprehensive manual.

### Core Tool Categories (102 Dedicated Tools)
1. **Telemetry & System**: \`device_info\`, \`check_port\`, \`worker_alive_summary\`, \`self_check\`, \`notify_device\`.
2. **Plans**: \`create_plan\`, \`get_plan\`, \`update_plan\`, \`list_plans\`, \`set_plan_step_status\`, \`archive_plan\`.
3. **Projects**: \`add_project\`, \`list_projects\`, \`update_project\`, \`remove_project\`, \`list_project_tasks\`, \`project_summary\`.
4. **Agent Dispatch & Lifecycle**: \`send_task\`, \`read_result\`, \`read_result_page\`, \`read_task_output\`, \`get_task_status\`, \`wait_task\`, \`cancel_task\`, \`list_tasks_summary\`, \`list_recent_tasks\`, \`dashboard\`, \`agent_registry_summary\`, \`list_models\`.
5. **Worktrees & Concurrency Locks**: \`list_worktrees\`, \`worktree_status\`, \`create_worktree\`, \`lock_worktree\`, \`acquire_worktree_lock\`, \`release_worktree_lock\`, \`remove_worktree\`, \`verify_worktree\`.
6. **Task Scheduler & Recovery**: \`check_task_conflicts\`, \`schedule_tasks\`, \`diagnose_task\`, \`recover_task\`, \`get_handoff_context\`, \`check_pr_conflicts\`.
7. **Task Queue & Backlog**: \`save_requirement\`, \`list_requirements\`, \`get_requirement\`, \`update_requirement\`, \`merge_requirements\`, \`archive_requirement\`, \`delete_requirement\`, \`dispatch_requirement\`, \`enqueue_task\`, \`list_queue\`, \`reorder_queue\`, \`update_queue_item\`, \`cancel_queue_item\`, \`pause_queue\`, \`resume_queue\`.
8. **Git & GitHub PR**: \`repo_status\`, \`git_branches\`, \`git_create_branch\`, \`git_diff\`, \`git_check_fast_forward\`, \`git_log\`, \`git_fetch\`, \`git_push\`, \`verify_pr\`, \`merge_and_deploy\`, \`pr_list\`, \`pr_view\`, \`pr_diff\`, \`pr_checks\`, \`pr_create\`, \`pr_review\`, \`pr_merge\`, \`attach_pr_to_task\`.
9. **Filesystem & Code Editing**: \`list_directory\`, \`read_file\`, \`read_multiple_files\`, \`write_file\`, \`edit_block\`, \`search_files\`, \`search_code\`, \`tail_file\`, \`move_file\`, \`create_directory\`, \`get_file_info\`, \`inspect_project_directories\`, \`execute_command\`.
10. **Account Pool & Integrations**: \`pool_status\`, \`pool_init_profile\`, \`pool_pause\`, \`pool_resume\`, \`pool_bind_email\`, \`pool_sync_auth\`, \`pool_remove_profile\`, \`pool_set_custom_enabled\`, \`resume_after_account_switch\`, \`auto_resume_on_account_ready\`, \`list_agent_accounts\`, \`switch_agent_account\`, \`set_task_webhook\`, \`clear_task_webhook\`, \`restart_service\`, \`slack_post\`.
11. **Documentation**: \`help\`.

### Local Web Dashboard
Visit \`http://localhost:38080\` (or run \`npm run dashboard\`) for the action-oriented control console.`;
  }
}

export function registerHelpTool(server: McpServer): void {
  server.tool(
    "help",
    "Get detailed help, documentation, best practices, and recipes for Agent Bridge MCP features (projects, plans, task stages, queue, account pool, git operations).",
    {
      topic: z
        .enum(HELP_TOPICS)
        .optional()
        .describe(
          "Specific topic to query: 'overview' (default), 'projects', 'plans', 'stages', 'tasks', 'pool', 'git', or 'all' for complete documentation."
        ),
    },
    async ({ topic }) => {
      const content = getHelpContent(topic);
      return {
        content: [
          {
            type: "text",
            text: content,
          },
        ],
      };
    }
  );
}
