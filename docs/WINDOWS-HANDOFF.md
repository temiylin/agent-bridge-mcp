# Windows 平台交接文档 (Windows Handoff Document)

> **重要说明**：本项目核心功能及跨平台一键安装脚本（`scripts/setup.mjs`）已在 **macOS** 环境下完成全链路实测验证。由于当前开发机为 macOS 环境，所有 `win32` 相关的分支逻辑（如 `npm.cmd` 调用、`%APPDATA%` 路径推导、`where` 命令探测、`taskkill` 进程停止等）**代码已就绪但标注为“未实测”**。本交接文档为接手的 Windows 环境开发/验证 AI 提供完整的背景、清单、规范及验收约束。

---

## 1. 项目目标与架构简述

`agent-bridge-mcp` 是一个通用本地 MCP Server 及任务调度框架，旨在将客户端（如 Claude Desktop）与本地各种命令行 Agent（如 Codex、Gemini 等）解耦桥接。

### 核心架构组件：
1. **MCP Server (`src/index.ts`)**：
   - 暴露 `send_task` 工具：接收 prompt 与可选的 agent 名称，校验并在 `$AGENT_BRIDGE_ROOT/tasks/<task_id>.md` 生成待办任务文件。
   - 暴露 `read_result` 工具：读取 `$AGENT_BRIDGE_ROOT/results/<task_id>.md`。若未就绪返回明确 pending 状态，严防路径穿越（严格的白名单与安全解析校验）。
2. **本地 Worker 任务执行器 (`src/worker.ts` & `dist/worker.js`)**：
   - 独立的常驻后台轮询进程，通用且不绑定任何特定业务。
   - 轮询 `tasks/` 目录，按任务中指定的 `agent` 名称从 `agents.json` 注册表中取出命令执行。
   - 双重防重复机制（`logs/processed.json` 记录 + `results/` 文件存在性检查），保证任务幂等性。
   - 超时强杀机制（发送 SIGTERM / taskkill 并在超时后兜底处理）。
   - 原子化写入：结果先写入 `.tmp` 文件，完成后再原子重命名到目标结果文件。
3. **Agent 注册表 (`$AGENT_BRIDGE_ROOT/agents.json`)**：
   - 配置每个 agent 的 `command`、`args` 及 `input`（`"stdin"` 或 `"arg"`）。由用户维护，系统模板绝不覆盖已有真实配置。
4. **跨平台一键安装与控制脚本 (`scripts/setup.mjs`)**：
   - 单一入口脚本（纯 Node.js 内置模块实现，零额外依赖），提供 `setup`（含 `--dry-run`）、`start`、`stop`、`status` 四个跨平台子命令。

---

## 2. 当前已完成部分与 macOS 实测结果

在 macOS 上，以下全部测试均已 100% 真实通过（所有测试均在 `/tmp` 临时隔离目录中运行，绝不污染真实生产目录）：

1. **MCP Server 端到端自动化测试 (`npm test`)**：
   - `test/test-runner.ts`：覆盖工具发现、`send_task` 调度、pending 读取、模拟结果读取、非存在任务容错、`../etc/passwd` 路径穿越拦截。
2. **Worker 综合测试套件 (`npm run test:worker`)**：
   - `test/worker-test.ts`（全部 9 项测试 PASS）：
     - Test 1: `echo-stdin` 管道输入回显执行
     - Test 2: `echo-arg` 命令行参数回显执行
     - Test 3: 重复任务防护（断言 `worker.log` 中恰好执行 1 次且存在于 `processed.json`）
     - Test 4: `fail-agent` 异常退出码捕获，worker 保持稳定存活
     - Test 5: 忽略 SIGTERM 的超时子进程 5 秒后被 SIGKILL 强杀，断言执行时间约 6 秒且日志包含 SIGKILL
     - Test 6: 非法任务文件名过滤跳过，且仅警告 1 次不刷屏
     - Test 7: 未注册 Agent 标记失败且拒绝执行任何命令
     - Test 8: 原子写入检查，断言 `results/` 下 0 残留 `.tmp` 文件
     - Test 9: MCP `send_task` 拒绝未注册 Agent 并输出可用 Agent 列表
3. **真实 Codex 只读 E2E 测试 (`npm run test:e2e-codex`)**：
   - 自动生成 codex 注册表（`--sandbox read-only`），派发 `PONG` 任务，实测 codex 正常返回并断言通过。
4. **真实 Codex 写文件 E2E 测试 (`npm run test:e2e-codex-write`)**：
   - 自动生成 codex 注册表（`--sandbox workspace-write`），在隔离 `workdir` 下实测 codex 成功创建 `hello.txt` 并写入 `WRITE_OK`。
5. **跨平台安装与控制脚本 (`scripts/setup.mjs`)**：
   - 验证 `setup --dry-run` 零写入特性。
   - 验证 `setup` 目录创建、构建编译、Claude 配置安全合并与备份、幂等性跳过。
   - 验证后台 detached 启动、PID 记录、状态检测、优雅停止。

---

## 3. 需要 Windows AI 完成的工作清单

接手本任务的 Windows 环境 AI 需依次完成以下工作：

### A. 验证 `setup.mjs` 在 Windows 上的基础分支
- **`npm.cmd` 调用**：验证 `child_process.spawn("npm.cmd", ["install"], { shell: false })` 在 Windows 下能否正确调用 npm 并完成构建。
- **配置路径推导**：验证在未设置 `CLAUDE_CONFIG_PATH` 时，能否正确解析 `%APPDATA%\Claude\claude_desktop_config.json`。
- **`where` 探测**：验证 `where codex` 能否正确检测本地安装的 Codex。

