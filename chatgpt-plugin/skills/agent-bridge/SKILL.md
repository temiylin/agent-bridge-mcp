---
name: agent-bridge
description: Safe local inspection, system hardware query, safe file reading, and task dispatching via Agent Bridge.
---

# Agent Bridge

Use this skill when the user asks to inspect system information, hardware, CPU, memory, disk usage, Git repository status, browse local directories, read local files, check background worker health, or dispatch and monitor background tasks on this Mac.

## Available Tools

The Agent Bridge MCP server provides the following tools:

### System & Repository Inspection
- `device_info`: Query host system information, architecture (`arm64`/`x86_64`), CPU model and cores, total/free memory, and disk capacity/free space. Call this tool whenever the user asks for hardware specs, Mac architecture, RAM, or disk space.
- `repo_status`: Inspect Git status, active branch, commit hash, dirty files, and unpushed commits. Takes `{ repo_path?: string, target?: "bridge" | "agent" }`.
- `worker_alive_summary`: Check health, PID, uptime, memory, and heartbeats of background worker daemons.
- `list_tasks_summary`: List queued, running, and recently completed bridge tasks.
- `agent_registry_summary`: List registered subagents and their capabilities.

### Safe Filesystem Access (Read-Only)
- `list_directory`: Safely browse directory entries. Takes `{ path: string, recursive?: boolean, max_depth?: number }`. System sensitive directories (`~/.ssh`, `~/.aws`, credentials) are strictly blocked.
- `read_file`: Safely read file content with line/byte limits. Takes `{ path: string, start_line?: number, end_line?: number, max_bytes?: number }`.
- `get_file_info`: Read file metadata (size, permissions, timestamps, MIME type). Takes `{ path: string }`.

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
- All file operations are strictly read-only and credentials are automatically filtered.
