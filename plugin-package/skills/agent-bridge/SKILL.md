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
   - `list_directory`: Call this when the user asks to see files/folders in a directory.
   - `read_file`: Call this when the user asks to read a specific file, config, or code snippet.
   - `get_file_info`: Call this to inspect file metadata, size, or permissions.

4. **Local Task Dispatch**:
   - `send_task`: Call this to dispatch long-running tasks to the local background agent worker.
   - `read_result`: Call this to check the results of a previously dispatched task.
   - `worker_alive_summary`: Call this to check if the local daemon process is healthy.
