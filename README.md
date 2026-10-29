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
- **Git Repository Intelligence (`repo_status`)** — Instant read-only status reports on branches, uncommitted changes, working tree status, and recent commit history with zero modification risk.
- **Safe Filesystem Exploration** — Read file snippets with byte-range pagination and stream directories with built-in protection against directory traversal and symlink escape attacks.
- **Credentials & Private Key Blocklists** — Automatic blocking of accesses targeting `~/.ssh`, `~/.aws`, `~/.kube`, `/etc/shadow`, and private keys (`.pem`, `.key`, `.p12`).
- **Asynchronous Agent Dispatch** — Dispatch long-running autonomous workflows to background worker agents (`send_task`), monitor execution progress (`get_task_status`), stream live stdout logs (`read_task_output`), and retrieve results (`read_result`).
- **Zero-Port Tunneling & Multi-Tenant Relay Hub** — Local machines connect outbound via secure WebSocket tunnels to the cloud relay gateway. No inbound ports, no firewall openings, and strict per-device token isolation.
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

The server exposes **17 dedicated tools** partitioned into functional categories:

| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `device_info` | Telemetry | Live CPU, M-series Silicon, RAM, disk, processes, OS specs | Read-only; zero env-var / process parameter exposure |
| `repo_status` | Git | Branch name, uncommitted status, and recent commits | Strictly bound to `AGENT_BRIDGE_REPO`; no diffs |
| `list_directory` | Filesystem | List files and folders with recursion depth (`depth: 1-5`) & smart noise filtering | Blocks credentials; auto-filters `node_modules`/`.git`; 500 items max |
| `read_multiple_files` | Filesystem | Batch-read multiple file contents in a single round-trip | Max 20 files per call; per-file fault isolation & credential blocklist |
| `read_file` | Filesystem | Paginated text reading with byte offset and length limits | Blocks private keys; binary file null-byte suppression |
| `get_file_info` | Filesystem | Query file/directory metadata, sizes, and permissions | Path traversal check; credential blacklist |
| `list_models` | AI Models | Discover available models, active defaults, & reasoning levels | Queries local Codex cache and Antigravity models safely |
| `send_task` | Agent Dispatch | Dispatch asynchronous task with optional model & reasoning effort | Validates registry; sanitized `task_id` naming |
| `read_result` | Agent Dispatch | Read Markdown result file for a completed task | Path traversal check; non-blocking pending status |
| `read_result_page` | Agent Dispatch | Chunked paging reader for oversized result documents | Offset & length limits to prevent context overflow |
| `get_task_status` | Lifecycle | Check task lifecycle state (`queued`, `running`, `completed`) | Metadata only; suppresses prompt/result content |
| `read_task_output` | Lifecycle | Stream live execution stdout logs during agent execution | Byte offset chunking (1–16000 bytes) |
| `cancel_task` | Lifecycle | Safely request cancellation of queued or executing tasks | Non-destructive control file signaling |
| `wait_task` | Lifecycle | Block and wait for task completion with configurable timeout | Clamped between 1–25 seconds; desktop notification |
| `worker_alive_summary`| Diagnostics | Probe if the local background worker process is running | Harmless POSIX signal 0 probe; no process termination |
| `list_tasks_summary` | Diagnostics | Summary list of recent task executions and outcomes | Metadata whitelist; strictly bounds output count |
| `agent_registry_summary`| Diagnostics | List available agents configured in `agents.json` | Whitelist only; suppresses command paths & args |

---

## Safety & Sandbox Guardrails

1. **Path Traversal Interception**:
   Every file operation sanitizes paths using `path.resolve` and verifies they do not traverse beyond allowed directory roots. Identifiers (`task_id`) are strictly whitelisted to `^[a-zA-Z0-9_-]+$`.
2. **Credential Blacklists**:
   File inspection explicitly forbids querying sensitive locations:
   - Directories: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `/etc/shadow`, `/etc/sudoers`.
   - Files: `id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.keystore`, `.env`.
3. **No Shell Injections**:
   External commands (such as Git status probes) are executed with `shell: false` and explicitly fixed argument arrays. No arbitrary user shell execution is permitted.
4. **Binary File Protection**:
   The `read_file` tool scans byte chunks for null bytes (`\0`). If binary content is detected, text output is suppressed to prevent buffer corruption and terminal garbage.
5. **Audit Logging**:
   All tool invocations are atomically recorded to `$AGENT_BRIDGE_ROOT/logs/audit.log` with tool names and ISO timestamps. Prompt and result bodies are never stored in audit logs to prevent secret leakage.

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

# Run HTTP / Streamable transport test suite
npm run test:http

# Run operations & filesystem safety tests
npm run test:ops
npm run test:local-fs
```

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
