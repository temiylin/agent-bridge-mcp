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
  └── logs/       # Server 操作日志：server.log
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

配置后重启 Claude Desktop，即可在对话界面中使用 `send_task` 和 `read_result` 工具。

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
