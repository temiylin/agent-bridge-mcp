---
name: agent-bridge
description: Directly inspect, monitor, manage PRs, and dispatch continuous pair-programming tasks to your local Mac/PC from ChatGPT.
---

# Agent Bridge Skill

When this plugin is active, you have direct, secure access to the user's local Mac/PC via the Agent Bridge MCP server (38 specialized tools).

## When to use each tool:

1. **GitHub Pull Request & Review Workflow**:
   - `pr_list`: List pull requests on GitHub. Supports filtering by `--repo` (e.g. `temiylin/vision_hub`), state (`open`, `closed`, `all`), and limit.
   - `pr_view`: Inspect PR title, body, state, labels, and review comments. Extract Codex's P0/P1/P2 audit comments and triage rework.
   - `pr_diff`: Fetch full or partial PR diff directly from GitHub without needing local checkouts.
   - `pr_checks`: Inspect GitHub Actions / CI status checks (shows total, passed, failed, and pending check runs).
   - `pr_create`: Open a new pull request on GitHub with title, markdown body, base, and head branch.
   - `pr_review`: Submit code reviews to GitHub PRs (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`) with review comments.
   - `pr_merge`: Merge PRs with fast-forward, squash, or merge commits, with optional branch deletion.

2. **Local Git Repository Operations**:
   - `repo_status`: Inspect Git status of the project, current branch, uncommitted files, or recent commits.
   - `git_diff`: Query unstaged or staged git diffs, branch diffs, or diff statistics (`stat: true`) to distinguish backend vs frontend changes.
   - `git_check_fast_forward`: Verify whether a branch or commit can be fast-forward merged into another branch via `git merge-base --is-ancestor`.
   - `git_log`: Query commit history across branch ranges (`<base>..<head>`) with hashes, authors, and commit subjects.
   - `git_fetch`: Fetch branches and tags from remotes (`github`, `origin`, or `--all`).
   - `git_push`: Push specific commits or branches to remote repositories (e.g. `<sha>:refs/heads/develop`) with `--force-with-lease` support.

3. **System & Hardware Inspection**:
   - `device_info`: Query host specs, OS version, Apple Silicon / x86 CPU, memory usage, and free disk space.
   - `check_port`: Diagnose port conflicts (e.g. 3000, 5001, 8080, 9173), check if a port is listening, and find PID & process command.

4. **Terminal Execution**:
   - `execute_command`: Execute shell commands on the user's machine (e.g. building `frontend/Vue`, running `vitest`, pytest, or restarting services). Features configurable `cwd`, `timeout_seconds`, automatic output truncation, and strict interception of destructive commands (`rm -rf /`, `mkfs`, fork bombs).

5. **Code & File Search**:
   - `search_code`: Search code or text across project files by keyword or regex pattern. Returns matching files, line numbers, and snippets.
   - `search_files`: Find files by name or glob pattern (e.g. `*.ts`, `*config*`) recursively while ignoring noise directories.

6. **Filesystem Reading, Writing & Operations**:
   - `list_directory`: Safely browse directory trees with configurable `depth` (1-5) and automatic noise filtering (`node_modules`, `.git`, `dist`).
   - `read_multiple_files`: Batch read contents of multiple files in a single round-trip.
   - `read_file`: Read specific single files or paginate through large files with offset/length limits.
   - `tail_file`: Read the tail end of large log files without loading the full file into memory.
   - `get_file_info`: Inspect file metadata, size, timestamps, and permissions.
   - `write_file`: Create or write text files directly on disk, auto-creating parent directories.
   - `edit_block`: Surgically replace a specific code block in an existing file without rewriting the whole file.
   - `move_file`: Move or rename files or directories with overwrite protection.
   - `create_directory`: Create a directory or nested directory structure safely and idempotently.

7. **Local Task Dispatch & Session Continuity**:
   - `list_models`: Discover available models on this Mac (Codex / Antigravity), active defaults, and supported reasoning effort levels.
   - `send_task`: Submit an asynchronous task to a target agent or worker daemon.
     - **Session Continuity**: Set `continue_session: true` to continue pair-programming in the previous session without starting fresh. Pass `session_id` to resume a specific thread (resumes via `codex exec resume` or `agy -p --continue`).
     - **Model & Reasoning**: Pass `model` (e.g. `gpt-6.1-sol`, `gpt-6-luna`, `o3`) and `reasoning_effort` (`low`, `medium`, `high`, `xhigh`, `max`).
     - **Smart Routing**: Omit `agent` to automatically route based on user rules configured in the Web Dashboard.
   - `read_result`: Retrieve the finished task result and markdown output.
   - `read_result_page`: Paginate through oversized result documents.
   - `get_task_status`: Non-blocking check of a task's current status (`queued`, `running`, `completed`, `failed`).
   - `read_task_output`: Stream incremental stdout/stderr logs of a running task.
   - `wait_task`: Block and wait for a dispatched task to finish with configurable timeout.
   - `cancel_task`: Safely cancel a running or queued task.
   - `worker_alive_summary`: Probe health and PID of background worker processes.
   - `list_tasks_summary`: List queued, running, and recent tasks.
   - `agent_registry_summary`: List registered subagents and their capabilities.
