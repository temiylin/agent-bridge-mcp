# agent-bridge-mcp

通用本地 MCP Server：用于远程 AI 助手（如 Claude Desktop）与本地 AI Agent 之间的任务派发与结果读取桥接。

## 项目简介

`agent-bridge-mcp` 提供了一个通用的本地桥接层，基于标准的 Model Context Protocol (MCP) 与 stdio 传输机制。通过基于文件的统一解耦格式，实现：
- **任务派发 (`send_task`)**：远程 AI 助手通过 MCP 工具将任务 Prompt 写入待执行目录 `$AGENT_BRIDGE_ROOT/tasks/<task_id>.md`。
- **结果读取 (`read_result`)**：本地 Agent 执行完成后将结果写入 `$AGENT_BRIDGE_ROOT/results/<task_id>.md`，远程 AI 助手通过 MCP 工具读取执行结果。若任务尚未完成，返回清晰的等待状态而非抛错崩溃。

不依赖任何特定 Agent 的私有 API，不执行任何外部 Shell 命令，不合并代码，具备严格的安全路径校验。

---

## 数据目录结构

数据根目录由环境变量 `AGENT_BRIDGE_ROOT` 指定，默认为 `~/agent-bridge`。服务启动或执行时会自动创建以下子目录：

```text
$AGENT_BRIDGE_ROOT/
  ├── tasks/      # 待执行任务：<task_id>.md
  ├── results/    # 执行结果：<task_id>.md
  ├── status/     # 任务状态信息：<task_id>.json
  ├── control/    # 任务控制标志：<task_id>.cancel
  └── logs/       # Server/Worker 操作日志与输出
```

---

## 提供的 MCP 工具

### 1. `send_task`
- **功能**：派发新任务。
- **参数**：
  - `prompt`（string，必填）：任务的具体指令与提示词。
  - `title`（string，可选）：任务标题。
  - `agent`（string，可选）：目标 Agent 名称（必须在 `agents.json` 中登记；若未填写，写入文件后由 worker 标记失败）。
- **行为**：
  - 校验 `agents.json` 存在且格式合法。
  - 自动生成唯一 `task_id`（时间戳 + 随机后缀）。
  - 将任务信息写入 `$AGENT_BRIDGE_ROOT/tasks/<task_id>.md`，包含标题、创建时间、Task ID、Agent 名称与 Prompt。
  - 返回生成的 `task_id` 与对应文件路径。

### 2. `read_result`
- **功能**：读取指定任务的执行结果。
- **参数**：
  - `task_id`（string，必填）：需要读取结果的任务 ID。
- **行为**：
  - 校验 `task_id` 合法性（严格限制只能包含字母、数字、`-`、`_`，防止路径穿越）。
  - 读取 `$AGENT_BRIDGE_ROOT/results/<task_id>.md`。
  - 若结果文件尚未生成，返回状态为等待中（Pending）的说明信息，不报错、不崩溃。
  - 若结果文件已存在，返回文件中的完整结果内容。

---

## 运行维护工具

系统提供了一套完整的运维监控与生命周期管理能力，包括审计日志、任务状态追踪、任务取消、增量日志读取与分页结果读取。

### 1. 运维与监控 MCP 工具

#### `get_task_status`
- **功能**：查询任务当前执行状态及生命周期元数据。
- **参数**：
  - `task_id`（string，必填）：任务 ID。
- **行为**：
  - 严格校验 `task_id` 安全性。
  - 读取 `$AGENT_BRIDGE_ROOT/status/<task_id>.json`，返回包含 `state`（`queued` | `running` | `completed` | `failed` | `cancelled`）、`agent`、`startedAt`、`finishedAt`、`exitCode`、`error` 的完整元数据。
  - 若状态文件不存在，自动基于 `tasks/` 判定为 `queued`，或基于 `results/` 判定为 `completed`；若均不存在则返回任务不存在。
  - **注意**：本工具绝不返回任务结果正文或 prompt 内容。

#### `cancel_task`
- **功能**：请求取消正在排队或正在执行中的任务。
- **参数**：
  - `task_id`（string，必填）：任务 ID。
