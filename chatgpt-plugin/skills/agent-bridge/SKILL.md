---
name: agent-bridge
description: Safe local inspection, system hardware query, PR reviews, safe file reading, and task dispatching via Agent Bridge.
---

# Agent Bridge

Use this skill when the user asks to inspect system information, hardware, CPU, memory, disk usage, Git repository status, review GitHub PRs, browse local directories, read local files, check background worker health, or dispatch and monitor continuous background tasks on this Mac.

## Available Tools

The Agent Bridge MCP server provides **38 specialized tools**:

### GitHub Pull Request & Review Workflow
- `pr_list`: List pull requests on GitHub. Filter by `--repo` (e.g. `temiylin/vision_hub`), state (`open`, `closed`, `all`), and limit.
- `pr_view`: Inspect PR title, body, status, labels, and review comments. Extract Codex's P0/P1/P2 comments for rework.
- `pr_diff`: Fetch full or partial PR diff directly from GitHub without needing local checkouts.
- `pr_checks`: Inspect GitHub Actions / CI status checks (breakdown of total, passed, failed, and pending).
- `pr_create`: Open a new pull request on GitHub with title, markdown body, base branch, and head branch.
- `pr_review`: Submit code reviews to GitHub PRs (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`) with comments.
- `pr_merge`: Merge PRs with fast-forward, squash, or merge commits, with optional branch deletion.

### Local Git Repository Operations
- `repo_status`: Inspect Git status, active branch, commit hash, dirty files, and unpushed commits. Takes `{ repo_path?: string, target?: "bridge" | "agent" }`.
- `git_diff`: Query unstaged or staged git diffs, branch diffs, or diff statistics (`stat: true`) to distinguish backend vs frontend changes.
- `git_check_fast_forward`: Verify whether a branch or commit can be fast-forward merged into another branch via `git merge-base --is-ancestor`.
- `git_log`: Query commit history across branch ranges (`<base>..<head>`) with hashes, authors, and commit subjects.
- `git_fetch`: Fetch branches and tags from remotes (`github`, `origin`, or `--all`).
- `git_push`: Push specific commits or branches to remote repositories (e.g. `<sha>:refs/heads/develop`) with `--force-with-lease` support.

### System & Hardware Inspection
- `device_info`: Query host system information, architecture (`arm64`/`x86_64`), CPU model and cores, total/free memory, and disk capacity/free space.
- `check_port`: Check whether a local TCP port is in use and find the listening PID and process name.
- `worker_alive_summary`: Check health, PID, uptime, memory, and heartbeats of background worker daemons.
- `list_tasks_summary`: List queued, running, and recently completed bridge tasks.
- `agent_registry_summary`: List registered subagents and their capabilities.

### Code Search & Filesystem Operations
- `search_code`: Fast keyword and regex search across project files. Returns matching lines and context.
- `search_files`: Search files by name or glob pattern (e.g. `*.ts`, `*config*`) recursively.
- `list_directory`: Safely browse directory entries. Takes `{ path: string, depth?: number, show_hidden?: boolean, ignore_patterns?: string[] }`. Supports `depth: 2` or `depth: 3` to recursively explore subdirectories in a single call while automatically filtering noise folders (`node_modules`, `.git`, `dist`, etc.).
- `read_multiple_files`: Batch read contents of multiple files in a single call. Takes `{ paths: string[], max_bytes_per_file?: number }`.
- `read_file`: Safely read single file content with offset and length limits. Takes `{ path: string, offset?: number, length?: number }`.
- `tail_file`: Read recent tail lines or bytes of a log or file without loading entire file. Takes `{ path: string, lines?: number, max_bytes?: number }`.
- `get_file_info`: Read file metadata (size, permissions, timestamps). Takes `{ path: string }`.
- `write_file`: Directly write text content to a local file path, automatically creating parent directories.
- `edit_block`: Surgically replace a specific code block in an existing file without rewriting the entire file.
- `move_file`: Move or rename a file or directory across paths. Takes `{ source: string, destination: string, overwrite?: boolean }`.
- `create_directory`: Create a new directory or nested folder hierarchy. Takes `{ path: string }`.

### Terminal Execution
- `execute_command`: Directly execute shell commands with configurable working directory, execution timeout, standard I/O truncation, and dangerous command protection. Takes `{ command: string, cwd?: string, timeout_seconds?: number, env_vars?: Record<string, string> }`.

### Task Dispatching & Multi-Turn Session Continuity
- `list_models`: Discover available AI models on this Mac (Codex / Antigravity), active defaults, and supported reasoning effort levels.
- `send_task`: Submit an asynchronous task to a target agent or worker daemon.
  - Set `continue_session: true` to continue pair-programming in the previous session without starting fresh.
  - Pass `session_id` to resume a specific thread (resumes via `codex exec resume` or `agy -p --continue`).
  - Supports smart routing: automatically routes based on user rules when `agent` is omitted.
  - Takes `{ prompt: string, title?: string, agent?: string, model?: string, reasoning_effort?: string, continue_session?: boolean, session_id?: string }`.
- `wait_task`: Wait for a dispatched task to reach completion with timeout. Takes `{ task_id: string, timeout_seconds?: number }`.
- `get_task_status`: Non-blocking check of a task's current status and progress.
- `read_result`: Retrieve the finished task result and artifacts.
- `read_result_page`: Paginate through oversized result documents.
- `read_task_output`: Stream or read incremental execution logs of a running task.
- `cancel_task`: Safely cancel a running task.

## Guidelines
- Always call `device_info` when asked about Mac hardware, CPU, memory, or disk space.
- Always call `repo_status` when asked about current git branch or changes.
- Use `pr_view` and `pr_diff` for code reviews and audit comments before merging.
- Use `git_check_fast_forward` before merging into target branches.
- Credentials and sensitive keys are strictly protected; dangerous destructive commands are intercepted automatically.
