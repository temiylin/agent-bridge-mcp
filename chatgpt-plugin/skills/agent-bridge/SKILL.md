---
name: agent-bridge
description: Safe local inspection, system hardware query, safe file reading, and task dispatching via Agent Bridge.
---

# Agent Bridge

Use this skill when the user asks to inspect system information, hardware, CPU, memory, disk usage, Git repository status, browse local directories, read local files, check background worker health, or dispatch and monitor background tasks on this Mac.

## Available Tools

The Agent Bridge MCP server provides the following tools:

### System & Repository Inspection
- `device_info`: Query host system information, architecture (`arm64`/`x86_64`), CPU model and cores, total/free memory, and disk capacity/free space.
- `check_port`: Check whether a local TCP port is in use and find the listening PID and process name.
- `repo_status`: Inspect Git status, active branch, commit hash, dirty files, and unpushed commits. Takes `{ repo_path?: string, target?: "bridge" | "agent" }`.
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

### Task Dispatching & Management
- `list_models`: Discover available AI models on this Mac (Codex / Antigravity), active defaults, and supported reasoning effort levels.
- `send_task`: Submit an asynchronous task to a target agent or worker daemon. Takes `{ prompt: string, title?: string, agent?: string, model?: string, reasoning_effort?: string }`.
- `wait_task`: Wait for a dispatched task to reach completion with timeout. Takes `{ task_id: string, timeout_seconds?: number }`.
- `get_task_status`: Non-blocking check of a task's current status and progress.
- `read_result`: Retrieve the finished task result and artifacts.
- `read_task_output`: Stream or read incremental execution logs of a running task.
- `cancel_task`: Safely cancel a running task.

## Guidelines
- Always call `device_info` when asked about Mac hardware, CPU, memory, or disk space.
- Always call `repo_status` when asked about current git branch or changes.
- Credentials and sensitive keys are strictly protected; dangerous destructive commands are intercepted automatically.