- **行为**：
  - 检查任务是否已存在于 `results/<task_id>.md` 或其状态已为 `completed`、`failed`、`cancelled`。若已处于终态，则安全忽略并返回已完成提示。
  - 若任务尚未结束，向 `$AGENT_BRIDGE_ROOT/control/<task_id>.cancel` 写入控制取消标记文件。
  - 任务取消由 Worker 轮询控制文件自主完成，MCP Server 自身绝不发送任何系统信号、不操作任何 PID。

#### `read_task_output`
- **功能**：增量分块读取任务执行过程中的标准输出日志。
- **参数**：
  - `task_id`（string，必填）：任务 ID。
  - `offset`（number，可选，默认 0）：读取起始字节偏移。
  - `length`（number，可选，默认 4000，取值范围 1 ~ 16000）：单次读取字节数。
- **行为**：
  - 读取 `$AGENT_BRIDGE_ROOT/logs/<task_id>.out` 文件（Worker 在执行期间实时将标准输出同步写入该文件）。
  - 返回对象包含读取的文本 `content`、下一读取偏移量 `nextOffset`，以及是否到达文件末尾的 `eof` 标记。

#### `read_result_page`
- **功能**：分页切片读取任务的最终执行结果。
- **参数**：
  - `task_id`（string，必填）：任务 ID。
  - `offset`（number，可选，默认 0）：读取起始字节偏移。
  - `length`（number，可选，默认 4000）：单次读取字节数。
- **行为**：
  - 分块读取 `$AGENT_BRIDGE_ROOT/results/<task_id>.md` 文件。
  - 返回对象包含文本切片 `content`、`nextOffset` 以及 `eof` 标记。
  - 专门用于处理超大结果文件，保持 `read_result` 一次性读取功能完整且不被修改。

#### `repo_status`
- **功能**：只读查询指定本地 Git 仓库的分支、工作区状态摘要、关键引用哈希与最近 10 条提交摘要。
- **参数**：无输入参数（不接受客户端传入路径或命令）。
- **仓库路径来源**：严格仅从服务端环境变量 `AGENT_BRIDGE_REPO` 读取；若未设置、非绝对路径、目录不存在或不含 `.git`，均安全返回 `isError: true`。
- **行为与安全约束**：
  - 仅执行代码中严格硬编码的 4 条只读 git 子命令（`status --short --branch`, `rev-parse --abbrev-ref HEAD`, `rev-parse develop main origin/develop origin/main`, `log --oneline -n 10`），禁止任何其他 git 子命令。
  - 显式设置 `shell: false` 与 5000ms 超时，杜绝 Shell 注入；命令环境变量附加 `GIT_OPTIONAL_LOCKS=0`、`GIT_PAGER=cat`、`GIT_TERMINAL_PROMPT=0`。
  - 输出最大长度限制为 8000 字符，超出截断并附加说明。
  - **隐私保护**：绝不返回任何代码 diff、文件内容、Prompt 或结果正文。
  - **审计记录**：调用自动记录到 `$AGENT_BRIDGE_ROOT/logs/audit.log`，仅记录工具名与时间戳，不记录输出内容。

#### `worker_alive_summary`
- **功能**：只读查询本地 Worker 进程的存活状态、PID 以及最后记录的活动时间戳。
- **参数**：无输入参数（不接受客户端传入参数或命令）。
- **行为与安全约束**：
  - 读取 `$AGENT_BRIDGE_ROOT/logs/worker.pid`，仅使用 `process.kill(pid, 0)` 发送信号 0 进行无害的进程存在性探测，**绝不发送任何其他信号**，绝不停止或重启进程。
  - 读取 `$AGENT_BRIDGE_ROOT/logs/worker.log` 尾部，提取最后一条带 ISO 时间戳的记录时间作为 `lastActivity`（注意：Worker 无心跳机制，该时间代表最后记录的操作活动）。
  - 返回结构：`{ running: boolean, pid?: number, lastActivity?: string }`。
  - 绝不暴露系统环境变量、主机信息或任务内容。
  - **审计记录**：调用自动记录到 `$AGENT_BRIDGE_ROOT/logs/audit.log`，仅记录工具名与时间戳，不记录输出内容。

#### `list_tasks_summary`
- **功能**：只读扫描 `$AGENT_BRIDGE_ROOT/status/` 目录，获取最近执行的任务元数据摘要列表。
- **参数**：
  - `limit`（number，可选，默认 20）：返回最近任务的最大条数，系统严格钳制在 1 到 50 之间。
