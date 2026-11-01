# Agent Bridge MCP
### Safely connect ChatGPT, Codex, and Claude to your local environment with zero open ports

[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-blue.svg)](https://modelcontextprotocol.io/)
[![Agent Plugins](https://img.shields.io/badge/Agent_Plugins-1.0-brightgreen.svg)](https://agent-plugins.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/temiylin/agent-bridge-mcp)

Control your local developer environment, inspect system health, explore Git repositories, orchestrate multi-step execution plans, manage projects, and dispatch asynchronous autonomous agents directly from conversational AI — with zero port forwarding, end-to-end multi-tenant isolation, and strict read-only sandbox protection.

---

## Table of Contents
- [Features](#features)
- [System Architecture](#system-architecture)
- [How to Install](#how-to-install)
  - [Windows Setup](#windows-setup)
  - [Option 1: Codex AI Autonomous Setup (Recommended)](#option-1-codex-ai-autonomous-setup-recommended)
  - [Option 2: ChatGPT One-Click Plugin Upload](#option-2-chatgpt-web--desktop-one-click-plugin-upload)
  - [Option 3: Claude Desktop Configuration](#option-3-claude-desktop-configuration)
  - [Option 4: Standalone Self-Hosted HTTP / Streamable Server](#option-4-standalone-self-hosted-http--streamable-server)
- [Available Tools Reference (88 Tools)](#available-tools-reference-88-tools)
- [Multi-Step Execution Plans (`feat/plans`)](#multi-step-execution-plans-featplans)
- [Project Configuration Management (`projects.json`)](#project-configuration-management-projectsjson)
- [Unified Task Stages & Structured Reporting](#unified-task-stages--structured-reporting)
- [Local Web Dashboard & Action Console](#local-web-dashboard--action-console)
- [agy Multi-Account Pool & Cockpit Integration](#agy-multi-account-pool--cockpit-integration)
- [Native agy-sdk Stream-JSON Runner](#native-agy-sdk-stream-json-runner)
- [Task Timeouts, Lifecycle & Cancellation](#task-timeouts-lifecycle--cancellation)
- [Opt-In Per-Task Completion Webhooks](#opt-in-per-task-completion-webhooks)
- [Safety & Sandbox Guardrails](#safety--sandbox-guardrails)
- [Local Agent Worker & Lifecycle](#local-agent-worker--lifecycle)
- [Testing & Verification](#testing--verification)
- [Configuration Reference](#configuration-reference)
- [License](#license)

---

## Features

- **Multi-Surface AI Control** — Connect seamlessly from ChatGPT Web, ChatGPT Desktop (in ordinary conversations without Codex mode), OpenAI Codex IDE/CLI, Anthropic Claude Desktop, and Gemini/Antigravity.
- **Multi-Step Execution Plans (`feat/plans`)** — Structured plan authoring (`create_plan`, `get_plan`, `update_plan`), step-linked task dispatches (`plan_id` + `step_id`), automatic prompt context injection with large-context truncation, and hands-free step completion writeback (`done`/`failed`).
- **Project Configuration & Defaults Inheritance (`projects.json`)** — Register workspaces once (`add_project`). Dispatched tasks automatically inherit repository paths, base branches, push remotes, forbidden remotes, execution agents, models, timeouts, and callbacks.
- **Unified Task Stage Derivation (`deriveStage`) & Structured Agent Reports** — 8-level unambiguous task stage hierarchy (`needs_human/failed`, `needs_human/quota`, `needs_human/stalled`, `needs_human/answer`, `needs_human/review`, `queued`, `working`, `done`) coupled with a strict `$TASK_DIR/report.json` schema contract and heuristic regex fallbacks.
- **Action-Oriented Web Dashboard** — Focused 3-block console (「待处理」with 1-click action buttons,「系统问题」for consecutive failures, and「执行中」active runs) plus slide-out Plan Drawer and settings management.
- **Native agy Stream-JSON Runner (`agy-sdk`)** — Direct NDJSON streaming without Python middle-layers, event-only stall detection (immune to busy-loop false positives), strict 429 quota exhaustion classification, 1MB memory protection, and status write throttling.
- **Multi-Account Profile Isolation & Quota Pooling** — Run multiple concurrent Antigravity (`agy`) accounts on a single machine with isolated `$HOME` directories, automatic session stickiness, and non-intrusive Cockpit Tools quota telemetry.
- **Hardware & Resource Telemetry (`device_info`)** — Real-time read-only inspection of host specs, Apple Silicon / ARM64 architecture, unified memory usage, disk storage, and process counts.
- **GitHub Pull Request & Review Suite (`pr_*`, `verify_pr`, `merge_and_deploy`)** — List PRs, inspect Codex P0/P1/P2 audit comments, view diff patches, inspect CI status, submit reviews, open PRs, run automated verification tests, and fast-forward deploy with service restarts.
- **Git Operations & Remote Guardrails (`git_*`, `repo_status`)** — Diff inspection with `--stat`, ancestry verification (`git_check_fast_forward`), commit queries (`git_log`), remote fetches (`git_fetch`), and safe pushes (`git_push`) strictly guarded by URL-based `forbidden_remotes`.
- **Zero-Port Outbound Tunneling & Multi-Tenant Relay Hub** — Outbound WebSocket tunnel to relay hub. Zero open ports, no firewall traversal, and strict 192-bit per-device token isolation.

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
│  │ 1. Read-only Telemetry       │       │ 4. Multi-Step Plans       │  │
│  │ 2. Git & Safe Filesystem     │       │ 5. Project Config Router  │  │
│  │ 3. PR & Service Deployment   │       │ 6. Worker Lifecycle & PID │  │
│  └──────────────────────────────┘       └───────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## How to Install

<details open>
<summary><b>Option 1: Codex / Antigravity AI Autonomous Setup (Recommended ⭐ Zero-Touch)</b></summary>
<br>

If you use **Codex Desktop**, **Codex CLI**, or **Antigravity (AGY)**, open this repository and simply tell the AI:

> **"帮我部署下这个项目"** (or run `npm run auto-setup`)

The agent reads [`AGENTS.md`](AGENTS.md) or [`GEMINI.md`](GEMINI.md) and executes the turnkey script:
1. Compiles project binaries and installs dependencies.
2. Generates a persistent, unique 192-bit Device Token (e.g., `dev_macbook_8f21`) locked to your machine.
3. Automatically mounts the MCP server into local Codex (`codex mcp add`) and Antigravity (`agy mcp add`).
4. Installs a background system service (macOS LaunchAgent / Windows startup entry) so your device reconnects automatically on boot.
5. Generates your personalized `agent-bridge-plugin.zip` on your Desktop for one-click upload in ChatGPT.

</details>

### Windows Setup

Use Node.js 22 or newer, Git, Windows PowerShell 5.1 or newer, and a native Codex CLI executable. Run `npm run auto-setup` from the repository. The Windows setup builds the project, creates a private runtime directory, installs a hidden login startup entry for the current user, and creates a personalized plugin ZIP. It requires no administrator privileges.

```powershell
npm install
npm run build
.\scripts\setup-windows.ps1 -Action Install -DataPath "$env:LOCALAPPDATA\AgentBridge" -OutputsPath "$env:LOCALAPPDATA\AgentBridge\outputs"
.\scripts\setup-windows.ps1 -Action Status -DataPath "$env:LOCALAPPDATA\AgentBridge"
.\scripts\setup-windows.ps1 -Action Stop -DataPath "$env:LOCALAPPDATA\AgentBridge"
.\scripts\setup-windows.ps1 -Action Start -DataPath "$env:LOCALAPPDATA\AgentBridge"
```

<details>
<summary><b>Option 2: ChatGPT (Web / Desktop) One-Click Plugin Upload</b></summary>
<br>

1. Run `npm run auto-setup` (or `npm run pack:plugin`). The setup script provisions your device credentials, generates `~/Desktop/agent-bridge-plugin.zip`, and prints your dedicated endpoint.
2. Open **ChatGPT** -> **Settings** -> **Connectors / MCP** -> Click **Add Custom MCP Server**.
3. In the lower-left corner of the modal, click **Upload Plugin Zip** (上传插件压缩包).
4. Select `agent-bridge-plugin.zip`. All metadata, endpoints, and tool schemas are registered automatically.
5. *(Alternative manual setup)*: Enter the device-specific URL (`https://<relay-domain>/mcp/<device-token>`) and select **None** for authentication.

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

</details>

<details>
<summary><b>Option 4: Standalone Self-Hosted HTTP / Streamable Server</b></summary>
<br>

To host an independent local HTTP endpoint on port 38080:

```bash
npm run serve:mcp
```
- Local MCP Streamable HTTP endpoint: `http://localhost:38080/mcp`
- Health check & tool audit: `http://localhost:38080/health`

</details>

---

## Available Tools Reference (88 Tools)

Agent Bridge MCP registers **88 dedicated tools** partitioned into functional categories:

### 1. Multi-Step Execution Plans (6 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `create_plan` | Plans | Create a new structured plan with background context and ordered steps | Atomic write; `.bak` backup; `O_EXCL` file lock |
| `get_plan` | Plans | Fetch full plan details, steps, active step, linked task IDs, and PR URLs | Read-only |
| `update_plan` | Plans | Update plan title, context markdown, or step definitions | Increments `version`; atomic write & lock |
| `list_plans` | Plans | List plan summaries (supports `project_id` filter; omits large markdown) | Read-only compact output |
| `set_plan_step_status` | Plans | Update step status (`todo`, `in_progress`, `done`, `failed`, `skipped`) | Preserves manual status overrides |
| `archive_plan` | Plans | Soft-archive an execution plan | Strictly refused if active or queued tasks are linked |

### 2. Project Configuration Management (5 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `add_project` | Projects | Register project in `projects.json` with execution & git defaults | Validates `repo_path` existence and git repository validity |
| `list_projects` | Projects | List registered projects, paths, validation status, and defaults | Redacts raw secrets; returns env variable names |
| `update_project` | Projects | Surgically update project configurations and callback settings | Re-validates changed paths; atomic write with `.bak` |
| `remove_project` | Projects | Remove project from `projects.json` | Refused if project has running or queued tasks |
| `list_project_tasks` | Projects | Query all tasks associated with a specific project | Read-only metadata query |

### 3. Agent Dispatch, Lifecycle & Stages (12 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `send_task` | Dispatch | Dispatch task with `project_id`, `plan_id`, `step_id`, model, timeouts | Pre-validates paths, injects plan context, freezes plan version |
| `read_result` | Dispatch | Read Markdown result file for a completed task (compact or full) | Path traversal protection; non-blocking pending status |
| `read_result_page` | Dispatch | Paged chunked reader for oversized result documents | Offset & length limits to prevent buffer overflow |
| `read_task_output` | Lifecycle | Stream live execution stdout logs incrementally from `logs/<id>.out` | Safe byte offset clamping (1–16000 bytes) |
| `get_task_status` | Lifecycle | Inspect lifecycle `state`, 8-stage `stage`, `outcome`, and activity | Metadata whitelist; suppresses prompt & result text |
| `wait_task` | Lifecycle | Block and wait for task completion with configurable timeout | Clamped between 1–25 seconds; desktop notification |
| `cancel_task` | Lifecycle | Safely request cancellation of queued or executing tasks | Non-destructive signal file; 2s SIGTERM $\to$ SIGKILL |
| `list_tasks_summary`| Diagnostics | Compact list of recent task execution summaries and `stage` | Bounds output count; whitelist only |
| `list_recent_tasks` | Dashboard | Tabular recent tasks overview with `project_id` & `plan_id` filters | Real-time status, stage, elapsed, and PR URLs |
| `dashboard` | Dashboard | Summary alias for recent tasks and active queue counts | Fast single-call overview |
| `agent_registry_summary`| Diagnostics | List available agents configured in `agents.json` | Suppresses command paths & internal execution arguments |
| `list_models` | AI Models | Discover available models, active defaults, & reasoning levels | Queries local Codex and Antigravity model caches safely |

### 4. Auto Task Queue & Requirements Backlog (15 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `save_requirement` | Backlog | Stash a long requirement or idea as a draft without dispatching | Tagged with project, topic, and timestamp |
| `list_requirements` | Backlog | Compact list of stored requirements | Filter by project, topic, and status (`draft`, `dispatched`, etc.) |
| `get_requirement` | Backlog | Fetch full requirement text and metadata by id | Read-only |
| `update_requirement`| Backlog | Edit draft requirement fields before dispatch | Safe in-place edit |
| `merge_requirements`| Backlog | Consolidate multiple requirement drafts into a single record | Bidirectional tracking pointers |
| `archive_requirement`| Backlog| Soft-archive requirement draft without deleting | Preserves historical context |
| `delete_requirement`| Backlog | Permanently delete a requirement draft | Irreversible |
| `dispatch_requirement`| Backlog| Convert requirement into an active task or queue item | Reuses session_id; optional `queue_if_busy` |
| `enqueue_task` | Queue | Sequence task behind another task or session (`project_id`, `plan_id` supported) | Mode `auto` or `notify`; 1 running task per session lane |
| `list_queue` | Queue | Compact list of queued items with prompt preview (<=80 chars) | Filter by session_id; shows positions and modes |
| `reorder_queue` | Queue | Reorder queue items by list of IDs or move item to position | Preserves 1-indexed contiguous positions |
| `update_queue_item` | Queue | Surgically update prompt, mode, or options of queued item | Safe in-place modification before execution |
| `cancel_queue_item` | Queue | Remove and cancel a queued task item | Immediate removal and position re-indexing |
| `pause_queue` | Queue | Pause automatic dispatching for a session's task queue | Manually hold dispatching; persists across restarts |
| `resume_queue` | Queue | Resume automatic dispatching for a session's task queue | Immediately enables next ready dispatch |

### 5. Git Operations & CI/CD Deployment (8 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `repo_status` | Git | Branch name, working tree dirty state, and recent commits | Strictly bound to target repo; no side-effects |
| `git_diff` | Git | Compare working tree, staged changes, or branch diffs (`--stat`) | Safe 48KB clamp; stat distinguishes backend vs frontend |
| `git_check_fast_forward`| Git | Test if branch can fast-forward via `git merge-base --is-ancestor` | Returns boolean `can_fast_forward` and commit list |
| `git_log` | Git | Query commit history across branch ranges (`<base>..<head>`) | Formatted output with hash, author, date, and subject |
| `git_fetch` | Git | Fetch commits and refs from remote repositories | Network read-only operation; safe remote ref update |
| `git_push` | Git | Push commits or branches directly to remote | Strictly blocks project `forbidden_remotes` URLs; refspec guard |
| `verify_pr` | Verification | Run automated project test commands on PR branch | Executes configured `verify_pr.test_commands` with timeouts |
| `merge_and_deploy` | Deployment | Fast-forward merge PR branch, push remote, and restart services | Guarded by `forbidden_remotes`; restarts declared services |

### 6. GitHub Pull Request & Review Suite (7 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `pr_list` | GitHub PR | List pull requests on GitHub (`--repo`, `state`, `limit`) | Powered by host `gh` CLI; structured JSON parsing |
| `pr_view` | GitHub PR | Inspect PR details, description, and Codex P0/P1/P2 comments | Extracts comment bodies and review states for triage |
| `pr_diff` | GitHub PR | View full or patch diff of pull request directly from GitHub | Safe 48KB clamp |
| `pr_checks` | GitHub PR | Inspect GitHub Actions and CI status checks on PR | Summary of pass, fail, pending checks with URLs |
| `pr_create` | GitHub PR | Open a new pull request on GitHub with title and body | Validates branch existence; auto-pushes if specified |
| `pr_review` | GitHub PR | Post code reviews (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`) | Direct integration with GitHub Pull Request review workflow |
| `pr_merge` | GitHub PR | Merge PR via fast-forward, merge commit, or squash | Configurable auto branch deletion |

### 7. Filesystem & Safe Code Editing (13 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `list_directory` | Filesystem | List files with recursion depth & smart noise filtering | Blocks credentials; filters `node_modules`/`.git`; 500 max |
| `read_file` | Filesystem | Paginated text reading with byte offset and length limits | Blocks private keys; binary file null-byte suppression |
| `read_multiple_files`| Filesystem | Batch-read multiple file contents in a single round-trip | Max 20 files per call; per-file fault isolation |
| `write_file` | Filesystem | Write or create text files directly on disk | Blocks system directories; auto-creates parent folders |
| `edit_block` | Filesystem | Surgically search and replace code snippets in existing files | Verifies target snippet presence; prevents truncation |
| `search_files` | Search | Recursively find files by name substring or glob pattern | 100 items max; auto-skips `node_modules`, `.git`, `dist` |
| `search_code` | Search | Fast regex and keyword code search across project files | Built-in ripgrep + Node fallback; skips noise dirs |
| `tail_file` | Filesystem | Read the tail of a file or log without loading the whole file | Reverse byte buffer seek; lines & bytes clamping |
| `move_file` | Filesystem | Move or rename a file or directory across paths | Credential blacklist; overwrite protection |
| `create_directory` | Filesystem | Create directory or nested directory structure | Credential blacklist; recursive auto-creation |
| `get_file_info` | Filesystem | Query file/directory metadata, sizes, and permissions | Path traversal check; credential blacklist |
| `inspect_project_directories` | Filesystem | Batch project directory file counts, byte totals, and Git status | Bounded scans; skips links & credentials; disables git helpers |
| `execute_command` | Terminal | Execute shell command with safety guardrails and timeout | Destructive command blocklist (`rm -rf /`, `mkfs`); 120s max |

### 8. agy Multi-Account Pool & Cockpit Isolation (12 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `pool_status` | Account Pool | Summary of agy account profiles, in-flight tasks, and quota | Compact status lines per profile |
| `pool_init_profile` | Account Pool | Initialize isolated profile dir with safe symlinks and login command | Enforces one-account-one-dir invariant |
| `pool_pause` | Account Pool | Pause an account profile from automated task selection | Excludes profile from auto task selection |
| `pool_resume` | Account Pool | Resume a paused account profile | Restores profile to eligible pool |
| `pool_bind_email` | Account Pool | Bind Cockpit email to profile for quota tracking & collision prevention | Safe email mapping without storing secrets |
| `pool_sync_auth` | Account Pool | Sync logged-in Cockpit account into profile HOME | Copy of non-secret tokens without exposing credentials |
| `pool_remove_profile`| Account Pool | Safely remove an idle custom profile directory | Refused while running active tasks |
| `pool_set_custom_enabled`| Account Pool| Toggle custom pool vs default Cockpit pool | Clean mode switching |
| `resume_after_account_switch`| Account Switch| Resume a quota-paused task after account switch | Re-dispatches with continue_session using same session_id |
| `auto_resume_on_account_ready`| Account Switch| Probe account readiness and auto-resume quota tasks | Safe non-blocking probe |
| `list_agent_accounts`| Account Pool | List accounts configured for local agents | Metadata only |
| `switch_agent_account`| Account Pool| Switch active account for local agent CLI | Controlled switch |

### 9. Operations, Webhooks & Notifications (5 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `set_task_webhook` | Webhook | Attach an opt-in completion webhook to a specific task | Opt-in per task; supports HMAC signature secret |
| `clear_task_webhook`| Webhook | Clear and remove any completion webhook from a task | Stops further webhook delivery for the task |
| `restart_service` | Operations | Restart project services declared in `projects.json` | Executes declared shell commands for specified service |
| `notify_device` | Telemetry | Send local desktop notification to user | Bounded title and message length; no secret leakage |
| `slack_post` | Notifications | Send message or alert to project Slack webhook | Non-blocking HTTP POST |

### 10. System Telemetry & Documentation (3 Tools)
| Tool Name | Scope | Purpose | Safety Guardrails |
| :--- | :--- | :--- | :--- |
| `device_info` | Telemetry | Live CPU, M-series Silicon, RAM, disk, processes, OS specs | Read-only; zero env-var / process parameter exposure |
| `check_port` | Telemetry | Inspect TCP port status, check listening process PID & command | Safe local socket inspection; resolves dev port conflicts |
| `worker_alive_summary`| Diagnostics | Probe if local background worker process is running | Harmless POSIX signal 0 probe; no process termination |
| `self_check` | Diagnostics | Run environment self-diagnostics and permissions audit | Read-only status report |
| `help` | Documentation | Get comprehensive documentation, workflows, and recipes by topic | Read-only; accepts topic (`overview`, `projects`, `plans`, etc.) |

---

## Multi-Step Execution Plans (`feat/plans`)

Execution plans orchestrate complex, multi-stage engineering tasks (e.g. architectural refactorings, multi-module feature development) across multiple autonomous agent turns.

### Plan Lifecycle & Data Storage
- Plans are persisted under `~/agent-bridge/plans/<plan_id>.json`.
- All modifications use **atomic temporary writes + rename**, automatic `.bak` backup preservation on corrupt file detection, and **`O_EXCL` file locking** (`<plan_id>.lock`) with in-lock file re-reads.

```json
{
  "id": "refactor-auth-v2",
  "project_id": "core_service",
  "title": "Refactor Authentication Architecture",
  "context": "# Auth Migration Context\nMigrate legacy sessions to JWT...",
  "version": 1,
  "steps": [
    {
      "id": "step-1-schema",
      "title": "Update Database Schema",
      "detail": "Define User token tables and generate migrations.",
      "status": "todo",
      "task_ids": [],
      "pr_urls": []
    }
  ]
}
```

### How to Use Plans:
1. **Create Plan**: Call `create_plan({ id, title, context, steps })`.
2. **Dispatch Step**: In `send_task` or `enqueue_task`, supply `plan_id` and `step_id`:
   - The bridge validates that the plan and step exist.
   - It automatically injects the plan title, context summary (automatically truncated with file path pointer if >4000 characters), and current step detail into the agent's prompt.
   - The step is automatically updated to `in_progress`, the `taskId` is recorded, and `plan_version` is frozen in task status.
3. **Automatic Completion Writeback**: When the agent finishes:
   - Worker automatically writes back task outcomes: success $\to$ `done`, failure $\to$ `failed`.
   - Any step manually marked as `skipped` is strictly preserved and never overwritten.
   - Associated PR URLs and Task IDs are automatically appended to the step.
4. **Monitor**: View overall progress via `get_plan`, `list_plans`, or the Web Console **Plan Drawer**.

---

## Project Configuration Management (`projects.json`)

`projects.json` allows callers to define workspace environments once, avoiding repetitive parameters and preventing mistaken pushes to forbidden remotes.

### Project Schema & Inherited Defaults
Passing `project_id` to `send_task` or `enqueue_task` automatically applies:
- `repo_path`: Local repository path (validated on registration and task dispatch).
- `default_base_branch`: Target base branch (e.g. `develop`).
- `push_remote`: Designated remote for Git push (e.g. `github`).
- `forbidden_remotes`: Prohibited remote URLs/hosts (e.g. `["gitee.com"]`).
- `default_agent` & `default_model`: Preferred agent executable and model.
- `default_timeout_seconds`: Soft overdue and hard kill thresholds.
- `callback_url` & `callback_headers`: Completion webhook parameters.

### Security Guardrails:
1. **URL-based `forbidden_remotes` Guard**:
   `git_push` and `merge_and_deploy` resolve the target remote's actual push URL (`git remote get-url --push <remote>`) and match against host/domain/path patterns (supporting `ssh://host:port/path`). Pushes to forbidden remotes are strictly blocked without modifying user `.git/config` files or installing intrusive hooks in the main repository.
2. **Environment Variable Whitelist in `callback_headers`**:
   Callback headers originating from `projects.json` only accept whitelisted environment variable references matching `^AGENT_BRIDGE_CB_[A-Z0-9_]+$` (or explicitly listed in `allowed_env`), supporting formats like `"Bearer $AGENT_BRIDGE_CB_TOKEN"`. Sensitive system variables (`HOME`, `PATH`, `GITHUB_TOKEN`) and raw plaintext secrets are rejected.

---

## Unified Task Stages & Structured Reporting

Agent Bridge derives a unified `stage` for every task according to an 8-level priority hierarchy (first match wins):

```text
needs_human/failed  (failed or hard timeout, no subsequent continuation dispatched)
        ▼
needs_human/quota   (paused_quota; waiting for account switch / quota reset)
        ▼
needs_human/stalled (suspected_stalled; no output or progress events)
        ▼
needs_human/answer  (agent finished with report.question non-empty)
        ▼
needs_human/review  (outcome === "ready" and associated PR is open)
        ▼
     queued         (task is queued or paused in session queue)
        ▼
    working         (task is actively running)
        ▼
      done          (task completed cleanly or cancelled)
```

### Agent Structured Report Contract (`$TASK_DIR/report.json`)
Every dispatched prompt instructs the agent to write a structured JSON summary before finishing:

```json
{
  "outcome": "ready|blocked|failed|dropped",
  "pr_url": "https://github.com/org/repo/pull/123",
  "question": null,
  "summary": "Implemented feature changes and verified tests pass (<= 500 chars)"
}
```

- When present, the worker validates the schema and records `report_source: "report_json"`.
- If missing or invalid, the worker falls back to heuristic regex extraction (`report_source: "heuristic"`), ensuring completion callbacks and webhooks never crash.
- `stage`, `outcome`, `pr_url`, and `question` are surfaced across `get_task_status`, `list_tasks_summary`, `list_recent_tasks`, REST `/api/tasks`, and callbacks.

---

## Local Web Dashboard & Action Console

Open the local dashboard in your browser:

```bash
npm run dashboard   # binds to http://localhost:38080
```

### Key UI Views:
1. **Action-Oriented Home (待处理首页)**:
   - **待处理**: Displays all `needs_human/*` tasks with exact waiting reasons and 1-click action buttons (**打开 PR** / **重试** / **恢复队列** / **查看问题**).
   - **系统问题**: Displays critical issues (consecutive failures $\ge 3$); completely hidden when healthy.
   - **执行中**: Compact display of active `working` and `queued` tasks.
   - When everything is healthy and complete, displays **"没有需要你处理的事"**.
2. **Plan Drawer (计划抽屉)**:
   - Slide-out right sidebar displaying the complete execution plan tree, active step highlighting, and direct links to generated Task IDs and GitHub PRs.
3. **Task Table (任务列表)**:
   - Full tabular view supporting filtering by **项目 (Project)** and **计划 (Plan)**, with badges and output logs.
4. **Settings Modal (设置面板)**:
   - Dedicated **📁 项目管理 (Projects)** tab for CRUD operations on `projects.json`.
   - Dedicated **📋 计划管理 (Plans)** tab for authoring and archiving execution plans.
   - Smart routing rules and agent connection probes.

---

## agy Multi-Account Pool & Cockpit Integration

### Profile Isolation Architecture
- The `agy` CLI auth tokens live strictly in `$HOME/.gemini` (`jetski-standalone-oauth-token` / `oauth_creds.json`).
- Concurrent multi-account is realized by dedicating an independent profile directory under `~/agent-bridge/agy-profiles/<alias>/` per account, each authenticated once with the `agy` CLI.
- Safe user configs (`~/.gitconfig`, `~/.ssh`, `~/.config/gh`) are symlinked into each profile directory. Credentials and Cockpit ciphertexts are **never** copied across profiles or exposed via MCP.
- A single email/account is bound to at most one profile directory simultaneously.

### Initializing Profiles:
```bash
# Initialize isolated profile via MCP tool
pool_init_profile({ alias: "worker-1", email: "user1@example.com" })

# Authenticate once in local terminal:
HOME=~/agent-bridge/agy-profiles/worker-1 agy
```

---

## Native agy-sdk Stream-JSON Runner

Configure native `stream-json` execution in `$AGENT_BRIDGE_ROOT/agents.json`:

```json
{
  "agy-sdk": {
    "command": "agy",
    "args": ["-p", "--output-format", "stream-json"],
    "input": "stdin",
    "stream_json": true
  }
}
```

### Architectural Safeguards:
- **No Python Wrapper**: The TypeScript worker directly spawns `agy` and consumes structured NDJSON line-by-line.
- **Event-Only Stall Detection**: Tasks are flagged `suspected_stalled` only when no stream events arrive for the inactivity window. Pure CPU busy loops without events correctly trigger stall alerts.
- **Strict Quota Matching**: Rejects generic transient 429 errors; only marks `paused_quota` on verified subscription exhaustion.
- **1MB Buffer Caps**: Prevents memory bloat by capping clean output buffers at 1MB.
- **Status Write Throttling**: Throttles disk writes (at most once every 10 tokens or 500ms) to eliminate IO thrashing.

---

## Task Timeouts, Lifecycle & Cancellation

`send_task` exposes two distinct timeout controls:

| Parameter | Behavior |
| :--- | :--- |
| `notify.timeout_seconds` (soft) | **Alert only.** Sends an overdue alert (desktop notification, callback POST `status: "overdue"`, webhook `"overdue"`). The agent **keeps running**. |
| `timeout_seconds` (hard) | **Kill.** Worker sends SIGTERM/SIGKILL to the agent process tree and marks `status: "timeout"`. |

If `timeout_seconds` is omitted, a **6-hour safety cap** applies.

### Task Cancellation:
Calling `cancel_task({ task_id })`:
1. Marks `state: "cancelled"` immediately to eliminate UI flicker.
2. Sends `SIGTERM` to the process tree, escalating to `SIGKILL` after a 2-second grace period.
3. Emits a single clean terminal callback/webhook event (`status: "cancelled"`).

---

## Opt-In Per-Task Completion Webhooks

Completion webhooks are **opt-in per task** only. Callers pass `on_complete` to `send_task` or attach via `set_task_webhook`:

```json
{
  "url": "https://example.com/webhook",
  "secret": "optional-hmac-secret",
  "events": ["completed", "failed", "timeout", "overdue", "cancelled"]
}
```
Webhook delivery failures are non-blocking and never interrupt queue progression.

---

## Safety & Sandbox Guardrails

1. **Path Traversal Protection**: Every file path is validated via `path.resolve`. Identifiers (`task_id`, `plan_id`) are whitelisted to `^[a-zA-Z0-9_-]+$`.
2. **Credential Blacklists**: Access to `~/.ssh`, `~/.aws`, `~/.kube`, `/etc/shadow`, `.env`, and private keys (`.pem`, `.key`, `.p12`) is strictly forbidden.
3. **Destructive Command Interception**: `execute_command` enforces regex blacklists intercepting root deletions (`rm -rf /`), formatting (`mkfs`), and fork bombs, with 120s max timeout and 32KB truncation.
4. **Binary Suppression**: `read_file` scans byte chunks for null bytes (`\0`) and suppresses binary output to prevent terminal corruption.
5. **Audit Logging**: Tool invocations are atomically logged to `$AGENT_BRIDGE_ROOT/logs/audit.log` without leaking prompt or secret bodies.

---

## Local Agent Worker & Lifecycle

Run the background worker daemon:

```bash
# Run worker with default directory ~/agent-bridge
npm run worker

# Run with custom polling interval (default 1000ms)
AGENT_BRIDGE_POLL_MS=2000 npm run worker
```

---

## Testing & Verification

Run automated test suites:

```bash
# Comprehensive MCP tools & agy-sdk unit tests
npm test

# Multi-step execution plans test suite
npx tsx test/plan-test.ts

# Task stage derivation & report.json test suite
npx tsx test/task-stage-report-test.ts

# Project configuration & forbidden_remotes test suite
npx tsx test/project-config-test.ts

# Operations & safety tests
npm run test:ops
npm run test:webhook
npm run test:git-pr
npm run test:session
npm run test:dashboard

# Full production build (TypeScript + Vite)
npm run build
```

---

## Configuration Reference

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_ROOT` | `~/agent-bridge` | Base directory for tasks, results, plans, status, and logs |
| `AGENT_BRIDGE_REPO` | `.` | Git repository root inspected by `repo_status` |
| `AGENT_BRIDGE_NOTIFY`| `1` | Set to `0` to disable native completion notifications |
| `RELAY_SERVER` | Pre-configured | Cloud Relay Hub WebSocket endpoint (`wss://...`) |
| `RELAY_HTTP` | Pre-configured | Cloud Relay Hub HTTP gateway endpoint (`https://...`) |
| `DEVICE_TOKEN` | Generated | Unique 192-bit device token for multi-tenant routing |

---

## License

This project is licensed under the [MIT License](LICENSE).
