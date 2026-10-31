# Agent Bridge MCP
### Safely connect ChatGPT, Codex, and Claude to your local environment with zero open ports

[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-blue.svg)](https://modelcontextprotocol.io/)
[![Agent Plugins](https://img.shields.io/badge/Agent_Plugins-1.0-brightgreen.svg)](https://agent-plugins.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/temiylin/agent-bridge-mcp)

Control your local developer environment, inspect system health, explore Git repositories, and dispatch asynchronous autonomous agents directly from conversational AI — with zero port forwarding, end-to-end multi-tenant isolation, and strict read-only sandbox protection.

---

## Table of Contents
- [Features](#features)
- [System Architecture](#system-architecture)
- [How to Install](#how-to-install)
  - [Windows Setup](#windows-setup)
  - [Option 1: Codex AI Autonomous Setup (Recommended)](#option-1-codex-ai-autonomous-setup-recommended)
  - [Option 2: ChatGPT One-Click Plugin Upload](#option-2-chatgpt-web--desktop-one-click-plugin-upload)
  - [Option 3: Claude Desktop Configuration](#option-3-claude-desktop-configuration)
  - [Option 4: Standalone Self-Hosted HTTP / Streamable Server](#option-4-standalone-self-hosted-httpsse-server)
- [Available Tools Reference](#available-tools-reference)
- [Safety & Sandbox Guardrails](#safety--sandbox-guardrails)
- [Local Agent Worker & Lifecycle](#local-agent-worker--lifecycle)
- [Testing & Verification](#testing--verification)
- [Configuration Reference](#configuration-reference)
- [License](#license)

---

## Features

- **Multi-Surface AI Control** — Connect seamlessly from ChatGPT Web, ChatGPT Desktop (in ordinary conversations without Codex mode), OpenAI Codex IDE/CLI, and Anthropic Claude Desktop.
- **Hardware & Resource Telemetry (`device_info`)** — Real-time read-only inspection of host specs, Apple Silicon / ARM64 architecture, unified memory usage, disk storage, and process counts.
- **GitHub Pull Request & Review Suite (`pr_*`)** — Directly list PRs (`pr_list`), inspect Codex P0/P1/P2 audit comments (`pr_view`), view PR diffs (`pr_diff`), inspect CI status checks (`pr_checks`), submit code reviews (`pr_review`), open pull requests (`pr_create`), and merge with fast-forward or squash (`pr_merge`).
- **Git Operations & Fast-Forward Verification (`git_*`, `repo_status`)** — Instant read-only status reports, commit range queries (`git_log`), diff statistics (`git_diff` with `--stat` to distinguish backend vs frontend changes), remote fetches (`git_fetch`), and branch fast-forward ancestry verification (`git_check_fast_forward` via `git merge-base --is-ancestor`).
- **Multi-Turn Session Continuity & Parallel Isolation** — Support for continuous pair-programming on the same branch / session across multiple turns (`continue_session: true`, `session_id`). Supports semantic aliases (e.g. `session_id: "backend_api"`), auto-extracts engine UUIDs, and isolates parallel conversations without context crossover.
- **Safe Filesystem & Batch Inspection** — Read file snippets with byte-range pagination, surgically edit blocks (`edit_block`), and batch inspect multiple project directories and Git statuses (`inspect_project_directories`) with built-in protection against directory traversal and symlink escape attacks.
- **Credentials & Private Key Blocklists** — Automatic blocking of accesses targeting `~/.ssh`, `~/.aws`, `~/.kube`, `/etc/shadow`, and private keys (`.pem`, `.key`, `.p12`).
- **Asynchronous Agent Dispatch** — Dispatch long-running autonomous workflows to background worker agents (`send_task`), monitor execution progress (`get_task_status`), stream live stdout logs (`read_task_output`), and retrieve results (`read_result`).
- **Zero-Port Tunneling & Multi-Tenant Relay Hub** — Local machines connect outbound via secure WebSocket tunnels to the cloud relay gateway. No inbound ports, no firewall openings, and strict per-device token isolation.
- **Native Cross-Platform Deployments** — Zero-touch auto-configuration on macOS (LaunchAgent) and Windows (PowerShell user startup & native executable isolation).
- **Agent Plugins 1.0 Specification Compliance** — Pre-packaged with standard `plugin.json`, `mcp.json`, and `skills/` for one-click drag-and-drop installation into ChatGPT.

---

## System Architecture

```text
[ ChatGPT (Cloud/Web/Desktop) ]       [ Codex IDE / CLI ]       [ Claude Desktop ]
               │                               │                         │
      (Streamable HTTP)                 (MCP Add / CLI)               (Stdio)
               ▼                               │                         │
┌─────────────────────────────┐                │                         │
│   Cloud Relay Gateway Hub   │                │                         │
│   (Zero-Trust Proxy Layer)  │                │                         │
└──────────────┬──────────────┘                │                         │
               │ (WSS Outbound Tunnel)         │                         │
               ▼                               ▼                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Local Machine Sandbox                           │
│  ┌──────────────────────────────┐       ┌───────────────────────────┐  │
│  │ 1. Read-only Telemetry       │       │ 3. Asynchronous Agent     │  │
│  │ 2. Git & Safe Filesystem     │       │ 4. Worker Lifecycle & PID │  │
│  └──────────────────────────────┘       └───────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## How to Install

<details open>
<summary><b>Option 1: Codex AI Autonomous Setup (Recommended ⭐ Zero-Touch)</b></summary>
<br>

If you use **Codex Desktop** or the **Codex CLI**, open this repository and simply tell Codex:

> **"帮我部署下这个项目"** (or run `npm run auto-setup`)

Codex will read [`AGENTS.md`](AGENTS.md) and execute the turnkey automation script:
1. Compiles project binaries and installs dependencies.
2. Generates a persistent, unique Device Token (e.g., `dev_macbook_8f21`) locked to your machine.
3. Automatically mounts the MCP server into local Codex using `codex mcp add`.
4. Installs a background system service (macOS LaunchAgent) so your device reconnects automatically on boot.
5. Generates your personalized `agent-bridge-plugin.zip` on your Desktop for one-click upload in ChatGPT.

</details>

### Windows Setup

Use Node.js 22 or newer, Git, Windows PowerShell 5.1 or newer, and a native
Codex CLI executable. Run `npm run auto-setup` from the repository. The Windows
setup builds the project, creates a private runtime directory, installs a hidden
login startup entry for the current user, and creates a personalized plugin ZIP.
It requires no administrator privileges. The dashboard binds to `127.0.0.1`.
Runtime data defaults to `%LOCALAPPDATA%\AgentBridge`; generated outputs default
to its `outputs` subdirectory. `AGENT_BRIDGE_ROOT` and `AGENT_BRIDGE_OUTPUTS`
override these locations. The installer registers the stdio server with the
detected native Codex CLI; other agent configurations can be added separately.

For explicit runtime and output locations, build first and use:

```powershell
npm install
npm run build
.\scripts\setup-windows.ps1 -Action Install -DataPath "$env:LOCALAPPDATA\AgentBridge" -OutputsPath "$env:LOCALAPPDATA\AgentBridge\outputs"
.\scripts\setup-windows.ps1 -Action Status -DataPath "$env:LOCALAPPDATA\AgentBridge"
.\scripts\setup-windows.ps1 -Action Stop -DataPath "$env:LOCALAPPDATA\AgentBridge"
.\scripts\setup-windows.ps1 -Action Start -DataPath "$env:LOCALAPPDATA\AgentBridge"
```

Existing device credentials and agent configurations are preserved. If a service
is already running during an upgrade, restart it after its tasks finish to load
the rebuilt code. Keep generated connection files, configuration, and plugin ZIPs
private: their endpoint contains the device access token.

Legacy Windows installations using `%USERPROFILE%\.agent-bridge\config.json`,
`%USERPROFILE%\agent-bridge`, or a hyphenated `agent-bridge.vbs` startup entry
need an explicit migration. The installer detects these before making changes.
Stop the legacy relay, back up its data and credentials, disable its old startup
entry, and select the existing data directory with `-DataPath`. Preserve the old
device token in that directory's `config.json` so existing cloud connections keep
their identity; do not run two workers against the same task directory.

Set `AGENT_BRIDGE_CODEX_EXE` to an absolute `codex.exe` path to choose a specific
installation. Otherwise the Windows resolver compares native executables in the
desktop app's install directory and `PATH`, preferring the newest working version.
The model catalog is queried from the registered native CLI, including reasoning
efforts and defaults. A cache/fallback source is reported when live discovery is
unavailable; agent-specific model arguments override global defaults.

Windows worker agents must use a native executable, or `node.exe` followed by a
JavaScript entry point. `.cmd`/`.bat` agents are rejected with a configuration error
instead of passing prompt arguments through a command shell.

<details>
<summary><b>Option 2: ChatGPT (Web / Desktop) One-Click Plugin Upload</b></summary>
<br>

1. Run `npm run auto-setup` (or `npm run pack:plugin`). The setup script dynamically provisions your device credentials, generates your personalized `~/Desktop/agent-bridge-plugin.zip`, and prints your device's dedicated MCP endpoint.
2. Open **ChatGPT** -> **Settings** -> **Connectors / MCP** -> Click **Add Custom MCP Server**.
3. In the lower-left corner of the modal, click **Upload Plugin Zip** (上传插件压缩包).
4. Select `agent-bridge-plugin.zip`. All metadata, remote endpoints, and tool skills are loaded automatically without manual input.
5. *(Alternative manual setup)*: If entering the URL manually, paste the device-specific URL printed by the setup script (`https://<relay-domain>/mcp/<device-token>`) and select **None** for authentication. (Tip: run `npm run url` at any time to retrieve your machine's URL).
6. In any standard conversation, ask: *"Inspect this Mac's hardware and free disk space"* to invoke your local tools!

</details>

<details>
<summary><b>Option 3: Claude Desktop Configuration</b></summary>
<br>

Add `agent-bridge` to your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/agent-bridge-mcp/dist/index.js"],
      "env": {
        "AGENT_BRIDGE_ROOT": "/Users/<your-username>/agent-bridge"
      }
    }
  }
}
```
Restart Claude Desktop to activate the tools.

</details>

<details>
<summary><b>Option 4: Standalone Self-Hosted HTTP/SSE Server</b></summary>
<br>

To host an independent local HTTP endpoint on port 38080:

```bash
npm run serve:mcp
```
- Local MCP Streamable HTTP endpoint: `http://localhost:38080/mcp`
- Health check & tool audit: `http://localhost:38080/health`

</details>

---

## Available Tools Reference

The server exposes **39 dedicated tools** partitioned into functional categories:

| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `device_info` | Telemetry | Live CPU, M-series Silicon, RAM, disk, processes, OS specs | Read-only; zero env-var / process parameter exposure |
| `check_port` | Telemetry | Inspect TCP port status, check listening process PID & command | Safe local socket inspection; helps resolve dev port conflicts |
| `execute_command` | Terminal | Execute shell command with safety guardrails and timeout | Destructive command blocklist (`rm -rf /`, `mkfs`, fork bombs); 120s timeout; 32KB truncation |
| `pr_list` | GitHub PR | List pull requests on GitHub (`--repo`, `state`, `limit`) | Powered by host `gh` CLI; structured JSON parsing; non-destructive |
| `pr_view` | GitHub PR | Inspect PR details, description, and Codex P0/P1/P2 review comments | Extracts comment bodies and review states for rework triage |
| `pr_diff` | GitHub PR | View full or patch diff of pull request directly from GitHub | Safe 48KB clamp; supports remote repositories |
| `pr_checks` | GitHub PR | Inspect GitHub Actions and CI status checks on PR | Summary of pass, fail, pending checks with URLs |
| `pr_create` | GitHub PR | Open a new pull request on GitHub with title and markdown body | Validates branch existence; auto-pushes if specified |
| `pr_review` | GitHub PR | Post code reviews (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`) | Direct integration with GitHub Pull Request review workflow |
| `pr_merge` | GitHub PR | Merge PR via fast-forward, merge commit, or squash | Configurable auto branch deletion |
| `repo_status` | Git | Branch name, uncommitted status, and recent commits | Strictly bound to `AGENT_BRIDGE_REPO`; no destructive side-effects |
| `git_diff` | Git | Compare working tree, staged changes, or branch diffs (`--stat`) | Safe 48KB clamp; stat flag distinguishes backend vs frontend changes |
| `git_check_fast_forward` | Git | Test whether branch can fast-forward merge via `git merge-base --is-ancestor` | Returns boolean `can_fast_forward` and incoming commits |
| `git_log` | Git | Query commit history across branch ranges (`<base>..<head>`) | Formatted output with hash, author, date, and subject |
| `git_fetch` | Git | Fetch commits and refs from remote repositories (`github`, `origin`) | Network read-only operation; safe remote ref update |
| `git_push` | Git | Push commits or branches directly (e.g. `<sha>:refs/heads/develop`) | Supports `--force-with-lease` for safe ref updates |
| `search_code` | Search | Fast regex and keyword code search across project files | Built-in ripgrep + Node fallback; skips noise dirs & binaries |
| `search_files` | Search | Recursively find files by name substring or glob pattern | 100 items max; auto-skips `node_modules`, `.git`, `dist` |
| `list_directory` | Filesystem | List files and folders with recursion depth (`depth: 1-5`) & smart noise filtering | Blocks credentials; auto-filters `node_modules`/`.git`; 500 items max |
| `inspect_project_directories` | Filesystem | Batch project directory file counts, byte totals, and Git status | Read-only; bounded scans; skips links and credential paths; disables Git helpers |
| `read_multiple_files` | Filesystem | Batch-read multiple file contents in a single round-trip | Max 20 files per call; per-file fault isolation & credential blocklist |
| `read_file` | Filesystem | Paginated text reading with byte offset and length limits | Blocks private keys; binary file null-byte suppression |
| `tail_file` | Filesystem | Read the tail (end) of a file or log without loading the whole file | Reverse byte buffer seek; credential blacklist; lines & bytes clamping |
| `write_file` | Filesystem | Write or create text files directly on disk | Blocks system dirs & credentials; auto-creates parent folders |
| `edit_block` | Filesystem | Surgically search and replace code snippets in existing files | Verifies target snippet presence; prevents whole-file truncation |
| `move_file` | Filesystem | Move or rename a file or directory across paths | Credential blacklist; overwrite protection; cross-device fallback |
| `create_directory` | Filesystem | Create directory or nested directory structure | Credential blacklist; recursive auto-creation; idempotency |
| `get_file_info` | Filesystem | Query file/directory metadata, sizes, and permissions | Path traversal check; credential blacklist |
| `list_models` | AI Models | Discover available models, active defaults, & reasoning levels | Queries local Codex cache and Antigravity models safely |
| `send_task` | Agent Dispatch | Dispatch task with model, reasoning effort, and session continuity | Supports `continue_session` and `session_id` for multi-turn pair programming |
| `read_result` | Agent Dispatch | Read Markdown result file for a completed task | Path traversal check; non-blocking pending status |
| `read_result_page` | Agent Dispatch | Chunked paging reader for oversized result documents | Offset & length limits to prevent context overflow |
| `get_task_status` | Lifecycle | Check task lifecycle state (`queued`, `running`, `completed`) | Metadata only; suppresses prompt/result content |
| `read_task_output` | Lifecycle | Stream live execution stdout logs during agent execution | Byte offset chunking (1–16000 bytes) |
| `cancel_task` | Lifecycle | Safely request cancellation of queued or executing tasks | Non-destructive control file signaling |
| `wait_task` | Lifecycle | Block and wait for task completion with configurable timeout | Clamped between 1–25 seconds; desktop notification |
| `worker_alive_summary`| Diagnostics | Probe if the local background worker process is running | Harmless POSIX signal 0 probe; no process termination |
| `list_tasks_summary` | Diagnostics | Summary list of recent task executions and outcomes | Metadata whitelist; strictly bounds output count |
| `agent_registry_summary`| Diagnostics | List available agents configured in `agents.json` | Whitelist only; suppresses command paths & args |
| `save_requirement` | Requirements Backlog | Stash a requirement draft for later triage and dispatch | Generic caller-supplied project & topic/session_id; atomic persistence |
| `list_requirements` | Requirements Backlog | Compact list of stored requirements (omits raw text) | Filter by project, topic, status (`draft`, `dispatched`, `merged`, `archived`) |
| `get_requirement` | Requirements Backlog | Retrieve the full record of a specific requirement by ID | Full specification text, tags, metadata, and linked task ID |
| `update_requirement` | Requirements Backlog | Update fields of an existing requirement draft | Edit title, raw_text, tags, topic, or status |
| `merge_requirements` | Requirements Backlog | Merge multiple requirements into a new consolidated record | Source requirements marked `merged` with bidirectional pointers |
| `archive_requirement` | Requirements Backlog | Mark requirement status as `archived` | Soft archive preservation |
| `delete_requirement` | Requirements Backlog | Permanently delete a requirement record file | Strict ID whitelist & directory traversal protection |
| `dispatch_requirement` | Requirements Backlog | Convert requirement into an agent task, reusing session_id | Optional `queue_if_busy: true` to enqueue if session is in-flight |
| `enqueue_task` | Auto Task Queue | Sequence next task behind another task or within a session | Mode `auto` (runs on turn) or `notify` (marks ready); 1 task per session |
| `list_queue` | Auto Task Queue | Compact list of queued items with prompt preview (<=80 chars) | Filter by session_id; shows position, status, and mode |
| `reorder_queue` | Auto Task Queue | Reorder queue items by list of IDs or move item to position | Preserves 1-indexed contiguous positions |
| `update_queue_item` | Auto Task Queue | Surgically update prompt, mode, or execution options of queued item | Safe in-place modification before execution |
| `cancel_queue_item` | Auto Task Queue | Remove and cancel a queued task item | Immediate queue removal and position re-indexing |
| `pause_queue` | Auto Task Queue | Pause automatic dispatching for a session's task queue | Manually hold dispatching; persists across restarts |
| `resume_queue` | Auto Task Queue | Resume automatic dispatching for a session's task queue | Immediately enables next ready dispatch |

### Read-only queries in Gemini

Read-only filesystem, status, and diagnostic tools declare MCP `readOnlyHint: true`
and `destructiveHint: false`. Clients use these hints together with their own
permission policies; they do not guarantee that every query runs without confirmation.
General command execution and file mutations retain their permission checks.

For a workspace containing several projects, use `inspect_project_directories`
instead of a shell script to count documentation or temporary files and inspect
Git status. Its `root_path` is an absolute workspace directory; optional
`project_names` select direct child projects and `directory_names` select direct
child directories within each project (default: `docs`, `output`, `tmp`, `scratch`,
`work`). Missing directories, skipped links, time limits, and incomplete scans
are reported separately from empty directories. Git status ignores submodules
and disables configured fsmonitor and clean/process helpers; custom-filter
repositories such as Git LFS may therefore report a different working-tree status.

---

## Safety & Sandbox Guardrails

1. **Path Traversal Interception**:
   Every file operation sanitizes paths using `path.resolve` and verifies they do not traverse beyond allowed directory roots. Identifiers (`task_id`) are strictly whitelisted to `^[a-zA-Z0-9_-]+$`.
2. **Credential Blacklists**:
   File inspection explicitly forbids querying sensitive locations:
   - Directories: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `/etc/shadow`, `/etc/sudoers`.
   - Files: `id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.keystore`, `.env`.
3. **Execution Guardrails & Destructive Command Interception**:
   - Internal probes (e.g. Git status) run with `shell: false` and fixed arguments.
   - User terminal command execution (`execute_command`) enforces regex blacklists intercepting root deletions (`rm -rf /`, `rm -rf ~`), disk formatting (`mkfs`, `format`), and fork bombs. Commands run with strict timeout limits (default 30s, max 120s) and automatic 32KB stdout/stderr truncation.
4. **Binary File Protection**:
   The `read_file` tool scans byte chunks for null bytes (`\0`). If binary content is detected, text output is suppressed to prevent buffer corruption and terminal garbage.
5. **Audit Logging**:
   All tool invocations are atomically recorded to `$AGENT_BRIDGE_ROOT/logs/audit.log` with tool names and ISO timestamps. Prompt and result bodies are never stored in audit logs to prevent secret leakage.

---

## Local Web Dashboard & Smart Agent Routing

Agent Bridge provides a built-in, local web configuration console served directly at:

```
http://localhost:38080
```

You can open it instantly in your browser at any time:

```bash
npm run dashboard   # or npm run ui
```

### Key Capabilities in Web Console:
1. **Scenario-Based Smart Routing**:
   - **Global Instructions**: Define high-level principles for AI dispatch (e.g. `"Backend architecture, APIs, and databases go to codex; frontend UI, components, and CSS go to agy"`).
   - **Keyword Rules**: Automatically matches prompt keywords to target agents (e.g. `"vue"`, `"react"`, `"ui"` $\to$ `agy`; `"database"`, `"api"`, `"node"` $\to$ `codex`).
   - **Default Fallback**: Guaranteed fallback execution agent when prompt does not match explicit rules.
2. **Local Agent Management (`agents.json`)**:
   - Visual inspection and configuration for local agents (e.g. `codex`, `agy`, custom Python scripts).
   - One-click **Connectivity Probe** testing whether agent executables are properly installed in the system `PATH`.
3. **Instant Hot Apply**:
   - Saving settings immediately updates `routing.json` and `agents.json` on disk, taking effect without service restarts.

---

## Local Agent Worker & Lifecycle

The repository includes a background worker (`agent-bridge-worker`) that watches for queued tasks in `$AGENT_BRIDGE_ROOT/tasks`, executes them through configured agents, and writes outputs to `$AGENT_BRIDGE_ROOT/results`.

### Agent Registry Configuration (`$AGENT_BRIDGE_ROOT/agents.json`)

Configure available execution agents in `agents.json`:

```json
{
  "codex": {
    "command": "codex",
    "args": ["exec"],
    "input": "stdin"
  }
}
```

- `command`: Executable command name or absolute path.
- `args`: Command-line arguments for non-interactive execution.
- `input`: `"stdin"` (pipe prompt to child stdin) or `"arg"` (append prompt as CLI argument).

### Multi-Turn Session Continuity (`session_id` & `continue_session`)

When dispatching tasks via `send_task`, the system supports continuous pair-programming across multiple turns without re-reading the entire project from scratch:

- **Semantic Aliases**: Pass `session_id: "backend_api"` or `session_id: "vue_frontend"` to isolate independent named workstreams.
- **Engine Resumption**:
  - For **Codex**: Automatically maps to `codex exec resume <session_id>` (or `--last` if no session ID was given).
  - For **Antigravity (AGY)**: Automatically maps to `agy -p --conversation <session_id>` (or `--continue`).
- **Parallel Isolation**: Parallel tasks with different session IDs never collide. Real session UUIDs emitted by agents are recorded in `sessions.json` and included in `results/<task_id>.md` metadata.

### Running the Worker

```bash
# Run worker with default directory ~/agent-bridge
npm run worker

# Run with custom polling interval (default 1000ms)
AGENT_BRIDGE_POLL_MS=3000 npm run worker
```

---

## Testing & Verification

The project includes automated integration suites:

```bash
# Run stdio comprehensive test runner
npm test

# Run Git & GitHub PR workflow test suite
npm run test:git-pr

# Run multi-turn session continuity & isolation tests
npm run test:session

# Run local web dashboard tests
npm run test:dashboard

# Run HTTP / Streamable transport test suite
npm run test:http

# Run operations & filesystem safety tests
npm run test:ops
npm run test:local-fs

# Run project inspection and read-only Git regression tests (includes compilation)
npm run test:project-inspection

# Offline native catalog, Windows worker argv, and installer checks
npm run test:catalog
npm run test:worker-native
npm run test:windows-setup
npm run test:relay-logs

# Windows read-only smoke test with the installed native Codex CLI
npm run test:windows-smoke
```

The Windows smoke test performs inference only when explicitly run with `--e2e`.
Installer checks parse and inspect scripts without installing services or
changing the user's Codex configuration.

---

## Configuration Reference

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_ROOT` | `~/agent-bridge` | Base directory for tasks, results, status, and logs |
| `AGENT_BRIDGE_REPO` | `.` | Git repository root inspected by `repo_status` |
| `AGENT_BRIDGE_NOTIFY`| `1` | Set to `0` to disable macOS native completion notifications |
| `RELAY_SERVER` | Pre-configured | Cloud Relay Hub WebSocket endpoint (`wss://<relay-domain>/ws`) |
| `RELAY_HTTP` | Pre-configured | Cloud Relay Hub HTTP gateway endpoint (`https://<relay-domain>/mcp`) |
| `DEVICE_TOKEN` | Generated | Unique device token for multi-tenant routing |

---

## License

This project is licensed under the [MIT License](LICENSE).