- **行为与安全约束**：
  - 仅按 `startedAt` 时间戳倒序排列，最多返回 50 条。
  - **字段白名单**：每条记录严格只返回 `taskId`、`state`、`agent`、`startedAt`、`finishedAt`、`exitCode`。
  - **绝不返回** `prompt`、`results` 或 `logs` 中的任何正文，杜绝敏感信息泄露。
  - **审计记录**：调用自动记录到 `$AGENT_BRIDGE_ROOT/logs/audit.log`，仅记录工具名与时间戳，不记录输出内容。

### 2. 审计日志 (`$AGENT_BRIDGE_ROOT/logs/audit.log`)
- **文件位置**：固定写入 `$AGENT_BRIDGE_ROOT/logs/audit.log`。
- **日志轮转**：单文件大小达到或超过 10MB 时，自动原子轮转重命名为 `audit.log.1`（仅保留 1 个备份）。
- **隐私与安全声明**：**审计日志严格不含 prompt 和结果正文**。每行均为紧凑的一行 JSON，仅包含受限字段：
  - `tool`（调用的工具名称，如 `send_task`、`read_result`、`worker_exec` 等）
  - `taskId`（任务 ID）
  - `agent`（执行的 Agent 名称，可选）
  - `state`（任务状态变化，可选）
  - `exitCode`（进程退出码，可选）
  - `ts`（ISO 8601 时间戳）

### 3. 任务取消机制
- **完全解耦设计**：MCP Server 与系统底层进程彻底隔离，MCP Server 不调用系统底层信号（如 `kill`），也不接触任何系统 PID。
- **Worker 自主终止流程**：
  1. MCP Client 调用 `cancel_task` 时，Server 仅安全写入标记文件 `$AGENT_BRIDGE_ROOT/control/<task_id>.cancel`。
  2. Worker 在开始执行任务前会先检查该标记；若存在，则直接取消并标记为 `cancelled`，不启动子进程。
  3. 若任务正在执行中，Worker 内部每秒轮询该标记文件；一旦检测到取消文件，Worker 自主清理标记并向自己启动的子进程发送 `SIGTERM` 信号。
  4. 若子进程在 5 秒内仍未退出，Worker 发送 `SIGKILL` 强制终止。
  5. 任务状态被原子写入 `$AGENT_BRIDGE_ROOT/status/<task_id>.json`，状态标注为 `cancelled`。

---

## 完成通知与 wait_task

### 1. `wait_task` 工具
- **功能**：轮询等待指定任务完成并直接返回结果，超时则返回当前运行状态。
- **参数**：
  - `task_id`（string，必填）：任务 ID。
  - `timeout_seconds`（number，可选，默认 20）：等待超时秒数。
- **钳制规则**：取值范围限制在 1 到 25 秒之间（最小值 1，最大值 25）。若传入超出范围的值（如小于 1 或大于 25），系统自动钳制到合法边界并在返回中附加说明。
- **行为**：
  - 每 1 秒轮询检查 `$AGENT_BRIDGE_ROOT/results/<task_id>.md` 文件是否存在。
  - 若在超时时间内结果文件已生成，立即返回完整结果文件内容。
  - 若达到超时时间仍未完成，返回当前任务状态，并明确说明“仍在执行，可再次调用 wait_task”。
  - 单次调用阻塞耗时严格限制在 `timeout_seconds + 1` 秒以内。
  - 自动记录审计日志（仅记录 `tool`、`taskId`、`state`，不泄露结果或 prompt 内容）。

### 2. macOS 桌面完成通知
- **生效平台**：仅在 **macOS (`process.platform === "darwin"`)** 环境下生效。在 Windows 或 Linux 环境下 Worker 会自动跳过通知并记录日志。
- **通知机制**：Worker 在任务进入完成（`completed`）、失败（`failed`）、取消（`cancelled`）或超时（`timeout`）等收尾阶段时，通过 `osascript` 唤起 macOS 系统原生桌面通知。
- **通知禁用方式**：如需关闭桌面通知，只需设置环境变量：
  ```bash
  export AGENT_BRIDGE_NOTIFY=0
  ```
  设置后 Worker 将跳过通知并仅在 `worker.log` 中记录 `Notification disabled by AGENT_BRIDGE_NOTIFY=0`。
