# Windows 平台交接与支持指南 (Windows Support & Handoff Guide)

> **核心结论**：Windows 端开发与部署的唯一标准起点分支是 **`develop`**（或最新合并的 `main`），**严禁从历史的旧分支 `feat/windows-handoff` 起点切出**（该历史分支已落后主线 37+ 个提交，缺少云端中继、ChatGPT 插件、模型发现和一键自动部署等所有核心架构）。

---

## 1. 架构与跨平台支持现状

目前项目已在 `develop` 分支上完成了针对 Windows (win32) 平台的系统级适配：

1. **跨平台一键部署脚本 (`scripts/auto-setup.mjs`)**：
   - **CLI 探测**：自动识别平台，Windows 下使用 `where`，macOS/Linux 下使用 `which`；自动将 MCP 注册到本地安装的 `codex` / `agy`。
   - **开机自启守护**：
     - macOS：生成 `Library/LaunchAgents/com.agent-bridge.relay.plist`。
     - Windows：自动向用户自启动目录（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）写入静默启动 VBS 脚本 `agent-bridge.vbs`（以窗口模式 `0` 后台运行，完全无黑框弹窗），并立即在后台静默拉起连接进程。
   - **插件压缩包打包**：
     - macOS/Linux：使用系统 `zip`。
     - Windows：自动调用原生 PowerShell `Compress-Archive`，一键生成桌面专属 `agent-bridge-plugin.zip`。

2. **跨平台任务执行引擎 (`src/worker.ts`)**：
   - **环境变量解析**：Windows 下严格按 `;`（分号）分割和合并 `PATH`，避免 Windows 盘符（如 `C:\`）被 `:` 破坏；自动纳入 `%APPDATA%\npm` 等全局目录。
   - **命令启动适配**：Windows 平台支持 `.cmd` 与批处理包装脚本，通过标准流 `stdin` 传递 Prompt，避免 `cmd.exe` 变量展开与注入攻击。
   - **进程安全终止**：超时或取消任务时，Windows 下调用系统级 `taskkill /T [/F] /PID`，确保整个进程树（含其衍生子进程）彻底退出，不留孤儿进程。

3. **系统信息与监控 (`src/device-info.ts` & `src/models.ts`)**：
   - 磁盘容量统计：Windows 下使用系统当前根盘符（如 `C:\`）调用 `fs.statfsSync`。
   - 进程数量统计：Windows 下自动适配 `tasklist /fo csv /nh`。
   - 模型发现：支持读取 Windows 用户目录下的 `~/.codex/config.toml` 与 `models_cache.json`。

---

## 2. Windows 开发者接入与验证指南

接手或在 Windows 电脑上运行的开发者只需执行以下标准流程：

### 第一步：克隆或切换到最新 `develop` 分支
```bash
git checkout develop
git pull origin develop
```

### 第二步：一键全自动部署 (Turnkey Auto-Setup)
在项目根目录下直接运行：
```bash
npm run auto-setup
```
脚本将全自动完成：
1. `npm install` 依赖安装与 TypeScript 编译；
2. 生成专属高强度 192-bit 设备码 (`dev_<48hex>`)；
3. 检测本地 `codex` 与 `agy`，自动执行 `codex mcp add`；
4. 部署 Windows 开机自启脚本 `agent-bridge.vbs` 并拉起后台连接；
5. 在 Windows 桌面上生成 `agent-bridge-plugin.zip` 供 ChatGPT 导入。

### 第三步：运行全量自动化测试套件
```bash
npm test
npm run test:worker
npm run test:http
```
测试框架通过 `scripts/run-env.mjs` 自动管理隔离环境变量，无需手动设置 `set` 或 `$env:`。

---

## 3. 分支与 PR 提交规范

## 3. 分支与 PR 提交规范

- **开发起点**：必须基于最新 **`origin/develop`** 创建特性分支（如 `feat/windows-e2e-verification`）。
- **PR 目标分支**：统一提交并合并回 **`develop`**。待完整测试验证后再同步合并至 `main`。

---

## 4. 已知注意事项与跨平台保障

1. **路径与盘符**：跨盘符移动文件在 Windows 下无法使用原子 `rename`。因此任务工作区与结果目录统一默认保持在同一用户数据盘符（即 `%USERPROFILE%\agent-bridge`）。
2. **命令注入防御**：任务 Prompt 始终优先走子进程 `stdin` 流式管道输入，绝不直接将未经验证的任意 Prompt 拼接到命令行 argv 中。
3. **多客户端兼容**：本地无论安装了 `codex` 还是 `agy`，执行 `npm run auto-setup` 均能自适应挂载；云端 ChatGPT 通过 `agent-bridge-plugin.zip` 一键导入即可无缝接管 Windows 终端任务。
