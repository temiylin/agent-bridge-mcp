/**
 * Self-contained HTML/CSS/JS generator for the Agent Bridge Local Web Dashboard.
 * Zero external CDN dependencies (works completely offline and fast on localhost).
 */

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Bridge 本机智能调度控制台</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131c2e;
      --card-border: #1e293b;
      --input-bg: #0f172a;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --accent-glow: rgba(56, 189, 248, 0.2);
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.2);
      --purple: #a855f7;
      --yellow: #f59e0b;
      --red: #ef4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: var(--font);
      line-height: 1.5;
      padding-bottom: 90px;
    }

    /* Header */
    header {
      background: linear-gradient(180deg, #162035 0%, #0d1527 100%);
      border-bottom: 1px solid var(--card-border);
      padding: 24px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-logo {
      width: 42px;
      height: 42px;
      background: linear-gradient(135deg, #38bdf8 0%, #a855f7 100%);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 0 16px var(--accent-glow);
    }

    .brand-title h1 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .brand-title p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .status-badges {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
    }

    .badge-online {
      background: var(--green-glow);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.3);
    }

    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #34d399;
      box-shadow: 0 0 8px #34d399;
    }

    /* Container */
    .container {
      max-width: 1100px;
      margin: 28px auto;
      padding: 0 24px;
    }

    /* Hero / Access Bar */
    .access-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 24px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }

    .access-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .access-label {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .access-val {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      color: var(--accent);
      background: var(--input-bg);
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid #1e293b;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .btn-copy {
      background: rgba(255, 255, 255, 0.08);
      border: none;
      color: var(--text-main);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      margin-left: auto;
      transition: background 0.15s;
    }

    .btn-copy:hover {
      background: var(--accent);
      color: #0b0f19;
    }

    /* Tabs */
    .tab-bar {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 24px;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }

    .tab-btn:hover {
      color: var(--text-main);
    }

    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    .tab-pane {
      display: none;
    }

    .tab-pane.active {
      display: block;
    }

    /* Section Card */
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-desc {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 18px;
    }

    /* Forms */
    .form-group {
      margin-bottom: 18px;
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
      color: #cbd5e1;
    }

    input[type="text"], select, textarea {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      color: var(--text-main);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      font-family: inherit;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    input[type="text"]:focus, select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-glow);
    }

    textarea {
      min-height: 90px;
      resize: vertical;
      line-height: 1.6;
    }

    /* Rules Table / Cards */
    .rules-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 14px;
    }

    .rule-card {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      position: relative;
    }

    .rule-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .rule-title {
      font-size: 15px;
      font-weight: 700;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .agent-tag {
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-family: monospace;
      font-weight: 600;
    }

    .agent-tag.agy {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border-color: rgba(168, 85, 247, 0.3);
    }

    .keywords-box {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .keyword-pill {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid #334155;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      color: #cbd5e1;
    }

    .rule-actions {
      display: flex;
      gap: 8px;
    }

    .btn-del {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .btn-del:hover {
      background: rgba(239, 68, 68, 0.3);
    }

    /* Agent Registry Cards */
    .agent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
      margin-top: 14px;
    }

    .agent-box {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .agent-box-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .agent-name-lg {
      font-size: 16px;
      font-weight: 700;
      color: #f8fafc;
    }

    .agent-cmd-box {
      background: #090d16;
      border: 1px solid #1e293b;
      padding: 8px 12px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      color: #94a3b8;
      overflow-x: auto;
    }

    .probe-result {
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 6px;
      display: none;
    }

    .probe-result.success {
      display: block;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .probe-result.fail {
      display: block;
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    /* Buttons */
    .btn-primary {
      background: var(--accent);
      color: #0b0f19;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
      box-shadow: 0 0 12px var(--accent-glow);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--card-border);
      color: var(--text-main);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s;
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    /* Sticky Bottom Bar */
    .bottom-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(13, 21, 39, 0.95);
      backdrop-filter: blur(12px);
      border-top: 1px solid var(--card-border);
      padding: 14px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 100;
    }

    .save-hint {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Toast Notification */
    #toast {
      position: fixed;
      top: 24px;
      right: 24px;
      background: #10b981;
      color: #ffffff;
      padding: 12px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.4);
      transform: translateY(-50px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 999;
      pointer-events: none;
    }

    #toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    /* System Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-top: 14px;
    }

    .stat-card {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px;
    }

    .stat-num {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      margin-top: 4px;
      font-family: monospace;
    }
  </style>
</head>
<body>

  <!-- Top Header -->
  <header>
    <div class="brand">
      <div class="brand-logo">⚡</div>
      <div class="brand-title">
        <h1>Agent Bridge 本机智能调度控制台</h1>
        <p>本地 AI Agent 场景路由偏好与执行环境管理</p>
      </div>
    </div>
    <div class="status-badges">
      <div class="badge badge-online">
        <span class="badge-dot"></span>
        <span>本地控制台已激活 (Port 38080)</span>
      </div>
    </div>
  </header>

  <div class="container">
    <!-- Top Access Bar -->
    <div class="access-card">
      <div class="access-item">
        <span class="access-label">本机专属识别码 (Device Token)</span>
        <div class="access-val">
          <span id="txt-token">加载中...</span>
          <button class="btn-copy" onclick="copyText('txt-token')">复制</button>
        </div>
      </div>
      <div class="access-item">
        <span class="access-label">云端 MCP 接入地址 (用于 ChatGPT)</span>
        <div class="access-val">
          <span id="txt-url">加载中...</span>
          <button class="btn-copy" onclick="copyText('txt-url')">复制</button>
        </div>
      </div>
    </div>

    <!-- Tab Bar -->
    <div class="tab-bar">
      <button class="tab-btn active" onclick="switchTab('tab-routing', this)">🎯 调度偏好与场景规则</button>
      <button class="tab-btn" onclick="switchTab('tab-agents', this)">🤖 本地 Agent 注册 (agents.json)</button>
      <button class="tab-btn" onclick="switchTab('tab-system', this)">💻 硬件监控与诊断</button>
    </div>

    <!-- Tab 1: Routing & Instructions -->
    <div id="tab-routing" class="tab-pane active">
      <!-- Section 1: Global Instructions -->
      <div class="section-card">
        <div class="section-title">
          <span>📝 全局分发指导说明 (AI Dispatch Instructions)</span>
        </div>
        <p class="section-desc">
          在这里写下您期望 AI 遵循的分发习惯与场景规则。此说明会自动同步给 ChatGPT 及外部调用者，作为其自动判断任务归属的首要原则。
        </p>
        <div class="form-group">
          <textarea id="inp-instructions" placeholder="例如：涉及后端接口、服务端逻辑、数据库、系统脚本的开发任务走 codex；涉及前端界面、UI 组件、Vue、React、CSS交互走 agy。"></textarea>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>默认兜底 Agent (Default Fallback Agent)</label>
          <select id="sel-default-agent" style="max-width:320px"></select>
          <p class="section-desc" style="margin-top:6px; margin-bottom:0">
            当外部请求未显式指定 Agent，且未能命中任何特定关键词规则时，自动指派至此 Agent。
          </p>
        </div>
      </div>

      <!-- Section 2: Scenario Rules -->
      <div class="section-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:12px;">
          <div>
            <div class="section-title">⚡ 场景与关键词路由表 (Keyword Routing Rules)</div>
            <p class="section-desc" style="margin-bottom:0">
              当任务内容（Prompt）中包含以下关键词时，底层任务派发中心将自动路由到对应的 Agent 执行。
            </p>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn-secondary" onclick="loadDefaultTemplate()">🪄 载入经典模版</button>
            <button class="btn-secondary" onclick="addNewRuleModal()">+ 添加场景规则</button>
          </div>
        </div>

        <div id="rules-container" class="rules-list"></div>
      </div>
    </div>

    <!-- Tab 2: Local Agents (agents.json) -->
    <div id="tab-agents" class="tab-pane">
      <div class="section-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:8px;">
          <div>
            <div class="section-title">🤖 已配置的本地执行 Agent</div>
            <p class="section-desc" style="margin-bottom:0">
              对应本机 <code>~/agent-bridge/agents.json</code> 文件。后台 Worker 进程将调用这些命令行工具执行实际任务。
            </p>
          </div>
          <button class="btn-secondary" onclick="addAgentModal()">+ 注册新 Agent</button>
        </div>

        <div id="agents-container" class="agent-grid"></div>
      </div>
    </div>

    <!-- Tab 3: System & Status -->
    <div id="tab-system" class="tab-pane">
      <div class="section-card">
        <div class="section-title">💻 宿主机环境与硬件概览</div>
        <p class="section-desc">当前运行 Agent Bridge 的物理机器实时运行指标。</p>
        <div id="system-stats" class="stats-grid"></div>
      </div>
      <div class="section-card">
        <div class="section-title">🔍 本地诊断接口快捷直达</div>
        <p class="section-desc">用于验证本地服务各项传输层与状态健康度。</p>
        <div style="display:flex; gap:12px; flex-wrap:wrap;">
          <a href="/health" target="_blank" class="btn-secondary">🩺 健康检测 (/health)</a>
          <a href="/status" target="_blank" class="btn-secondary">📊 服务状态 (/status)</a>
          <a href="/mcp" target="_blank" class="btn-secondary">🔌 MCP 端点 (/mcp)</a>
        </div>
      </div>
    </div>
  </div>

  <!-- Sticky Bottom Save Bar -->
  <div class="bottom-bar">
    <div class="save-hint">💡 任何修改保存后将直接写盘，即刻生效，无需重启服务。</div>
    <button class="btn-primary" onclick="saveAllConfig()">💾 保存配置并即刻生效</button>
  </div>

  <!-- Toast -->
  <div id="toast">✅ 操作成功！</div>

  <script>
    let currentConfig = {
      deviceToken: "",
      deviceUrl: "",
      agents: {},
      routing: {
        defaultAgent: "codex",
        instructions: "",
        rules: []
      }
    };

    function copyText(elementId) {
      const text = document.getElementById(elementId).textContent;
      navigator.clipboard.writeText(text).then(() => {
        showToast("📋 已复制到剪贴板: " + text);
      });
    }

    function showToast(msg) {
      const toast = document.getElementById("toast");
      toast.textContent = msg || "✅ 操作成功！";
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2500);
    }

    function switchTab(tabId, btn) {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      if (btn) btn.classList.add("active");
      const target = document.getElementById(tabId);
      if (target) target.classList.add("active");
    }

    async function loadData() {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) throw new Error("获取配置失败");
        currentConfig = await res.json();

        document.getElementById("txt-token").textContent = currentConfig.deviceToken || "dev_default";
        document.getElementById("txt-url").textContent = currentConfig.deviceUrl || "http://localhost:38080/mcp";

        // Instructions & Default Agent
        document.getElementById("inp-instructions").value = currentConfig.routing.instructions || "";
        renderDefaultAgentSelect();

        // Rules
        renderRules();

        // Agents
        renderAgents();

        // Load System Stats
        loadSystemStats();
      } catch (err) {
        console.error("加载配置失败:", err);
      }
    }

    function renderDefaultAgentSelect() {
      const sel = document.getElementById("sel-default-agent");
      sel.innerHTML = "";
      const agentNames = Object.keys(currentConfig.agents);
      if (agentNames.length === 0) {
        agentNames.push("codex", "agy");
      }
      agentNames.forEach(name => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name + (name === "codex" ? " (Codex 默认引擎)" : name === "agy" ? " (Antigravity 引擎)" : "");
        if (name === currentConfig.routing.defaultAgent) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    function renderRules() {
      const container = document.getElementById("rules-container");
      container.innerHTML = "";

      if (!currentConfig.routing.rules || currentConfig.routing.rules.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:20px;">暂无特定场景规则。请点击上方按钮添加或载入推荐模版。</div>';
        return;
      }

      currentConfig.routing.rules.forEach((rule, idx) => {
        const card = document.createElement("div");
        card.className = "rule-card";

        const header = document.createElement("div");
        header.className = "rule-header";

        const title = document.createElement("div");
        title.className = "rule-title";

        const titleSpan = document.createElement("span");
        titleSpan.textContent = rule.scenario || "未命名场景";

        const agentSpan = document.createElement("span");
        agentSpan.className = "agent-tag " + (rule.agent === "agy" ? "agy" : "");
        agentSpan.textContent = "目标: " + (rule.agent || "codex");

        title.appendChild(titleSpan);
        title.appendChild(agentSpan);

        const actions = document.createElement("div");
        actions.className = "rule-actions";

        const delBtn = document.createElement("button");
        delBtn.className = "btn-del";
        delBtn.textContent = "🗑️ 删除";
        delBtn.onclick = function() { deleteRule(idx); };
        actions.appendChild(delBtn);

        header.appendChild(title);
        header.appendChild(actions);

        const kwBox = document.createElement("div");
        kwBox.className = "keywords-box";
        (rule.keywords || []).forEach(kw => {
          const pill = document.createElement("span");
          pill.className = "keyword-pill";
          pill.textContent = kw;
          kwBox.appendChild(pill);
        });

        const desc = document.createElement("div");
        desc.style.fontSize = "13px";
        desc.style.color = "var(--text-muted)";
        desc.textContent = rule.description || "无详细描述";

        card.appendChild(header);
        card.appendChild(kwBox);
        card.appendChild(desc);
        container.appendChild(card);
      });
    }

    function deleteRule(idx) {
      currentConfig.routing.rules.splice(idx, 1);
      renderRules();
    }

    function addNewRuleModal() {
      const scenario = prompt("请输入场景名称（例如：移动端开发 / 爬虫任务）：");
      if (!scenario) return;
      const agent = prompt("目标执行 Agent 名称（例如 codex 或 agy）：", "codex");
      if (!agent) return;
      const kws = prompt("触发关键词（用逗号隔开，例如：app,ios,android,react-native）：", "");
      const keywords = (kws || "").split(/[,，]/).map(k => k.trim()).filter(Boolean);
      const description = prompt("场景简要说明：", scenario + " 任务优先派发给 " + agent);

      currentConfig.routing.rules.push({
        id: "rule_" + Date.now(),
        scenario,
        agent,
        keywords,
        description: description || ""
      });
      renderRules();
    }

    function loadDefaultTemplate() {
      currentConfig.routing.instructions = "涉及后端架构、服务端接口、数据库、系统脚本的开发任务走 codex；涉及前端界面、UI 组件、Vue/React、CSS 与页面展示的任务走 agy。";
      document.getElementById("inp-instructions").value = currentConfig.routing.instructions;
      currentConfig.routing.defaultAgent = "codex";
      renderDefaultAgentSelect();

      currentConfig.routing.rules = [
        {
          id: "rule_backend",
          scenario: "后端及数据服务",
          keywords: ["后端", "backend", "api", "database", "数据库", "server", "服务", "node", "python", "go", "sql", "redis"],
          agent: "codex",
          description: "后端开发、接口与数据库任务优先由 Codex 处理"
        },
        {
          id: "rule_frontend",
          scenario: "前端与界面交互",
          keywords: ["前端", "frontend", "ui", "界面", "vue", "react", "css", "html", "web", "样式", "组件", "页面", "tailwind"],
          agent: "agy",
          description: "前端页面、UI 组件与可视化交互任务优先由 Antigravity (agy) 处理"
        },
        {
          id: "rule_testing",
          scenario: "测试与代码审查",
          keywords: ["测试", "test", "unittest", "review", "审查", "lint", "规范"],
          agent: "codex",
          description: "自动化测试与代码静态检查由 Codex 处理"
        }
      ];
      renderRules();
      showToast("🪄 推荐模版已载入！请点击下方「保存配置」使之生效。");
    }

    function renderAgents() {
      const container = document.getElementById("agents-container");
      container.innerHTML = "";

      Object.entries(currentConfig.agents).forEach(([name, cfg]) => {
        const box = document.createElement("div");
        box.className = "agent-box";

        const header = document.createElement("div");
        header.className = "agent-box-header";

        const nameSpan = document.createElement("span");
        nameSpan.className = "agent-name-lg";
        nameSpan.textContent = "🤖 " + name;

        const tagSpan = document.createElement("span");
        tagSpan.className = "agent-tag " + (name === "agy" ? "agy" : "");
        tagSpan.textContent = "输入: " + (cfg.input || "stdin");

        header.appendChild(nameSpan);
        header.appendChild(tagSpan);

        const cmdBox = document.createElement("div");
        cmdBox.className = "agent-cmd-box";
        cmdBox.textContent = cfg.command + " " + (cfg.args || []).join(" ");

        const actionRow = document.createElement("div");
        actionRow.style.cssText = "display:flex; gap:8px; align-items:center;";

        const probeBtn = document.createElement("button");
        probeBtn.className = "btn-secondary";
        probeBtn.style.cssText = "font-size:12px; padding:6px 12px;";
        probeBtn.textContent = "🔍 测试连通性";

        const resBox = document.createElement("div");
        resBox.id = "probe-" + name;
        resBox.className = "probe-result";

        probeBtn.onclick = function() {
          testAgent(name, probeBtn, resBox);
        };

        actionRow.appendChild(probeBtn);

        box.appendChild(header);
        box.appendChild(cmdBox);
        box.appendChild(actionRow);
        box.appendChild(resBox);

        container.appendChild(box);
      });
    }

    async function testAgent(agentName, btn, resBox) {
      btn.disabled = true;
      btn.textContent = "检测中...";
      try {
        const res = await fetch("/api/test-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: agentName })
        });
        const data = await res.json();
        if (data.available) {
          resBox.className = "probe-result success";
          resBox.textContent = "✅ 可执行文件就绪: " + (data.path || agentName) + " (状态码: 0)";
        } else {
          resBox.className = "probe-result fail";
          resBox.textContent = "⚠️ 未在系统 PATH 中检测到命令: " + (data.message || "找不到可执行文件");
        }
      } catch (err) {
        resBox.className = "probe-result fail";
        resBox.textContent = "❌ 检测异常: " + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "🔍 测试连通性";
      }
    }

    function addAgentModal() {
      const name = prompt("请输入新 Agent 名称（如 python-agent）：");
      if (!name) return;
      const cmd = prompt("执行命令（如 python3 或 bash）：", "python3");
      if (!cmd) return;
      const argsRaw = prompt("参数列表（空格隔开，可为空）：", "");
      const args = (argsRaw || "").split(" ").map(s => s.trim()).filter(Boolean);
      const input = prompt("输入方式 (stdin 或 arg)：", "stdin") === "arg" ? "arg" : "stdin";

      currentConfig.agents[name] = {
        command: cmd,
        args,
        input
      };
      renderAgents();
      renderDefaultAgentSelect();
      showToast("已添加 Agent: " + name + "，请点击「保存配置」写入 agents.json。");
    }

    async function loadSystemStats() {
      const grid = document.getElementById("system-stats");
      try {
        const res = await fetch("/api/system");
        if (!res.ok) return;
        const data = await res.json();
        grid.innerHTML = 
          '<div class="stat-card"><div class="access-label">操作系统</div><div class="stat-num">' + (data.platform || "macOS") + ' (' + (data.arch || "arm64") + ')</div></div>' +
          '<div class="stat-card"><div class="access-label">CPU 规格</div><div class="stat-num">' + (data.cpuModel || "Apple Silicon") + ' (' + (data.cores || 8) + ' Cores)</div></div>' +
          '<div class="stat-card"><div class="access-label">内存状况</div><div class="stat-num">' + (data.freeMemGb || 0) + ' GB 可用 / ' + (data.totalMemGb || 0) + ' GB</div></div>' +
          '<div class="stat-card"><div class="access-label">后台守护进程</div><div class="stat-num" style="color:#34d399">● 运行中 (PID: ' + (data.workerPid || "Active") + ')</div></div>';
      } catch (e) {}
    }

    async function saveAllConfig() {
      const instructions = document.getElementById("inp-instructions").value;
      const defaultAgent = document.getElementById("sel-default-agent").value;

      currentConfig.routing.instructions = instructions;
      currentConfig.routing.defaultAgent = defaultAgent;

      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agents: currentConfig.agents,
            routing: currentConfig.routing
          })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "保存失败");
        showToast("✅ 配置保存成功！规则已即刻生效。");
      } catch (err) {
        alert("保存失败: " + err.message);
      }
    }

    loadData();
  </script>
</body>
</html>`;
}