- **隐私保护**：通知消息仅包含 `task_id`、执行状态与 `agent` 名称，**严禁且绝不包含** Prompt 指令或结果文本。

---

## 安全约束

1. **严格字符白名单**：`task_id` 只允许 `[a-zA-Z0-9_-]`，任何包含路径分隔符（如 `/`、`\`）、相对跳转（`..`）或其他非法字符的请求将被直接拒绝并报错返回。
2. **根目录路径隔离**：所有文件的最终解析路径都经过二次校验，必须严格位于 `AGENT_BRIDGE_ROOT` 内的 `tasks/` 或 `results/` 子目录下。
3. **只读写安全文本**：本服务仅执行标准文件写入与读取，杜绝一切 Shell 命令执行、文件删除、网络外连或代码自动合并操作。
4. **标准 stdio 隔离**：日志严格输出至 `stderr` 与 `logs/server.log`，绝不污染 `stdout` 的 JSON-RPC 通信流。

---

## 安装与构建

### 1. 安装依赖
```bash
npm install
```

### 2. 编译 TypeScript
```bash
npm run build
```
编译产物将生成在 `dist/` 目录下，入口文件为 `dist/index.js`。

---

## 环境变量配置

- `AGENT_BRIDGE_ROOT`：指定数据根目录路径。
  - 默认值：`~/agent-bridge`（自动展开为当前用户主目录）。
  - 自定义示例：`export AGENT_BRIDGE_ROOT=/custom/path/agent-bridge`。
- `AGENT_BRIDGE_REPO`：指定只读仓库状态工具 `repo_status` 所绑定的本地 Git 仓库绝对路径。
  - 示例：`export AGENT_BRIDGE_REPO=/path/to/your/git/repo`。

---

## 在 Claude Desktop 中配置

在 Claude Desktop 的配置文件中添加本 MCP Server：

### 配置文件位置
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### 配置示例 JSON

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": [
        "/Users/news/code/mcp/agent-bridge-mcp/dist/index.js"
      ],
      "env": {
        "AGENT_BRIDGE_ROOT": "/Users/news/agent-bridge"
      }
    }
  }
}
```

配置后重启 Claude Desktop，即可在对话界面中使用 `send_task`、`wait_task` 与 `read_result` 等工具。

---

## 在 ChatGPT (macOS 桌面端 / Codex) 中配置

本 MCP Server 原生支持通过 Model Context Protocol (MCP) 接入 **ChatGPT macOS 官方桌面客户端**（集成了 OpenAI Codex 运行时）。

### 方式一：命令行一键添加（推荐）

在终端中执行以下命令，即可直接将 `agent-bridge` 注册到 ChatGPT / Codex：

```bash
codex mcp add agent-bridge \
  --env AGENT_BRIDGE_ROOT="$HOME/agent-bridge" \
  -- node "/Users/news/code/mcp/agent-bridge-mcp/dist/index.js"
```

检查注册状态：
```bash
codex mcp get agent-bridge
```

### 方式二：配置文件手动配置 (`~/.codex/config.toml`)

ChatGPT macOS 桌面端使用 `~/.codex/config.toml` 作为其 MCP 配置文件。在文件中添加以下内容：

```toml
[mcp_servers.agent-bridge]
command = "node"
args = [
  "/Users/news/code/mcp/agent-bridge-mcp/dist/index.js"
]

[mcp_servers.agent-bridge.env]
AGENT_BRIDGE_ROOT = "/Users/news/agent-bridge"
```

### 方式三：ChatGPT 桌面端图形界面配置

1. 打开 **ChatGPT** macOS 桌面客户端。
2. 打开 **设置（Settings）**（快捷键 `Cmd + ,`）-> 侧边栏选择 **MCP Servers**（或 **Developer**）。
3. 点击 **Add server**：
   - **Name**: `agent-bridge`
   - **Type**: `STDIO`
   - **Command**: `node`
   - **Arguments**: `/Users/news/code/mcp/agent-bridge-mcp/dist/index.js`
   - **Environment Variables**: `AGENT_BRIDGE_ROOT=/Users/news/agent-bridge`
4. 保存并重启客户端。

### 使用与验证