### B. 解决 Codex 在 Windows 上的 `.cmd` 包装执行问题（重点）
- **问题分析**：在 Windows 上，许多全局 npm 包或 CLI 工具实际是 `.cmd` 或 `.bat` 批处理脚本（例如 `codex.cmd`）。Node.js 的 `child_process.spawn` 在 `shell: false` 下直接执行 `.cmd` 文件会报错 `EINVAL` 或找不到程序。
- **严格约束**：
  - **代码不解析 `.cmd` 文件**；
  - **Worker 必须始终维持 `shell: false`**，严禁使用 `shell: true` 或拼接字符串给 shell，以防止 Windows `cmd.exe` 变量展开或命令注入；Prompt 通过 `stdin` 流式写入或固定作为最后一个 argv 传递。
- **解决方案规范**：
  - 由用户在 `agents.json` 中直接配置可执行文件的绝对路径，或配置 `node` 绝对路径加脚本入口路径的参数数组。
  - 示例配置（使用占位符，配置时请替换为本地实际绝对路径）：
    ```json
    {
      "codex": {
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": [
          "C:\\Users\\<username>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\dist\\cli.js",
          "exec",
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check"
        ],
        "input": "stdin"
      }
    }
    ```
- **工作要求**：Windows AI 必须先在 Windows 终端上通过 `where codex`、查看包装脚本或 npm 全局路径，**确认 Codex 的真实可执行入口文件绝对路径**，然后再写入说明与文档，**严禁猜测路径**。

### C. 验证 `stop` 子命令在 win32 上的 `taskkill` 行为
- 在 `setup.mjs` 中，Windows 的 `stop` 实现为：
  `spawnSync("taskkill", ["/T", "/PID", String(pid)], { shell: false, windowsHide: true })`
- 验证其能否优雅停止 worker 及其子进程，确认**不带 `/F`** 强制杀进程参数。

### D. 路径分隔符、换行符与文件系统原子性
- 验证 Windows 反斜杠 `\` 在路径拼接中是否引发转义异常。
- 验证 `fs.renameSync` 在 Windows 上的原子性：在 Windows 上，若目标文件被其他进程以共享方式打开，`fs.renameSync` 可能会抛出 `EPERM`。需确认 worker 写结果文件时不会因被杀软或系统索引锁定而崩溃。

### E. 运行测试套件（隔离执行）
- 统一使用 `npm test` 与 `npm run test:worker` 进行测试：
  ```cmd
  npm test
  npm run test:worker
  ```
- **说明**：测试脚本已通过 `scripts/run-env.mjs` 自动注入隔离环境变量（如 `AGENT_BRIDGE_ROOT`），在 Windows 上无需手动 `set` 或 export 环境变量，直接运行上述 npm 命令即可跨平台统一执行。
- 确认所有测试断言全部 PASS。

### F. 真实 Codex 端到端验证（如本地已安装 Codex）
- 执行 `npm run test:e2e-codex`。
- 执行 `npm run test:e2e-codex-write`。

---

## 4. 核心安全与设计约束（不得修改）

1. **v1 核心保护**：
   - 严禁修改 `src/index.ts` 中的 `read_result` 逻辑。
   - 严禁修改 `src/validator.ts` 中的 `resolveSafePath` 路径校验逻辑。
2. **进程安全原则**：
   - Worker 启动外部 Agent 进程时必须维持 `shell: false`，所有参数必须为纯字符串数组传递，Prompt 优先通过 `stdin` 流式写入。
3. **注册表自主原则**：
   - `agents.json` 的配置权属于用户。代码只在文件不存在时写入模板，一旦存在绝不自动改写或覆盖真实的 `agents.json`。

---

## 5. 提交与 PR 规范

- **分支规范**：
  - Windows 特性分支必须从 `origin/feat/windows-handoff` 创建（例如 `git checkout -b feat/windows-support origin/feat/windows-handoff`），**不得从 `feat/worker-agent-registry` 创建**。
  - **PR 的基础分支（Base Branch）必须设为 `feat/windows-handoff`**。
  - **分支合并流程说明**：Windows AI 提交的 PR 将合并入 `feat/windows-handoff`；待 Windows 验证完成后，`feat/windows-handoff` 统一合并到 `feat/worker-agent-registry`，最终再统一合并回 `main`。
- **PR 描述要求**：
  - 必须完整附带 Windows 终端上的实测执行记录（包括 `node scripts/setup.mjs setup`、`npm test`、`npm run test:worker` 的完整终端输出与退出码）。
  - 对 Windows 上处理 `.cmd` 启动与注册表配置做出明确说明与验证记录。

---

## 6. 已知风险提示

1. **路径与盘符限制**：跨盘符移动文件在 Windows 下无法使用原子 `rename`。测试时临时根目录应与项目工作区位于同一盘符（通常为 `C:`）。
2. **Codex CLI 沙箱支持**：Codex 在 Windows 下的 `--sandbox workspace-write` 是否支持与 macOS 完全一致，需要 Windows 实测验证。
3. **Claude Desktop 配置文件权限**：Windows 上 Claude 可能会在启动时加锁其配置文件，请在 Claude 完全退出状态下进行配置写入。
