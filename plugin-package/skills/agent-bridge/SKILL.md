---
name: agent-bridge
description: Directly inspect, monitor, and dispatch tasks to your local Mac/PC from ChatGPT.
---

# Agent Bridge Skill

When this plugin is active, you have direct, secure access to the user's local Mac/PC via the Agent Bridge MCP server.

## When to use each tool:

1. **System & Hardware Inspection**:
   - `device_info`: Call this when the user asks about their computer's specs, OS version, CPU architecture, memory usage, or disk free space.

2. **Git Repository Status**:
   - `repo_status`: Call this when the user asks about the Git status of the project, current branch, uncommitted files, or recent commits.

3. **Filesystem Browsing & Reading**:
   - `list_directory`: Call this when the user asks to see files/folders in a directory or explore project structure. Supports `depth: 2` or `depth: 3` to recursively explore subdirectories in a single call while automatically filtering noise folders (`node_modules`, `.git`, `dist`, etc.).
   - `read_multiple_files`: Call this when you need to read multiple files simultaneously (e.g. project overview, config files, related modules). Batching reads into a single call dramatically reduces round-trips and response latency.
   - `read_file`: Call this when the user asks to read a specific single file or paginate through large files with offset/length.
   - `get_file_info`: Call this to inspect file metadata, size, or permissions.

4. **Local Task Dispatch & AI Models**:
   - `list_models`: Call this when the user asks what models are installed or available on their Mac (Codex / Antigravity), or to inspect current default models and supported reasoning effort levels.
   - `send_task`: Call this to dispatch long-running tasks to the local background agent worker. Supports specifying `agent` ('codex', 'agy'), `model` (e.g. 'gpt-6.1-sol', 'gpt-6-luna', 'o3'), and `reasoning_effort` ('low', 'medium', 'high', 'xhigh', 'max').
   - `read_result`: Call this to check the results of a previously dispatched task.
   - `worker_alive_summary`: Call this to check if the local daemon process is healthy.