配置生效后，在 ChatGPT macOS 桌面端中新建对话即可自动发现 MCP 工具：
- `send_task`：派发任务 Prompt 并指定 Agent（如 `codex`）。
- `wait_task`：自动等待任务完成（超时 1-25 秒可调，任务完成时将同步触发 macOS 原生桌面通知）。
- `read_result`：读取任务完整执行结果。
- `get_task_status`：查看任务排队与执行状态。
- `cancel_task`：安全取消正在执行的任务。

---

## 本地 Worker 任务执行器

`agent-bridge-worker` 是一个独立的常驻轮询进程，负责从 `$AGENT_BRIDGE_ROOT/tasks` 目录中取出待执行任务，根据注册表启动对应 Agent 执行，并将结果原子写回 `$AGENT_BRIDGE_ROOT/results`。

### 1. Agent 注册表 (`$AGENT_BRIDGE_ROOT/agents.json`)
必须在数据根目录下配置可用 Agent 注册表（agents.json），格式如下：
```json
{
  "codex": {
    "command": "codex",
    "args": ["exec"],
    "input": "stdin"
  }
}
```
- `command`（string，必填）：可执行命令名称或系统 PATH / 绝对路径。
- `args`（string[]，必填）：命令行参数数组（如非交互执行参数、沙箱参数等）。
- `input`（`"stdin"` | `"arg"`，必填）：Prompt 传递方式：
  - `"stdin"`：提示词通过子进程标准输入传入。
  - `"arg"`：提示词作为最后一个命令行参数追加。

### 2. 防重复执行机制 (`logs/processed.json`)
Worker 采用 **processed.json 记录与结果文件存在性的双重检查** 防重复机制，确保任务执行的幂等性：
1. **记录已处理任务**：Worker 在处理完任务后，会将 `task_id` 与其完成时间（ISO 字符串）写入 `$AGENT_BRIDGE_ROOT/logs/processed.json`。
2. **双重防重复检查**：
   - **第一重（内存与 processed.json）**：轮询任务前检查 `task_id` 是否已存在于 `processed.json` 中，若已记录则直接跳过。
   - **第二重（结果文件存在性）**：检查 `$AGENT_BRIDGE_ROOT/results/<task_id>.md` 是否已存在，若存在同样判定为已完成并跳过，避免重复执行。

### 3. 启动 Worker
```bash
# 使用默认根目录 ~/agent-bridge
npm run worker

# 或指定环境变量
AGENT_BRIDGE_ROOT=/custom/path AGENT_BRIDGE_POLL_MS=3000 npm run worker
```

---

## 本地测试说明

### 1. 自动化集成测试
项目内置了完整的端到端自动化测试脚本，模拟 MCP Client 通过 stdio 传输与 Server 交互：

```bash
npm test
```

该测试覆盖：
- 工具列表发现 (`tools/list`)
- 任务派发 (`send_task`) 及 `tasks/<task_id>.md` 文件生成验证
- 未生成结果时的状态读取 (`read_result` pending 状态验证)
- 手动写入模拟结果后的结果读取 (`read_result` 内容匹配验证)
- 不存在的 `task_id` 查询容错验证
- 针对 `../etc/passwd` 等路径穿越攻击的拒绝拦截验证

### 2. 手动测试流程验证 `read_result`

1. **派发任务**：在客户端（或测试脚本）调用 `send_task`，获取返回的 `task_id`（例如 `task_1793154494790_ua2g0w`）。
2. **验证任务文件**：
   ```bash
   cat ~/agent-bridge/tasks/task_1793154494790_ua2g0w.md
   ```
3. **测试未完成状态**：直接调用 `read_result` 传入该 `task_id`，将返回：
   ```text
   Status: Pending. Result not ready yet for task "task_1793154494790_ua2g0w". (Result file "..." does not exist)
   ```
4. **手动创建结果文件模拟本地 Agent 完成任务**：
   ```bash
   mkdir -p ~/agent-bridge/results
   cat << 'EOF' > ~/agent-bridge/results/task_1793154494790_ua2g0w.md
   # Execution Result

   Task completed successfully by local agent.
   - Output: All tests passed.
   EOF
   ```
5. **再次调用 `read_result`**：传入该 `task_id`，即可读取到上述 Markdown 结果内容。
