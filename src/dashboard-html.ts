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
      width: 100%;
      max-width: 100%;
      margin: 18px 0;
      padding: 0 28px;
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

    /* Tables */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 13px;
    }
    .data-table th {
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--card-border);
      padding: 10px 14px;
      text-align: left;
      font-weight: 600;
      color: var(--text-muted);
    }
    .data-table td {
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding: 12px 14px;
      vertical-align: middle;
    }
    .data-table tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    /* Badges */
    .badge-running { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .badge-completed { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-failed { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge-queued { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-paused { background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }

    /* Quota Progress Bar */
    .quota-track {
      width: 100px;
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      height: 8px;
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
      margin-right: 8px;
    }
    .quota-fill {
      height: 100%;
      border-radius: 6px;
      transition: width 0.3s ease;
    }

    /* Code Box */
    .code-box {
      background: #090d16;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      color: #38bdf8;
      overflow-x: auto;
      margin: 8px 0;
      user-select: all;
    }

    /* Action Buttons Small */
    .btn-sm {
      padding: 4px 10px;
      font-size: 12px;
      border-radius: 6px;
      border: 1px solid var(--card-border);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-main);
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-sm:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--accent);
    }
    .btn-sm-danger {
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .btn-sm-danger:hover {
      background: rgba(239, 68, 68, 0.2);
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 999;
    }
    .modal-overlay.open { display: flex; }
    .modal-box {
      background: #131c2e;
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 24px;
      width: 90%;
      max-width: 580px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
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

    /* 2-Layer Layout: Compact Hardware Bar */
    .compact-hw-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 10px 16px;
      margin-bottom: 20px;
      font-size: 12px;
      color: var(--text-muted);
      flex-wrap: wrap;
    }
    .compact-hw-bar.warning {
      border-color: rgba(239, 68, 68, 0.5);
      background: rgba(239, 68, 68, 0.08);
      color: #fca5a5;
    }
    .hw-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .hw-val {
      font-family: monospace;
      color: var(--text-main);
      font-weight: 600;
    }

    /* Top Overview Metric Cards */
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 14px 16px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      gap: 4px;
      position: relative;
      overflow: hidden;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      border-color: var(--accent);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }
    .metric-card.active {
      border-color: var(--accent);
      background: rgba(56, 189, 248, 0.08);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .metric-card-label {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .metric-card-val {
      font-size: 26px;
      font-weight: 800;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: -0.02em;
    }
    .metric-card-hint {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .val-running { color: #38bdf8; }
    .val-queued { color: #fbbf24; }
    .val-paused { color: #c084fc; }
    .val-completed { color: #34d399; }
    .val-failed { color: #f87171; }

    /* Quick Quota Strip */
    .quick-quota-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-top: 24px;
    }
    .quick-quota-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .quota-chip {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .quota-chip-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
    }
    .quota-chip-bar {
      height: 6px;
      background: #1e293b;
      border-radius: 3px;
      overflow: hidden;
    }
    .quota-chip-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s;
    }

    /* Settings Button & Modal Drawer */
    .btn-settings {
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
      transition: all 0.2s;
    }
    .btn-settings:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: var(--accent);
      color: var(--accent);
    }
    .settings-modal-box {
      background: #101726;
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 24px;
      width: 95%;
      max-width: 1200px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
      position: relative;
    }
    .settings-tab-bar {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .settings-tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .settings-tab-btn:hover { color: var(--text-main); }
    .settings-tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
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
      <button class="btn-settings" onclick="openSettingsModal()">
        <span>⚙️ 设置与配置</span>
      </button>
    </div>
  </header>

  <div class="container">
    <!-- Compact Hardware Status Bar -->
    <div id="compact-hw-bar" class="compact-hw-bar">
      <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
        <span class="hw-item">💻 <span id="hw-cpu" class="hw-val">加载中...</span></span>
        <span class="hw-item">🧠 内存: <span id="hw-mem" class="hw-val">-</span></span>
        <span class="hw-item">⚙️ 守护进程: <span id="hw-worker" class="hw-val" style="color:var(--green);">-</span></span>
      </div>
      <div style="display:flex; gap:12px; align-items:center;">
        <a href="/health" target="_blank" style="color:var(--accent); text-decoration:none; font-size:12px;">🩺 健康检测</a>
        <a href="/status" target="_blank" style="color:var(--text-muted); text-decoration:none; font-size:12px;">📊 状态接口</a>
        <a href="/mcp" target="_blank" style="color:var(--text-muted); text-decoration:none; font-size:12px;">🔌 MCP</a>
      </div>
    </div>

    <!-- Top Overview Metric Cards -->
    <div class="overview-grid">
      <div class="metric-card" onclick="filterByOverviewCard('running')">
        <div class="metric-card-label">⚡ 运行中任务</div>
        <div class="metric-card-val val-running" id="ov-running">0</div>
        <div class="metric-card-hint">正在占用 Agent 执行</div>
      </div>
      <div class="metric-card" onclick="filterByOverviewCard('queued')">
        <div class="metric-card-label">⏳ 排队等待中</div>
        <div class="metric-card-val val-queued" id="ov-queued">0</div>
        <div class="metric-card-hint">排队等待空闲通道</div>
      </div>
      <div class="metric-card" onclick="filterByOverviewCard('paused_quota')">
        <div class="metric-card-label">⏸ 额度暂停</div>
        <div class="metric-card-val val-paused" id="ov-paused">0</div>
        <div class="metric-card-hint">等额度重置或改派</div>
      </div>
      <div class="metric-card" onclick="filterByOverviewCard('completed_today')">
        <div class="metric-card-label">✓ 今日完成</div>
        <div class="metric-card-val val-completed" id="ov-completed-today">0</div>
        <div class="metric-card-hint">今日已交付的 PR/结果</div>
      </div>
      <div class="metric-card" onclick="filterByOverviewCard('failed_today')">
        <div class="metric-card-label">✕ 今日异常/取消</div>
        <div class="metric-card-val val-failed" id="ov-failed-today">0</div>
        <div class="metric-card-hint">失败或用户手动取消</div>
      </div>
    </div>

    <!-- Main Monitoring View (Tasks Stream & Flow) -->
    <div class="section-card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:14px;">
        <div>
          <div class="section-title">🕒 任务流与实时监控 (Task Monitor)</div>
          <p class="section-desc" style="margin-bottom:0">
            默认实时追踪运行中、排队及暂停任务，支持快速改派、重试续跑、挂起和日志回溯。
          </p>
        </div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <select id="filter-task-status" onchange="loadRecentTasks()" style="background:var(--input-bg); color:var(--text-main); border:1px solid var(--card-border); padding:6px 12px; border-radius:8px; font-size:13px;">
            <option value="active" selected>⚡ 活跃任务 (运行中/排队/暂停)</option>
            <option value="all">全部历史任务 (All Tasks)</option>
            <option value="running">运行中 (running)</option>
            <option value="paused_quota">额度暂停 (paused_quota)</option>
            <option value="completed">已完成任务 (completed)</option>
            <option value="failed">失败/取消 (failed)</option>
            <option value="queued">排队中 (queued)</option>
            <option value="requirements">📋 需求暂存草稿 (Requirements)</option>
            <option value="queue">⏳ 会话排队序列 (Queue Details)</option>
          </select>
          <button class="btn-secondary" onclick="loadRecentTasks()">🔄 刷新</button>
        </div>
      </div>

      <!-- Batch Toolbar -->
      <div id="tasks-batch-bar" style="display:none; align-items:center; justify-content:space-between; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.25); border-radius:8px; padding:8px 14px; margin-bottom:12px;">
        <div style="font-size:13px; color:var(--text-main);">
          已选中 <strong id="tasks-selected-count" style="color:var(--accent);">0</strong> 条任务
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-sm btn-sm-danger" onclick="batchCancelTasks()">✕ 批量取消</button>
          <button class="btn-sm" style="color:var(--text-muted);" onclick="batchArchiveTasks(false)">📦 批量归档</button>
          <button class="btn-sm btn-sm-danger" onclick="batchArchiveTasks(true)">🗑️ 批量归档 + 清理 Worktree</button>
        </div>
      </div>

      <!-- Container 1: Tasks Table -->
      <div id="view-tasks-container" style="overflow-x:auto;">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width:36px; text-align:center;"><input type="checkbox" id="chk-tasks-select-all" onchange="toggleSelectAllTasks(this.checked)"></th>
              <th style="width:160px;">任务 ID</th>
              <th style="width:120px;">主题 / 会话</th>
              <th style="width:95px;">状态</th>
              <th style="width:90px;">活跃度</th>
              <th style="width:115px;">创建时间</th>
              <th style="width:115px;">完成时间</th>
              <th style="width:110px;">PR 链接</th>
              <th>最新日志输出 (Tail)</th>
              <th style="width:180px; text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody id="recent-tasks-tbody">
            <tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Container 2: Embedded Requirements Table (Switched via Filter) -->
      <div id="view-requirements-container" style="display:none; overflow-x:auto;">
        <div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
          <button class="btn-primary" onclick="openCreateRequirementModal()">+ 暂存新需求草稿</button>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th style="width:160px;">需求 ID</th>
              <th style="width:120px;">项目归属</th>
              <th style="width:140px;">主题 / 会话</th>
              <th>需求标题与规格预览</th>
              <th style="width:90px;">状态</th>
              <th style="width:130px;">创建时间</th>
              <th style="width:200px; text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody id="requirements-tbody">
            <tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Container 3: Embedded Queue Container (Switched via Filter) -->
      <div id="view-queue-container" style="display:none;">
        <div id="queue-sessions-container">
          <div style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</div>
        </div>
      </div>
    </div>

    <!-- Quick Read-Only Account Quota Strip -->
    <div class="quick-quota-card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <div class="section-title">👥 账号池额度概览 (Read-Only Quota Overview)</div>
          <p class="section-desc" style="margin-bottom:0">实时汇总本地 Cockpit 与 Profile 账号 5 小时窗口可用额度与重置时间。</p>
        </div>
        <button class="btn-secondary" style="font-size:12px;" onclick="loadQuickQuota()">🔄 刷新额度</button>
      </div>
      <div id="quick-quota-grid" class="quick-quota-grid">
        <div style="color:var(--text-muted); font-size:13px; padding:12px;">加载账号额度中...</div>
      </div>
    </div>
  </div>

  <!-- Settings Modal (Dedicated Layer for Configurations) -->
  <div id="modal-settings" class="modal-overlay">
    <div class="settings-modal-box">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <div class="section-title" style="font-size:18px;">⚙️ Agent Bridge 系统配置与管理</div>
        <button class="btn-sm" onclick="closeSettingsModal()">✕ 关闭</button>
      </div>

      <!-- Device Access Details (Hidden from daily view, ready for copy) -->
      <div class="access-card" style="margin-bottom:20px;">
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

      <!-- Settings Navigation Tabs -->
      <div class="settings-tab-bar">
        <button class="settings-tab-btn active" onclick="switchSettingsTab('stab-routing', this)">🎯 调度偏好与场景规则</button>
        <button class="settings-tab-btn" onclick="switchSettingsTab('stab-agents', this)">🤖 本地 Agent 注册 (agents.json)</button>
        <button class="settings-tab-btn" onclick="switchSettingsTab('stab-pool', this); loadPool();">👥 agy 账号池管理</button>
        <button class="settings-tab-btn" onclick="switchSettingsTab('stab-system', this); loadSystemStats();">💻 硬件诊断详细</button>
      </div>

      <!-- Settings Tab 1: Routing & Instructions -->
      <div id="stab-routing" class="tab-pane active">
        <div class="section-card" style="margin-bottom:16px;">
          <div class="section-title">
            <span>📝 全局分发指导说明 (AI Dispatch Instructions)</span>
          </div>
          <p class="section-desc">
            在这里写下您期望 AI 遵循的分发习惯与场景规则。此说明会自动同步给 ChatGPT 及外部调用者，作为其自动判断任务归属的首要原则。
          </p>
          <div class="form-group">
            <textarea id="inp-instructions" placeholder="默认留空（选填）。例如：'涉及后端开发走 codex；涉及前端页面走 agy'"></textarea>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>默认兜底 Agent (Default Fallback Agent)</label>
            <select id="sel-default-agent" style="max-width:320px"></select>
          </div>
        </div>

        <div class="section-card" style="margin-bottom:0;">
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

      <!-- Settings Tab 2: Local Agents -->
      <div id="stab-agents" class="tab-pane">
        <div class="section-card" style="margin-bottom:0;">
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

      <!-- Settings Tab 3: Account Pool Management -->
      <div id="stab-pool" class="tab-pane">
        <!-- Section 0: Dual pool overview -->
        <div class="section-card" style="margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:8px;">
            <div>
              <div class="section-title">🧮 账号总览（按邮箱，两池共享额度/暂停/占用）</div>
              <p class="section-desc" style="margin-bottom:0">
                <b>默认池</b>：机器默认 HOME + Cockpit 当前账号。<b>自定义池</b>：独立 Profile。
              </p>
            </div>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
              <input type="checkbox" id="custom-pool-toggle" onchange="toggleCustomPool(this.checked)">
              <span id="custom-pool-toggle-label">启用/停用自定义池</span>
            </label>
          </div>
          <div style="overflow-x:auto;">
            <table class="data-table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th style="width:160px;">所在池</th>
                  <th style="width:110px;">共享额度</th>
                  <th style="width:170px;">暂停</th>
                  <th style="width:170px;">占用</th>
                  <th style="width:100px; text-align:right;">操作</th>
                </tr>
              </thead>
              <tbody id="pool-accounts-tbody">
                <tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Section 1: Cockpit Quota & Accounts -->
        <div class="section-card" style="margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:8px;">
            <div>
              <div class="section-title">🎛️ Cockpit 账号与 5 小时额度窗口</div>
              <p class="section-desc" style="margin-bottom:0">
                数据来源于本地 Cockpit Tools（<code>~/.antigravity_cockpit</code>）。
              </p>
            </div>
            <button class="btn-secondary" onclick="loadPool()">🔄 刷新 Cockpit 状态</button>
          </div>
          <div style="overflow-x:auto;">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:200px;">Cockpit 账号 ID</th>
                  <th>绑定邮箱</th>
                  <th style="width:110px;">当前主账号</th>
                  <th style="width:200px;">5h 额度窗口</th>
                  <th style="width:160px;">重置时间</th>
                  <th style="width:130px; text-align:right;">操作</th>
                </tr>
              </thead>
              <tbody id="cockpit-accounts-tbody">
                <tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Section 2: Isolated Profiles -->
        <div class="section-card" style="margin-bottom:0;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:8px;">
            <div>
              <div class="section-title">👥 agy 多账号并发隔离 Profile 池</div>
              <p class="section-desc" style="margin-bottom:0">
                每个 Profile 拥有独立的 <code>$HOME</code> 运行空间。
              </p>
            </div>
            <div style="display:flex; gap:10px;">
              <button class="btn-primary" onclick="initNewProfileModal()">+ 初始化新 Profile</button>
              <button class="btn-secondary" onclick="loadPool()">🔄 刷新 Profile</button>
            </div>
          </div>
          <div style="overflow-x:auto;">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:110px;">别名</th>
                  <th>主目录 (HOME)</th>
                  <th style="width:160px;">Cockpit 邮箱</th>
                  <th style="width:90px;">调度状态</th>
                  <th style="width:100px;">登录状态</th>
                  <th style="width:120px;">当前执行任务</th>
                  <th style="width:80px;">今日任务</th>
                  <th style="width:90px;">额度参考</th>
                  <th style="width:220px; text-align:right;">操作</th>
                </tr>
              </thead>
              <tbody id="pool-profiles-tbody">
                <tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Settings Tab 4: Detailed Hardware Diagnostics -->
      <div id="stab-system" class="tab-pane">
        <div class="section-card" style="margin-bottom:16px;">
          <div class="section-title">💻 宿主机物理硬件与环境详情</div>
          <p class="section-desc">当前运行 Agent Bridge 的系统物理资源利用状况。</p>
          <div id="system-stats" class="stats-grid"></div>
        </div>
        <div class="section-card" style="margin-bottom:0;">
          <div class="section-title">🔍 本地诊断接口快捷直达</div>
          <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:8px;">
            <a href="/health" target="_blank" class="btn-secondary">🩺 健康检测 (/health)</a>
            <a href="/status" target="_blank" class="btn-secondary">📊 服务状态 (/status)</a>
            <a href="/mcp" target="_blank" class="btn-secondary">🔌 MCP 端点 (/mcp)</a>
          </div>
        </div>
      </div>

      <!-- Settings Save Action Footer -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:24px; padding-top:16px; border-top:1px solid var(--card-border);">
        <div style="font-size:12px; color:var(--text-muted);">💡 规则与代理修改保存后直接写入本机 agents.json，即刻生效。</div>
        <div style="display:flex; gap:10px;">
          <button class="btn-secondary" onclick="closeSettingsModal()">取消</button>
          <button class="btn-primary" onclick="saveAllConfig()">💾 保存配置并即刻生效</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast">✅ 操作成功！</div>

  <!-- Modal: Create Requirement -->
  <div id="modal-req" class="modal-overlay">
    <div class="modal-box">
      <div class="section-title" style="margin-bottom:14px;">📝 暂存新需求草稿</div>
      <div class="form-group">
        <label>需求标题 *</label>
        <input type="text" id="req-inp-title" placeholder="例如：用户中心添加两步验证支持">
      </div>
      <div class="form-group" style="display:flex; gap:12px;">
        <div style="flex:1;">
          <label>所属项目 ID *</label>
          <input type="text" id="req-inp-project" placeholder="例如：agent-bridge 或 my-app">
        </div>
        <div style="flex:1;">
          <label>所属会话/主题 (Topic / Session ID)</label>
          <input type="text" id="req-inp-topic" placeholder="选填，相同主题可自动上下文关联">
        </div>
      </div>
      <div class="form-group">
        <label>分类标签 (逗号隔开)</label>
        <input type="text" id="req-inp-tags" placeholder="例如：feature, auth, security">
      </div>
      <div class="form-group">
        <label>需求详细描述与规格说明 (Prompt) *</label>
        <textarea id="req-inp-raw" rows="6" placeholder="请详细描述此需求的具体实现规范、验收标准等..."></textarea>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button class="btn-secondary" onclick="closeModal('modal-req')">取消</button>
        <button class="btn-primary" onclick="submitCreateRequirement()">保存需求草稿</button>
      </div>
    </div>
  </div>

  <!-- Modal: Dispatch Requirement -->
  <div id="modal-dispatch" class="modal-overlay">
    <div class="modal-box">
      <div class="section-title" style="margin-bottom:14px;">🚀 派发需求为执行任务</div>
      <input type="hidden" id="dispatch-req-id">
      <p class="section-desc" id="dispatch-req-desc" style="margin-bottom:14px; color:var(--accent);">派发需求：</p>
      <div class="form-group">
        <label>执行 Agent</label>
        <select id="dispatch-sel-agent"></select>
      </div>
      <div class="form-group" style="display:flex; gap:12px;">
        <div style="flex:1;">
          <label>模型指定 (选填)</label>
          <input type="text" id="dispatch-inp-model" placeholder="留空使用默认">
        </div>
        <div style="flex:1;">
          <label>账号池 Profile (选填)</label>
          <input type="text" id="dispatch-inp-account" placeholder="auto 或指定 profile 别名">
        </div>
      </div>
      <div class="form-group">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="dispatch-chk-queue" checked>
          <span>若目标会话当前繁忙，自动加入排队队列 (queue_if_busy)</span>
        </label>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button class="btn-secondary" onclick="closeModal('modal-dispatch')">取消</button>
        <button class="btn-primary" onclick="submitDispatchRequirement()">确认派发</button>
      </div>
    </div>
  </div>

  <!-- Modal: Profile Login / Auth -->
  <div id="modal-login-cmd" class="modal-overlay">
    <div class="modal-box" style="max-width:640px;">
      <div class="section-title" style="margin-bottom:14px;">🔑 Profile 登录</div>
      <p class="section-desc" style="margin-bottom:10px;">
        推荐：直接从 Cockpit 已登录账号同步凭证到该 Profile（无需终端、无需粘贴授权码）。
      </p>
      <div id="login-status-box" style="margin-bottom:12px; padding:10px 12px; border-radius:8px; background:rgba(148,163,184,0.12); font-size:13px;"></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px;">
        <button class="btn-primary" onclick="syncProfileAuthFromModal()">⟳ 从 Cockpit 同步登录态</button>
      </div>
      <details style="margin-top:4px;">
        <summary style="cursor:pointer; color:var(--text-muted); font-size:13px;">高级：终端登录命令（备用）</summary>
        <p class="section-desc" style="margin:10px 0 8px;">
          仅在 Cockpit 同步失败时使用。在系统终端执行：
        </p>
        <div class="code-box" id="login-cmd-text"></div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:12px;">
          <button class="btn-secondary" onclick="copyLoginCmd()">📋 复制命令</button>
        </div>
      </details>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button class="btn-secondary" onclick="closeModal('modal-login-cmd')">关闭</button>
      </div>
    </div>
  </div>

  <!-- Modal: Init Profile from Cockpit Account -->
  <div id="modal-init-profile" class="modal-overlay">
    <div class="modal-box" style="max-width:640px;">
      <div class="section-title" style="margin-bottom:14px;">👥 从 Cockpit 账号初始化 Profile</div>
      <p class="section-desc" style="margin-bottom:12px;">
        选择一个 Cockpit 账号。别名与 HOME 自动生成；初始化后会立刻从 Cockpit 同步 agy 登录态，无需终端登录。已绑定账号不可再次初始化。
      </p>
      <div id="init-profile-account-list" style="max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:8px;"></div>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button class="btn-secondary" onclick="closeModal('modal-init-profile')">取消</button>
      </div>
    </div>
  </div>

  <!-- Modal: Task Details -->
  <div id="modal-task-details" class="modal-overlay">
    <div class="modal-box" style="max-width:800px; max-height:85vh; overflow-y:auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div class="section-title" id="td-modal-title">📄 任务详情</div>
        <button class="btn-sm" onclick="closeModal('modal-task-details')">✕ 关闭</button>
      </div>
      <div id="td-meta-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; margin-bottom:14px; background:rgba(255,255,255,0.03); border:1px solid var(--card-border); border-radius:8px; padding:12px;"></div>
      <div class="form-group" style="margin-bottom:12px;">
        <label style="display:flex; justify-content:space-between; align-items:center;">
          <span>提示词 (Prompt)</span>
          <button class="btn-sm" style="font-size:11px;" onclick="copyTaskPromptFromModal()">📋 复制提示词</button>
        </label>
        <textarea id="td-prompt-text" rows="8" readonly style="font-family:monospace; font-size:12px; background:var(--bg); color:var(--text-main);"></textarea>
      </div>
      <div id="td-result-box" style="display:none; margin-bottom:12px;">
        <label>执行结果与产物摘要 (Result Markdown)</label>
        <div id="td-result-content" class="code-box" style="max-height:220px; overflow-y:auto; font-size:12px; margin-top:4px;"></div>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button class="btn-secondary" onclick="closeModal('modal-task-details')">关闭</button>
      </div>
    </div>
  </div>

  <!-- Modal: Task Logs -->
  <div id="modal-task-logs" class="modal-overlay">
    <div class="modal-box" style="max-width:850px; max-height:85vh; overflow-y:auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div class="section-title" id="tl-modal-title">📜 任务日志输出 (Tail)</div>
        <div style="display:flex; gap:8px;">
          <button class="btn-secondary btn-sm" onclick="refreshCurrentTaskLogs()">🔄 刷新日志</button>
          <button class="btn-sm" onclick="closeModal('modal-task-logs')">✕ 关闭</button>
        </div>
      </div>
      <div style="margin-bottom:8px; font-size:12px; color:var(--text-muted);">
        最近 100 行标准输出与会话 tail：
      </div>
      <div id="tl-log-container" class="code-box" style="max-height:460px; overflow-y:auto; font-size:12px; white-space:pre-wrap; word-break:break-all; background:#080d16; color:#a5b4fc; padding:14px; border-radius:8px;">
        加载中...
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
        <button class="btn-secondary" onclick="closeModal('modal-task-logs')">关闭</button>
      </div>
    </div>
  </div>

  <!-- Modal: Retry / Resume / Switch Account -->
  <div id="modal-task-retry" class="modal-overlay">
    <div class="modal-box" style="max-width:620px;">
      <div class="section-title" id="tr-modal-title" style="margin-bottom:12px;">⚡ 重试 / 续跑 / 改派任务</div>
      <input type="hidden" id="tr-task-id">
      <div class="form-group">
        <label>执行模式</label>
        <div style="display:flex; gap:16px; margin-top:4px;">
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="tr-mode" value="continue" checked>
            <span>续跑模式（保留已有会话上下文与历史）</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="tr-mode" value="fresh">
            <span>全新重跑（不继承历史会话）</span>
          </label>
        </div>
      </div>
      <div class="form-group" style="display:flex; gap:12px;">
        <div style="flex:1;">
          <label>改派执行 Agent (可选)</label>
          <select id="tr-sel-agent"></select>
        </div>
        <div style="flex:1;">
          <label>改派模型 (可选)</label>
          <input type="text" id="tr-inp-model" placeholder="留空使用原配置">
        </div>
      </div>
      <div class="form-group">
        <label>指定运行账号 / Profile (可选)</label>
        <input type="text" id="tr-inp-account" placeholder="auto 或指定 profile 别名，改派至其他有额度的账号">
      </div>
      <div class="form-group">
        <label>提示词调整 (选填，留空沿用原提示词)</label>
        <textarea id="tr-inp-prompt" rows="4" placeholder="留空则沿用原提示词..."></textarea>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button class="btn-secondary" onclick="closeModal('modal-task-retry')">取消</button>
        <button class="btn-primary" onclick="submitTaskRetry()">🚀 立即执行</button>
      </div>
    </div>
  </div>

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

    let lastPoolData = { cockpitAccounts: [], profiles: [], pool: [], runningTasks: {} };
    let overviewFilterActive = "active";

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

    function openSettingsModal() {
      openModal("modal-settings");
      loadPool();
      loadSystemStats();
    }

    function closeSettingsModal() {
      closeModal("modal-settings");
    }

    function switchSettingsTab(tabId, btn) {
      document.querySelectorAll(".settings-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".settings-modal-box .tab-pane").forEach(p => p.classList.remove("active"));
      if (btn) btn.classList.add("active");
      const target = document.getElementById(tabId);
      if (target) target.classList.add("active");
    }

    function filterByOverviewCard(type) {
      const sel = document.getElementById("filter-task-status");
      if (!sel) return;
      if (type === "completed_today") {
        sel.value = "completed";
      } else if (type === "failed_today") {
        sel.value = "failed";
      } else {
        sel.value = type;
      }
      loadRecentTasks();
    }

    function formatActivityAgo(iso) {
      if (!iso) return '<span style="color:var(--text-muted);">-</span>';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '<span style="color:var(--text-muted);">-</span>';
      const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
      if (sec < 60) return '<span style="color:var(--green); font-size:12px;">' + sec + '秒前</span>';
      const min = Math.floor(sec / 60);
      if (min < 60) return '<span style="color:var(--accent); font-size:12px;">' + min + '分钟前</span>';
      const hr = Math.floor(min / 60);
      if (hr < 24) return '<span style="color:var(--yellow); font-size:12px;">' + hr + '小时前</span>';
      const day = Math.floor(hr / 24);
      return '<span style="color:var(--text-muted); font-size:12px;">' + day + '天前</span>';
    }

    function switchTab(tabId, btn) {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      if (btn) btn.classList.add("active");
      const target = document.getElementById(tabId);
      if (target) target.classList.add("active");
    }

    function openModal(id) {
      const m = document.getElementById(id);
      if (m) m.classList.add("open");
    }

    function closeModal(id) {
      const m = document.getElementById(id);
      if (m) m.classList.remove("open");
    }

    let activeLoginCommand = "";
    let activeLoginAlias = "";
    function showLoginCmd(home, alias) {
      activeLoginCommand = "HOME=" + home + " agy";
      activeLoginAlias = alias || "";
      const cmdEl = document.getElementById("login-cmd-text");
      if (cmdEl) cmdEl.textContent = activeLoginCommand;
      const box = document.getElementById("login-status-box");
      if (box) {
        const stat = (lastPoolData.pool || []).find(function(s) { return s.alias === alias; });
        const label = (stat && stat.login_label) ? stat.login_label : "未登录";
        const reason = (stat && stat.login_reason) ? (" · " + stat.login_reason) : "";
        box.textContent = "当前登录状态：" + label + reason;
      }
      openModal("modal-login-cmd");
    }

    function copyLoginCmd() {
      if (!activeLoginCommand) return;
      navigator.clipboard.writeText(activeLoginCommand).then(() => {
        showToast("📋 已复制认证命令: " + activeLoginCommand);
      });
    }

    async function syncProfileAuthFromModal() {
      if (!activeLoginAlias) { alert("未选择 Profile"); return; }
      try {
        showToast("正在从 Cockpit 同步登录态...");
        const res = await fetch("/api/pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync_auth", alias: activeLoginAlias }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "同步失败");
        showToast("✅ " + activeLoginAlias + " 已同步为" + (d.login_label || "已登录"));
        const box = document.getElementById("login-status-box");
        if (box) box.textContent = "当前登录状态：" + (d.login_label || "已登录");
        await loadPool();
      } catch (err) {
        alert("同步登录态失败: " + err.message);
      }
    }

    async function syncProfileAuth(alias) {
      try {
        showToast("正在从 Cockpit 同步登录态...");
        const res = await fetch("/api/pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync_auth", alias: alias }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "同步失败");
        showToast("✅ " + alias + " → " + (d.login_label || "已登录"));
        await loadPool();
      } catch (err) {
        alert("同步登录态失败: " + err.message);
      }
    }

    // --- Tab 1: Recent Tasks ---
    let cachedRecentTasks = [];
    let selectedTaskIds = new Set();
    let currentLogsTaskId = "";
    let cachedModalPrompt = "";

    function formatTimeCompact(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "-";
      const pad = n => String(n).padStart(2, "0");
      const month = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      const hours = pad(d.getHours());
      const minutes = pad(d.getMinutes());
      const seconds = pad(d.getSeconds());
      return month + "-" + day + " " + hours + ":" + minutes + ":" + seconds;
    }

    function updateBatchBar() {
      const bar = document.getElementById("tasks-batch-bar");
      const countEl = document.getElementById("tasks-selected-count");
      const selectAll = document.getElementById("chk-tasks-select-all");
      if (!bar || !countEl) return;
      if (selectedTaskIds.size > 0) {
        bar.style.display = "flex";
        countEl.textContent = String(selectedTaskIds.size);
      } else {
        bar.style.display = "none";
      }
      if (selectAll) {
        selectAll.checked = cachedRecentTasks.length > 0 && selectedTaskIds.size === cachedRecentTasks.length;
      }
    }

    function toggleSelectAllTasks(checked) {
      if (checked) {
        cachedRecentTasks.forEach(t => selectedTaskIds.add(t.taskId));
      } else {
        selectedTaskIds.clear();
      }
      document.querySelectorAll(".chk-task-item").forEach(cb => {
        cb.checked = checked;
      });
      updateBatchBar();
    }

    function toggleTaskSelection(taskId, checked) {
      if (checked) selectedTaskIds.add(taskId);
      else selectedTaskIds.delete(taskId);
      updateBatchBar();
    }

    async function cancelRecentTask(taskId) {
      if (!confirm("确认取消任务 " + taskId + " 吗？")) return;
      try {
        const res = await fetch("/api/recent-tasks/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId }),
        });
        const data = await res.json();
        if (!res.ok || data.success === false) {
          throw new Error(data.error || "取消任务失败");
        }
        showToast("✕ " + (data.message || ("任务 " + taskId + " 已取消")));
        loadRecentTasks();
      } catch (err) {
        alert("取消失败: " + err.message);
      }
    }

    async function archiveRecentTask(taskId, cleanWorktree) {
      const promptMsg = cleanWorktree
        ? "确认归档任务 " + taskId + " 并清理对应 worktree 目录吗？不可撤销。"
        : "确认归档并移除任务 " + taskId + " 记录吗？";
      if (!confirm(promptMsg)) return;
      try {
        const res = await fetch("/api/recent-tasks/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskIds: [taskId], cleanWorktree: !!cleanWorktree }),
        });
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || "归档失败");
        showToast(data.message || "任务已归档");
        selectedTaskIds.delete(taskId);
        loadRecentTasks();
      } catch (err) {
        alert("归档失败: " + err.message);
      }
    }

    async function batchCancelTasks() {
      const ids = Array.from(selectedTaskIds);
      if (ids.length === 0) return;
      if (!confirm("确认批量取消选中的 " + ids.length + " 个任务吗？")) return;
      let successCount = 0;
      for (const tid of ids) {
        try {
          const res = await fetch("/api/recent-tasks/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: tid }),
          });
          const d = await res.json();
          if (d.success) successCount++;
        } catch {}
      }
      showToast("已批量取消 " + successCount + " 个任务");
      selectedTaskIds.clear();
      loadRecentTasks();
    }

    async function batchArchiveTasks(cleanWorktree) {
      const ids = Array.from(selectedTaskIds);
      if (ids.length === 0) return;
      const msg = cleanWorktree
        ? "确认批量归档 " + ids.length + " 条任务并清理关联的 worktree 吗？"
        : "确认批量归档并删除 " + ids.length + " 条任务记录吗？";
      if (!confirm(msg)) return;
      try {
        const res = await fetch("/api/recent-tasks/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskIds: ids, cleanWorktree: !!cleanWorktree }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || "批量归档失败");
        showToast(data.message || "批量归档成功");
        selectedTaskIds.clear();
        loadRecentTasks();
      } catch (err) {
        alert("批量归档失败: " + err.message);
      }
    }

    async function toggleTaskSessionPause(sessionId, shouldPause) {
      try {
        const res = await fetch("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: shouldPause ? "pause" : "resume",
            session_id: sessionId,
            reason: shouldPause ? "用户通过最近任务列表手动挂起" : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || "操作队列失败");
        showToast(shouldPause ? "⏸ 会话队列已挂起暂停" : "▶ 会话队列已恢复放行");
        loadRecentTasks();
      } catch (err) {
        alert(err.message);
      }
    }

    async function openTaskDetailsModal(taskId) {
      document.getElementById("td-modal-title").textContent = "📄 任务详情: " + taskId;
      document.getElementById("td-meta-grid").innerHTML = "加载中...";
      document.getElementById("td-prompt-text").value = "加载中...";
      document.getElementById("td-result-box").style.display = "none";
      cachedModalPrompt = "";
      openModal("modal-task-details");

      try {
        const res = await fetch("/api/recent-tasks/details?taskId=" + encodeURIComponent(taskId));
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || "加载详情失败");

        const m = data.meta || {};
        const s = data.status || {};
        cachedModalPrompt = data.prompt || "";
        document.getElementById("td-prompt-text").value = cachedModalPrompt || "(无独立提示词)";

        const gridItems = [
          { k: "任务 ID", v: '<span style="font-family:monospace; color:var(--accent);">' + escapeHtml(taskId) + '</span>' },
          { k: "当前状态", v: '<span class="badge">' + escapeHtml(s.state || "unknown") + '</span>' },
          { k: "所属 Agent", v: escapeHtml(s.agent || m["Agent"] || "-") },
          { k: "模型", v: escapeHtml(s.model || m["Model"] || "-") },
          { k: "账号 / Profile", v: escapeHtml(s.account || m["Account"] || "-") },
          { k: "会话 ID", v: escapeHtml(s.sessionId || m["Session ID"] || "-") },
          { k: "工作目录 / Worktree", v: data.workDir ? '<span style="font-family:monospace; font-size:11px;" title="' + escapeHtml(data.workDir) + '">' + escapeHtml(data.workDir) + '</span>' : '-' },
          { k: "退出代码", v: s.exitCode !== undefined && s.exitCode !== null ? String(s.exitCode) : '-' },
          { k: "失败 / 暂停原因", v: s.reason ? '<span style="color:var(--red); font-size:11px;">' + escapeHtml(s.reason) + '</span>' : '-' },
        ];

        document.getElementById("td-meta-grid").innerHTML = gridItems.map(it => 
          '<div><div style="font-size:11px; color:var(--text-muted);">' + it.k + '</div><div style="font-size:13px; font-weight:500; margin-top:2px;">' + it.v + '</div></div>'
        ).join("");

        if (data.resultRaw) {
          document.getElementById("td-result-box").style.display = "block";
          document.getElementById("td-result-content").textContent = data.resultRaw;
        }
      } catch (err) {
        document.getElementById("td-meta-grid").innerHTML = '<div style="color:var(--red);">加载详情失败: ' + escapeHtml(err.message) + '</div>';
      }
    }

    function copyTaskPromptFromModal() {
      if (!cachedModalPrompt) {
        showToast("无提示词可复制");
        return;
      }
      navigator.clipboard.writeText(cachedModalPrompt);
      showToast("📋 已复制提示词到剪贴板");
    }

    async function copyTaskPromptDirect(taskId) {
      try {
        const res = await fetch("/api/recent-tasks/details?taskId=" + encodeURIComponent(taskId));
        const data = await res.json();
        if (data.prompt) {
          navigator.clipboard.writeText(data.prompt);
          showToast("📋 已复制提示词: " + taskId);
        } else {
          showToast("未找到此任务的提示词");
        }
      } catch {
        showToast("复制失败");
      }
    }

    async function openTaskLogsModal(taskId) {
      currentLogsTaskId = taskId;
      document.getElementById("tl-modal-title").textContent = "📜 任务日志 (Tail): " + taskId;
      document.getElementById("tl-log-container").textContent = "正在读取最新日志...";
      openModal("modal-task-logs");
      refreshCurrentTaskLogs();
    }

    async function refreshCurrentTaskLogs() {
      if (!currentLogsTaskId) return;
      try {
        const res = await fetch("/api/recent-tasks/logs?taskId=" + encodeURIComponent(currentLogsTaskId) + "&lines=100");
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || "读取日志失败");
        const out = data.stdout || "";
        const err = data.stderr || "";
        let combined = "";
        if (out) combined += "[STDOUT]\\n" + out + "\\n";
        if (err) combined += "\\n[STDERR]\\n" + err;
        if (!combined.trim()) combined = "(暂无日志输出)";
        document.getElementById("tl-log-container").textContent = combined;
      } catch (err) {
        document.getElementById("tl-log-container").textContent = "读取日志失败: " + err.message;
      }
    }

    function openTaskRetryModal(taskId, suggestedMode) {
      document.getElementById("tr-task-id").value = taskId;
      document.getElementById("tr-modal-title").textContent = (suggestedMode === "switch_account" ? "🔄 改派账号 / Agent: " : "⚡ 重试 / 续跑任务: ") + taskId;
      
      const radios = document.getElementsByName("tr-mode");
      for (const r of radios) {
        if (suggestedMode === "fresh") {
          r.checked = (r.value === "fresh");
        } else {
          r.checked = (r.value === "continue");
        }
      }

      // Populate agents in tr-sel-agent
      const selAgent = document.getElementById("tr-sel-agent");
      selAgent.innerHTML = '<option value="">保持原 Agent</option>' + Object.keys(currentConfig.agents || {}).map(a => 
        '<option value="' + a + '">' + a + '</option>'
      ).join("");

      document.getElementById("tr-inp-model").value = "";
      document.getElementById("tr-inp-account").value = "";
      document.getElementById("tr-inp-prompt").value = "";

      openModal("modal-task-retry");
    }

    async function submitTaskRetry() {
      const taskId = document.getElementById("tr-task-id").value;
      let mode = "continue";
      const radios = document.getElementsByName("tr-mode");
      for (const r of radios) {
        if (r.checked) mode = r.value;
      }
      const agent = document.getElementById("tr-sel-agent").value;
      const model = document.getElementById("tr-inp-model").value;
      const account = document.getElementById("tr-inp-account").value;
      const prompt = document.getElementById("tr-inp-prompt").value;

      try {
        const res = await fetch("/api/recent-tasks/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId,
            mode,
            agent: agent || undefined,
            model: model || undefined,
            account: account || undefined,
            prompt: prompt || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || "操作失败");
        closeModal("modal-task-retry");
        showToast("🚀 " + (data.message || "任务已派发执行"));
        loadRecentTasks();
      } catch (err) {
        alert("执行失败: " + err.message);
      }
    }

    async function loadRecentTasks() {
      const statusFilter = document.getElementById("filter-task-status")?.value || "active";
      const viewTasks = document.getElementById("view-tasks-container");
      const viewReqs = document.getElementById("view-requirements-container");
      const viewQueue = document.getElementById("view-queue-container");

      if (statusFilter === "requirements") {
        if (viewTasks) viewTasks.style.display = "none";
        if (viewQueue) viewQueue.style.display = "none";
        if (viewReqs) viewReqs.style.display = "block";
        loadRequirements();
        return;
      } else if (statusFilter === "queue") {
        if (viewTasks) viewTasks.style.display = "none";
        if (viewReqs) viewReqs.style.display = "none";
        if (viewQueue) viewQueue.style.display = "block";
        loadQueue();
        return;
      } else {
        if (viewTasks) viewTasks.style.display = "block";
        if (viewReqs) viewReqs.style.display = "none";
        if (viewQueue) viewQueue.style.display = "none";
      }

      const tbody = document.getElementById("recent-tasks-tbody");
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>';

      try {
        // Query tasks from backend
        let queryParam = "";
        if (statusFilter === "active") {
          queryParam = ""; // fetch all recent, filter client-side for active and compute cards
        } else if (statusFilter === "all") {
          queryParam = "";
        } else {
          queryParam = "?status=" + encodeURIComponent(statusFilter);
        }

        const res = await fetch("/api/recent-tasks" + queryParam);
        if (!res.ok) throw new Error("获取最近任务失败");
        const data = await res.json();
        const allFetchedTasks = data.tasks || [];

        // Compute Overview Metrics Cards
        updateOverviewCards(allFetchedTasks);

        // Filter list based on selected view
        if (statusFilter === "active") {
          cachedRecentTasks = allFetchedTasks.filter(t => 
            t.status === "running" || t.status === "queued" || t.status === "paused_quota" || t.status === "paused"
          );
        } else {
          cachedRecentTasks = allFetchedTasks;
        }

        // Clean selectedTaskIds not in cached list
        const validIds = new Set(cachedRecentTasks.map(t => t.taskId));
        for (const sid of Array.from(selectedTaskIds)) {
          if (!validIds.has(sid)) selectedTaskIds.delete(sid);
        }
        updateBatchBar();

        if (cachedRecentTasks.length === 0) {
          const emptyHint = statusFilter === "active"
            ? "当前暂无活跃中的任务（运行中、排队中或暂停中）"
            : "暂无匹配的任务执行记录";
          tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:24px;">' + emptyHint + '</td></tr>';
          return;
        }

        tbody.innerHTML = cachedRecentTasks.map(t => {
          let badgeClass = "badge-queued";
          let statusText = t.status || "queued";
          if (t.status === "running") { badgeClass = "badge-running"; statusText = "● 运行中"; }
          else if (t.status === "completed") { badgeClass = "badge-completed"; statusText = "✓ 已完成"; }
          else if (t.status === "failed") { badgeClass = "badge-failed"; statusText = "✕ 失败"; }
          else if (t.status === "paused_quota") { badgeClass = "badge-paused"; statusText = "⏸ 额度暂停"; }
          else if (t.status === "paused") { badgeClass = "badge-paused"; statusText = "⏸ 队列暂停"; }
          if (t.state === "suspected_stalled") { badgeClass = "badge-paused"; statusText = "⚠ 疑似卡住"; }
          else if (t.state === "cancelled") { badgeClass = "badge-failed"; statusText = "✕ 已取消"; }

          const prLink = t.pr_url
            ? '<a href="' + t.pr_url + '" target="_blank" style="color:var(--accent); text-decoration:none; display:inline-flex; align-items:center; gap:4px; font-size:12px;">🔗 查看 PR</a>'
            : '<span style="color:var(--text-muted);">-</span>';

          const tidDisplay = '<span style="font-family:monospace; color:var(--accent); cursor:pointer;" title="点击复制 ID" onclick="navigator.clipboard.writeText(\\'' + t.taskId + '\\'); showToast(\\'已复制: ' + t.taskId + '\\');">' + t.taskId + '</span>';

          const sessionDisplay = t.session_id ? '<span style="font-family:monospace; font-size:12px;" title="' + escapeHtml(t.session_id) + '">' + escapeHtml(t.session_id.slice(0, 16)) + (t.session_id.length > 16 ? '...' : '') + '</span>' : (t.project ? '<span>' + escapeHtml(t.project) + '</span>' : '<span style="color:var(--text-muted);">-</span>');
          
          const activityDisplay = formatActivityAgo(t.last_activity_at || t.finished_at || t.created_at);

          const createdDisplay = t.created_at ? '<span style="font-size:12px; font-family:monospace;" title="' + escapeHtml(t.created_at) + '">' + formatTimeCompact(t.created_at) + '</span>' : '<span style="color:var(--text-muted);">-</span>';

          let finishedDisplay = "-";
          if (t.status === "running") {
            finishedDisplay = '<span style="color:var(--accent); font-size:12px;">进行中' + (t.elapsed ? ' (' + t.elapsed + ')' : '') + '</span>';
          } else if (t.finished_at) {
            finishedDisplay = '<span style="font-size:12px; font-family:monospace;" title="' + escapeHtml(t.finished_at) + '">' + formatTimeCompact(t.finished_at) + '</span>';
          } else {
            finishedDisplay = '<span style="color:var(--text-muted);">-</span>';
          }

          const logDisplay = t.reason
            ? '<span style="font-family:monospace; font-size:12px; color:var(--red); word-break:break-all;" title="reason">' + escapeHtml(t.reason) + '</span>'
            : t.last_log_line
            ? '<span style="font-family:monospace; font-size:12px; color:var(--text-muted); word-break:break-all;">' + escapeHtml(t.last_log_line) + '</span>'
            : '<span style="color:var(--text-muted);">-</span>';

          const isChecked = selectedTaskIds.has(t.taskId) ? "checked" : "";
          const chkCol = '<td style="text-align:center;"><input type="checkbox" class="chk-task-item" ' + isChecked + ' onchange="toggleTaskSelection(\\'' + t.taskId + '\\', this.checked)"></td>';

          // Action buttons group
          let actionsHtml = '<div style="display:flex; justify-content:flex-end; gap:4px; flex-wrap:wrap;">';

          // 1. Details & Logs
          actionsHtml += '<button class="btn-sm" style="padding:2px 6px;" title="查看详情与完整规格" onclick="openTaskDetailsModal(\\'' + t.taskId + '\\')">详情</button>';
          actionsHtml += '<button class="btn-sm" style="padding:2px 6px;" title="查看实时/历史尾部日志" onclick="openTaskLogsModal(\\'' + t.taskId + '\\')">日志</button>';

          // 2. State-specific action buttons
          if (t.status === "running") {
            actionsHtml += '<button class="btn-sm btn-sm-danger" style="padding:2px 6px;" onclick="cancelRecentTask(\\'' + t.taskId + '\\')">✕ 取消</button>';
          } else if (t.status === "paused_quota" || t.status === "paused") {
            actionsHtml += '<button class="btn-sm" style="color:var(--green); border-color:rgba(16,185,129,0.4); padding:2px 6px;" onclick="openTaskRetryModal(\\'' + t.taskId + '\\', \\'continue\\')">▶ 续跑</button>';
            actionsHtml += '<button class="btn-sm" style="color:var(--accent); border-color:rgba(56,189,248,0.4); padding:2px 6px;" onclick="openTaskRetryModal(\\'' + t.taskId + '\\', \\'switch_account\\')">换号</button>';
            if (t.session_id) {
              actionsHtml += '<button class="btn-sm" style="color:var(--yellow); border-color:rgba(245,158,11,0.4); padding:2px 6px;" title="挂起此会话队列" onclick="toggleTaskSessionPause(\\'' + t.session_id + '\\', true)">挂起</button>';
            }
            actionsHtml += '<button class="btn-sm btn-sm-danger" style="padding:2px 6px;" onclick="cancelRecentTask(\\'' + t.taskId + '\\')">✕</button>';
          } else if (t.status === "failed" || t.state === "cancelled") {
            actionsHtml += '<button class="btn-sm" style="color:var(--green); border-color:rgba(16,185,129,0.4); padding:2px 6px;" onclick="openTaskRetryModal(\\'' + t.taskId + '\\', \\'continue\\')">重试</button>';
            actionsHtml += '<button class="btn-sm" style="color:var(--accent); border-color:rgba(56,189,248,0.4); padding:2px 6px;" onclick="openTaskRetryModal(\\'' + t.taskId + '\\', \\'switch_account\\')">改派</button>';
            actionsHtml += '<button class="btn-sm btn-sm-danger" style="padding:2px 6px;" title="归档删除此任务记录" onclick="archiveRecentTask(\\'' + t.taskId + '\\', false)">🗑️</button>';
          } else if (t.status === "completed") {
            if (t.pr_url) {
              actionsHtml += '<a href="' + t.pr_url + '" target="_blank" class="btn-sm" style="text-decoration:none; padding:2px 6px; color:var(--accent); border-color:rgba(56,189,248,0.4);">PR ↗</a>';
            }
            actionsHtml += '<button class="btn-sm btn-sm-danger" style="padding:2px 6px;" title="归档清理记录" onclick="archiveRecentTask(\\'' + t.taskId + '\\', false)">🗑️</button>';
          } else {
            actionsHtml += '<button class="btn-sm btn-sm-danger" style="padding:2px 6px;" onclick="cancelRecentTask(\\'' + t.taskId + '\\')">✕ 取消</button>';
          }

          // Copy prompt shortcut
          actionsHtml += '<button class="btn-sm" style="padding:2px 5px;" title="复制任务提示词" onclick="copyTaskPromptDirect(\\'' + t.taskId + '\\')">📋</button>';
          actionsHtml += '</div>';

          return '<tr>' +
            chkCol +
            '<td>' + tidDisplay + '</td>' +
            '<td>' + sessionDisplay + '</td>' +
            '<td><span class="badge ' + badgeClass + '">' + statusText + '</span></td>' +
            '<td>' + activityDisplay + '</td>' +
            '<td>' + createdDisplay + '</td>' +
            '<td>' + finishedDisplay + '</td>' +
            '<td>' + prLink + '</td>' +
            '<td>' + logDisplay + '</td>' +
            '<td style="text-align:right;">' + actionsHtml + '</td>' +
            '</tr>';
        }).join("");
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--red); padding:24px;">加载失败: ' + err.message + '</td></tr>';
      }
    }

    function updateOverviewCards(tasks) {
      const now = new Date();
      const todayYMD = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");

      let running = 0;
      let queued = 0;
      let paused = 0;
      let completedToday = 0;
      let failedToday = 0;

      tasks.forEach(t => {
        if (t.status === "running") running++;
        else if (t.status === "queued") queued++;
        else if (t.status === "paused_quota" || t.status === "paused") paused++;

        const isToday = (t.finished_at && t.finished_at.startsWith(todayYMD)) || (t.created_at && t.created_at.startsWith(todayYMD));
        if (isToday) {
          if (t.status === "completed") completedToday++;
          else if (t.status === "failed" || t.state === "cancelled") failedToday++;
        }
      });

      const elRun = document.getElementById("ov-running");
      const elQue = document.getElementById("ov-queued");
      const elPau = document.getElementById("ov-paused");
      const elComp = document.getElementById("ov-completed-today");
      const elFail = document.getElementById("ov-failed-today");

      if (elRun) elRun.textContent = String(running);
      if (elQue) elQue.textContent = String(queued);
      if (elPau) elPau.textContent = String(paused);
      if (elComp) elComp.textContent = String(completedToday);
      if (elFail) elFail.textContent = String(failedToday);
    }

    // --- Tab 2: Requirements Backlog ---
    let cachedRequirements = [];
    async function loadRequirements() {
      const tbody = document.getElementById("requirements-tbody");
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>';

      try {
        const res = await fetch("/api/requirements");
        if (!res.ok) throw new Error("获取需求失败");
        const data = await res.json();
        cachedRequirements = data.requirements || [];

        if (cachedRequirements.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">暂存箱中暂无需求记录，点击右上角「暂存新需求」添加</td></tr>';
          return;
        }

        tbody.innerHTML = cachedRequirements.map(r => {
          let badgeClass = "badge-queued";
          if (r.status === "dispatched") badgeClass = "badge-completed";
          else if (r.status === "merged") badgeClass = "badge-running";
          else if (r.status === "archived") badgeClass = "badge-paused";

          const idDisplay = '<span style="font-family:monospace; font-size:12px; color:var(--accent);">' + r.id + '</span>';
          const projDisplay = '<strong>' + escapeHtml(r.project) + '</strong>';
          const topicDisplay = r.topic ? '<span style="font-family:monospace; font-size:12px;">' + escapeHtml(r.topic) + '</span>' : '<span style="color:var(--text-muted);">-</span>';
          const titleDesc = '<div><strong>' + escapeHtml(r.title) + '</strong></div>' +
            (r.raw_text ? '<div style="font-size:12px; color:var(--text-muted); margin-top:4px; max-height:42px; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(r.raw_text.slice(0, 100)) + (r.raw_text.length > 100 ? '...' : '') + '</div>' : '');
          const dateDisplay = r.created_at ? new Date(r.created_at).toLocaleDateString() : "-";

          const actions = 
            '<div style="display:flex; justify-content:flex-end; gap:6px;">' +
              (r.status !== "dispatched" ? '<button class="btn-sm" style="color:var(--accent); border-color:rgba(56,189,248,0.4);" onclick="openDispatchModal(\\'' + r.id + '\\')">🚀 派发</button>' : '<span style="font-size:11px; color:var(--text-muted); align-self:center;">已派发</span>') +
              (r.status !== "archived" ? '<button class="btn-sm" onclick="archiveRequirement(\\'' + r.id + '\\')">📦 归档</button>' : '') +
              '<button class="btn-sm btn-sm-danger" onclick="deleteRequirement(\\'' + r.id + '\\')">🗑️</button>' +
            '</div>';

          return '<tr>' +
            '<td>' + idDisplay + '</td>' +
            '<td>' + projDisplay + '</td>' +
            '<td>' + topicDisplay + '</td>' +
            '<td>' + titleDesc + '</td>' +
            '<td><span class="badge ' + badgeClass + '">' + r.status + '</span></td>' +
            '<td>' + dateDisplay + '</td>' +
            '<td>' + actions + '</td>' +
            '</tr>';
        }).join("");
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--red); padding:24px;">加载失败: ' + err.message + '</td></tr>';
      }
    }

    function openCreateRequirementModal() {
      document.getElementById("req-inp-title").value = "";
      document.getElementById("req-inp-project").value = "agent-bridge";
      document.getElementById("req-inp-topic").value = "";
      document.getElementById("req-inp-tags").value = "";
      document.getElementById("req-inp-raw").value = "";
      openModal("modal-req");
    }

    async function submitCreateRequirement() {
      const title = document.getElementById("req-inp-title").value.trim();
      const project = document.getElementById("req-inp-project").value.trim();
      const topic = document.getElementById("req-inp-topic").value.trim();
      const tagsRaw = document.getElementById("req-inp-tags").value.trim();
      const raw_text = document.getElementById("req-inp-raw").value.trim();

      if (!title || !project || !raw_text) {
        alert("请填写完整的需求标题、项目归属及详细规格说明！");
        return;
      }

      const tags = tagsRaw.split(/[,，]/).map(t => t.trim()).filter(Boolean);

      try {
        const res = await fetch("/api/requirements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create",
            title,
            project,
            topic: topic || undefined,
            tags,
            raw_text,
          }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "创建失败");
        closeModal("modal-req");
        showToast("✅ 需求暂存成功！");
        loadRequirements();
      } catch (err) {
        alert("暂存需求失败: " + err.message);
      }
    }

    function openDispatchModal(reqId) {
      const r = cachedRequirements.find(item => item.id === reqId);
      if (!r) return;
      document.getElementById("dispatch-req-id").value = reqId;
      document.getElementById("dispatch-req-desc").textContent = "需求：" + r.title + " (项目: " + r.project + ")";
      document.getElementById("dispatch-inp-model").value = "";
      document.getElementById("dispatch-inp-account").value = "auto";
      document.getElementById("dispatch-chk-queue").checked = true;

      // Populate agents select
      const selAgent = document.getElementById("dispatch-sel-agent");
      const agentNames = Object.keys(currentConfig.agents);
      if (agentNames.length === 0) agentNames.push("codex", "agy");
      selAgent.innerHTML = agentNames.map(name => '<option value="' + name + '">' + name + '</option>').join("");

      openModal("modal-dispatch");
    }

    async function submitDispatchRequirement() {
      const id = document.getElementById("dispatch-req-id").value;
      const agent = document.getElementById("dispatch-sel-agent").value;
      const model = document.getElementById("dispatch-inp-model").value.trim() || undefined;
      const account = document.getElementById("dispatch-inp-account").value.trim() || undefined;
      const queue_if_busy = document.getElementById("dispatch-chk-queue").checked;

      try {
        const res = await fetch("/api/requirements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "dispatch",
            id,
            agent,
            model,
            account,
            queue_if_busy,
          }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "派发失败");
        closeModal("modal-dispatch");
        showToast(d.queued ? "⏳ 已加入会话排队队列" : "🚀 任务派发成功！Task ID: " + d.taskId);
        loadRequirements();
      } catch (err) {
        alert("派发任务失败: " + err.message);
      }
    }

    async function archiveRequirement(id) {
      if (!confirm("确认将需求 " + id + " 归档吗？")) return;
      try {
        const res = await fetch("/api/requirements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "archive", id }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "归档失败");
        showToast("📦 需求已归档");
        loadRequirements();
      } catch (err) {
        alert("归档失败: " + err.message);
      }
    }

    async function deleteRequirement(id) {
      if (!confirm("确认永久删除需求 " + id + " 吗？不可撤销。")) return;
      try {
        const res = await fetch("/api/requirements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", id }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "删除失败");
        showToast("🗑️ 需求已删除");
        loadRequirements();
      } catch (err) {
        alert("删除失败: " + err.message);
      }
    }

    // --- Tab 3: Auto Queue ---
    async function loadQueue() {
      const container = document.getElementById("queue-sessions-container");
      if (!container) return;
      container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</div>';

      try {
        const res = await fetch("/api/queue");
        if (!res.ok) throw new Error("获取排队列表失败");
        const data = await res.json();
        const queues = data.queues || [];

        if (queues.length === 0 || queues.every(q => q.items.length === 0)) {
          container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:24px;">当前没有活跃的会话排队队列。当任务选择排队模式时将在此自动按会话序列排队。</div>';
          return;
        }

        container.innerHTML = queues.filter(q => q.items && q.items.length > 0).map(q => {
          const pauseBadge = q.paused
            ? '<span class="badge badge-paused">⏸ 已暂停 (' + escapeHtml(q.pause_reason || "手动暂停") + ')</span>'
            : '<span class="badge badge-completed">▶ 自动调度中</span>';

          const pauseBtn = q.paused
            ? '<button class="btn-sm" style="color:var(--green); border-color:rgba(16,185,129,0.4);" onclick="resumeSessionQueue(\\'' + q.session_id + '\\')">▶ 恢复调度</button>'
            : '<button class="btn-sm" style="color:var(--yellow); border-color:rgba(245,158,11,0.4);" onclick="pauseSessionQueue(\\'' + q.session_id + '\\')">⏸ 暂停队列</button>';

          const rows = q.items.map((it, idx) => {
            const modeToggleBtn = '<button class="btn-sm" onclick="toggleQueueItemMode(\\'' + it.id + '\\', \\'' + it.mode + '\\')">' + (it.mode === "auto" ? "⚡ 自动派发" : "🔔 仅提醒") + '</button>';
            const cancelBtn = '<button class="btn-sm btn-sm-danger" onclick="cancelQueueItem(\\'' + it.id + '\\')">✕ 取消</button>';
            const moveUpBtn = idx > 0 ? '<button class="btn-sm" onclick="moveQueueItem(\\'' + q.session_id + '\\', \\'' + it.id + '\\', ' + (it.position - 1) + ')">▲</button>' : '';
            const moveDownBtn = idx < q.items.length - 1 ? '<button class="btn-sm" onclick="moveQueueItem(\\'' + q.session_id + '\\', \\'' + it.id + '\\', ' + (it.position + 1) + ')">▼</button>' : '';

            return '<tr>' +
              '<td style="width:50px; font-weight:bold; color:var(--accent);">#' + it.position + '</td>' +
              '<td style="width:130px; font-family:monospace; font-size:12px;">' + it.id + '</td>' +
              '<td style="width:90px;"><span class="badge ' + (it.status === "ready" ? "badge-running" : "badge-queued") + '">' + it.status + '</span></td>' +
              '<td style="width:110px;">' + modeToggleBtn + '</td>' +
              '<td><span style="font-size:12px; color:var(--text-main);">' + escapeHtml(it.prompt.slice(0, 80)) + (it.prompt.length > 80 ? '...' : '') + '</span></td>' +
              '<td style="width:130px; text-align:right;"><div style="display:flex; justify-content:flex-end; gap:4px;">' + moveUpBtn + moveDownBtn + cancelBtn + '</div></td>' +
              '</tr>';
          }).join("");

          return '<div style="background:rgba(255,255,255,0.02); border:1px solid var(--card-border); border-radius:10px; padding:16px; margin-bottom:16px;">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">' +
              '<div style="display:flex; align-items:center; gap:10px;">' +
                '<span style="font-weight:700; font-family:monospace; color:var(--text-main);">会话: ' + escapeHtml(q.session_id) + '</span>' +
                pauseBadge +
              '</div>' +
              '<div>' + pauseBtn + '</div>' +
            '</div>' +
            '<table class="data-table"><thead><tr><th>位次</th><th>排队 ID</th><th>状态</th><th>调度模式</th><th>Prompt 预览</th><th style="text-align:right;">操作</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>' +
            '</div>';
        }).join("");
      } catch (err) {
        container.innerHTML = '<div style="text-align:center; color:var(--red); padding:24px;">加载队列失败: ' + err.message + '</div>';
      }
    }

    async function pauseSessionQueue(sessionId) {
      try {
        const res = await fetch("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pause", session_id: sessionId, reason: "手动暂停" }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error("暂停队列失败");
        showToast("⏸ 队列已暂停");
        loadQueue();
      } catch (err) {
        alert(err.message);
      }
    }

    async function resumeSessionQueue(sessionId) {
      try {
        const res = await fetch("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resume", session_id: sessionId }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error("恢复队列失败");
        showToast("▶ 队列已恢复调度");
        loadQueue();
      } catch (err) {
        alert(err.message);
      }
    }

    async function cancelQueueItem(id) {
      if (!confirm("确认取消此排队任务？")) return;
      try {
        const res = await fetch("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel", id }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error("取消失败");
        showToast("✕ 排队任务已取消");
        loadQueue();
      } catch (err) {
        alert(err.message);
      }
    }

    async function toggleQueueItemMode(id, curMode) {
      const nextMode = curMode === "auto" ? "notify" : "auto";
      try {
        const res = await fetch("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update", id, mode: nextMode }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error("模式切换失败");
        showToast("模式已切换为: " + nextMode);
        loadQueue();
      } catch (err) {
        alert(err.message);
      }
    }

    async function moveQueueItem(sessionId, id, toPosition) {
      try {
        const res = await fetch("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reorder", session_id: sessionId, move_id: id, to_position: toPosition }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error("调整次序失败");
        showToast("位次调整成功");
        loadQueue();
      } catch (err) {
        alert(err.message);
      }
    }

    // --- Tab 4: Account Pool & Cockpit ---
    async function loadPool() {
      const cockpitTbody = document.getElementById("cockpit-accounts-tbody");
      const profilesTbody = document.getElementById("pool-profiles-tbody");
      if (cockpitTbody) cockpitTbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>';
      if (profilesTbody) profilesTbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:24px;">加载中...</td></tr>';

      try {
        const res = await fetch("/api/pool");
        if (!res.ok) throw new Error("获取账号池信息失败");
        const data = await res.json();
        lastPoolData = data;

        // 1. Render Cockpit accounts
        const cAccounts = data.cockpitAccounts || [];
        if (cockpitTbody) {
          if (cAccounts.length === 0) {
            cockpitTbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:24px;">未检测到 Cockpit 本地账号数据 (请确认 ~/.antigravity_cockpit 存在)</td></tr>';
          } else {
            cockpitTbody.innerHTML = cAccounts.map(ca => {
              const fraction = typeof ca.remainingFractionSummary === "number" ? ca.remainingFractionSummary : 1.0;
              const pct = Math.round(fraction * 100);
              let barColor = "var(--green)";
              if (pct < 20) barColor = "var(--red)";
              else if (pct < 50) barColor = "var(--yellow)";

              const quotaBar = 
                '<div style="display:flex; align-items:center;">' +
                  '<div class="quota-track"><div class="quota-fill" style="width:' + pct + '%; background:' + barColor + ';"></div></div>' +
                  '<span style="font-size:12px; font-weight:600; color:' + barColor + ';">' + pct + '%</span>' +
                '</div>';

              const activeBadge = ca.current
                ? '<span class="badge badge-completed">★ 当前主账号</span>'
                : '<span style="color:var(--text-muted); font-size:12px;">备选</span>';

              const switchBtn = !ca.current
                ? '<button class="btn-sm" style="color:var(--accent); border-color:rgba(56,189,248,0.4);" onclick="switchCockpitAccount(\\'' + ca.accountId + '\\')">切换主账号</button>'
                : '<span style="color:var(--green); font-size:12px;">活动中</span>';

              const resetDisplay = ca.resetTime ? new Date(ca.resetTime).toLocaleTimeString() : "-";

              return '<tr>' +
                '<td style="font-family:monospace; font-size:12px;">' + ca.accountId + '</td>' +
                '<td><strong>' + escapeHtml(ca.email) + '</strong></td>' +
                '<td>' + activeBadge + '</td>' +
                '<td>' + quotaBar + '</td>' +
                '<td>' + resetDisplay + '</td>' +
                '<td style="text-align:right;">' + switchBtn + '</td>' +
                '</tr>';
            }).join("");
          }
        }

        // 0. Account overview + custom pool toggle
        const toggle = document.getElementById("custom-pool-toggle");
        if (toggle) toggle.checked = data.custom_pool_enabled !== false;
        const toggleLabel = document.getElementById("custom-pool-toggle-label");
        if (toggleLabel) toggleLabel.textContent = data.custom_pool_enabled !== false ? "自定义池：已启用" : "自定义池：已停用（全部走默认池）";
        const accTbody = document.getElementById("pool-accounts-tbody");
        if (accTbody) {
          const accs = data.accounts || [];
          accTbody.innerHTML = accs.length === 0
            ? '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:24px;">暂无账号</td></tr>'
            : accs.map(function(a) {
                const pools = (a.pools || []).map(function(pl) {
                  return pl === "default" ? '<span class="badge badge-completed">默认池</span>' : '<span class="badge badge-running">自定义池' + (a.aliases && a.aliases.length ? ' (' + escapeHtml(a.aliases.join(",")) + ')' : '') + '</span>';
                }).join(" ") + (a.cockpit_current ? ' <span style="font-size:11px; color:var(--green);">★当前</span>' : '');
                const quota = a.quota_remaining === "unknown" ? "unknown" : Math.round(parseFloat(a.quota_remaining) * 100) + "%";
                const paused = a.paused_until && a.paused_until !== "none"
                  ? '<span class="badge badge-paused">至 ' + new Date(a.paused_until).toLocaleString() + '</span>' + (a.pause_reason ? '<div style="font-size:11px; color:var(--text-muted);">' + escapeHtml(a.pause_reason) + '</div>' : '')
                  : '<span style="color:var(--text-muted); font-size:12px;">无</span>';
                const busy = a.running_task_count > 0
                  ? '<span class="badge badge-running">● ' + a.running_task_count + ' running</span>' +
                    (a.busy_task_id && a.busy_task_id !== "idle"
                      ? '<div style="font-size:11px; color:var(--text-muted); font-family:monospace;">' + escapeHtml(a.busy_task_id) + '</div>'
                      : "")
                  : '<span style="color:var(--text-muted); font-size:12px;">空闲</span>';
                const act = a.paused_until && a.paused_until !== "none"
                  ? '<button class="btn-sm" style="color:var(--green);" onclick="resumeAccountEmail(\\'' + escapeHtml(a.email) + '\\')">▶ 解除暂停</button>'
                  : '';
                return '<tr><td><strong>' + escapeHtml(a.email) + '</strong></td><td>' + pools + '</td><td>' + quota + '</td><td>' + paused + '</td><td>' + busy + '</td><td style="text-align:right;">' + act + '</td></tr>';
              }).join("");
        }

        // 2. Render Profiles
        const profiles = data.profiles || [];
        const poolStatus = data.pool || [];
        const runningTasks = data.runningTasks || {};

        if (profilesTbody) {
          if (profiles.length === 0) {
            profilesTbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:24px;">暂无 agy Profile 配置。点击「+ 初始化新 Profile」创建独立账号环境。</td></tr>';
          } else {
            profilesTbody.innerHTML = profiles.map(p => {
              const stat = poolStatus.find(s => s.alias === p.alias);
              const isRunning = runningTasks[p.alias] && runningTasks[p.alias].length > 0;
              const runningCount = runningTasks[p.alias] ? runningTasks[p.alias].length : 0;
              const runningTaskIds = runningTasks[p.alias] ? runningTasks[p.alias].join(", ") : "闲置 (idle)";

              const statusBadge = p.enabled && (!p.paused_until || new Date(p.paused_until).getTime() <= Date.now())
                ? '<span class="badge badge-completed">ACTIVE</span>'
                : '<span class="badge badge-paused">PAUSED</span>';

              const loginStatus = stat && stat.login_status ? stat.login_status : "logged_out";
              const loginLabel = stat && stat.login_label ? stat.login_label : "未登录";
              const loginReason = stat && stat.login_reason ? String(stat.login_reason) : "";
              let loginBadge = '<span class="badge badge-paused">' + escapeHtml(loginLabel) + '</span>';
              if (loginStatus === "logged_in") loginBadge = '<span class="badge badge-completed">' + escapeHtml(loginLabel) + '</span>';
              else if (loginStatus === "login_failed" || loginStatus === "needs_relogin") loginBadge = '<span class="badge" style="background:rgba(239,68,68,0.15); color:var(--red);">' + escapeHtml(loginLabel) + '</span>';
              else if (loginStatus === "awaiting_code") loginBadge = '<span class="badge badge-running">' + escapeHtml(loginLabel) + '</span>';
              if (loginReason) {
                loginBadge += '<div style="font-size:11px; color:var(--text-muted); margin-top:4px; max-width:160px; white-space:normal;">' + escapeHtml(loginReason) + '</div>';
              }

              const quotaFrac = stat ? stat.cockpit_remaining : "unknown";

              const actions = 
                '<div style="display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap;">' +
                  (p.enabled ? '<button class="btn-sm" onclick="pauseProfile(\\'' + p.alias + '\\')">⏸ 暂停</button>' : '<button class="btn-sm" style="color:var(--green);" onclick="resumeProfile(\\'' + p.alias + '\\')">▶ 恢复</button>') +
                  '<button class="btn-sm" onclick="bindEmailProfile(\\'' + p.alias + '\\')">🔗 绑定邮箱</button>' +
                  '<button class="btn-sm" style="color:var(--accent);" onclick="syncProfileAuth(\\'' + p.alias + '\\')">⟳ 同步登录</button>' +
                  '<button class="btn-sm" onclick="showLoginCmd(\\'' + p.home + '\\', \\'' + p.alias + '\\')">🔑 登录</button>' +
                  '<button class="btn-sm" style="color:var(--red);" onclick="removeProfile(\\'' + p.alias + '\\')">🗑 删除</button>' +
                '</div>';

              return '<tr>' +
                '<td style="font-weight:700; color:var(--accent);">' + escapeHtml(p.alias) + '</td>' +
                '<td><span style="font-family:monospace; font-size:12px; color:var(--text-muted);">' + escapeHtml(p.home) + '</span></td>' +
                '<td>' + (p.email ? escapeHtml(p.email) : '<span style="color:var(--yellow); font-size:12px;">(未对齐邮箱)</span>') + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + loginBadge + '</td>' +
                '<td>' + (isRunning ? '<span class="badge badge-running">● ' + runningCount + ' running</span><div style="font-size:11px; font-family:monospace; color:var(--text-muted);">' + escapeHtml(runningTaskIds) + '</div>' : '<span style="color:var(--text-muted); font-size:12px;">闲置</span>') + '</td>' +
                '<td>' + (p.tasks_today || 0) + '</td>' +
                '<td>' + quotaFrac + '</td>' +
                '<td>' + actions + '</td>' +
                '</tr>';
            }).join("");
          }
        }
      } catch (err) {
        if (cockpitTbody) cockpitTbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--red); padding:24px;">加载失败: ' + err.message + '</td></tr>';
        if (profilesTbody) profilesTbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--red); padding:24px;">加载失败: ' + err.message + '</td></tr>';
      }
    }

    async function toggleCustomPool(enabled) {
      try {
        await fetch("/api/pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_custom_enabled", enabled: !!enabled }) });
      } catch (e) { alert("切换失败: " + e.message); }
      loadPool();
    }

    async function resumeAccountEmail(email) {
      try {
        await fetch("/api/pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume_email", email: email }) });
      } catch (e) { alert("操作失败: " + e.message); }
      loadPool();
    }

    async function removeProfile(alias) {
      if (!confirm("确认删除 Profile「" + alias + "」？（同时删除其独立 HOME 目录）")) return;
      try {
        const res = await fetch("/api/pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", alias: alias, delete_home: true }) });
        const data = await res.json();
        if (!data.success) alert("删除失败: " + (data.error || "未知错误"));
      } catch (e) { alert("删除失败: " + e.message); }
      loadPool();
    }

    async function initNewProfileModal() {
      const listEl = document.getElementById("init-profile-account-list");
      if (!listEl) return;
      listEl.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:16px;">加载账号列表...</div>';
      openModal("modal-init-profile");

      try {
        if (!lastPoolData || !(lastPoolData.cockpitAccounts || []).length) {
          const res = await fetch("/api/pool");
          if (!res.ok) throw new Error("获取账号池信息失败");
          lastPoolData = await res.json();
        }

        const accounts = lastPoolData.cockpitAccounts || [];
        const profiles = lastPoolData.profiles || [];
        const boundByEmail = {};
        profiles.forEach(function(p) {
          if (p.email) boundByEmail[String(p.email).toLowerCase()] = p.alias;
        });

        if (accounts.length === 0) {
          listEl.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:16px;">未检测到 Cockpit 账号。请确认 ~/.antigravity_cockpit 存在。</div>';
          return;
        }

        listEl.innerHTML = accounts.map(function(ca, idx) {
          const email = ca.email || "";
          const emailKey = String(email).toLowerCase();
          const boundAlias = boundByEmail[emailKey];
          const fraction = typeof ca.remainingFractionSummary === "number" ? ca.remainingFractionSummary : 1.0;
          const pct = Math.round(fraction * 100);
          const meta = escapeHtml(email) +
            '<div style="font-size:12px; color:var(--text-muted); margin-top:4px;">额度 ' + pct + '% · ID ' + escapeHtml(ca.accountId || "") + '</div>';

          if (boundAlias) {
            return '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 14px; border:1px solid var(--card-border); border-radius:10px; opacity:0.55;">' +
              '<div>' + meta + '<div style="font-size:12px; color:var(--yellow); margin-top:4px;">已绑定 Profile: ' + escapeHtml(boundAlias) + '</div></div>' +
              '<button class="btn-sm" disabled style="opacity:0.6; cursor:not-allowed;">不可选</button>' +
              '</div>';
          }

          return '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 14px; border:1px solid rgba(56,189,248,0.35); border-radius:10px; background:rgba(56,189,248,0.06);">' +
            '<div>' + meta + '<div style="font-size:12px; color:var(--text-muted); margin-top:4px;">别名 / HOME 将按邮箱自动生成</div></div>' +
            '<button class="btn-primary" style="white-space:nowrap;" onclick="confirmInitProfileFromAccount(' + idx + ')">初始化</button>' +
            '</div>';
        }).join("");
      } catch (err) {
        listEl.innerHTML = '<div style="text-align:center; color:var(--red); padding:16px;">加载失败: ' + escapeHtml(err.message || String(err)) + '</div>';
      }
    }

    async function confirmInitProfileFromAccount(idx) {
      const accounts = (lastPoolData && lastPoolData.cockpitAccounts) || [];
      const ca = accounts[idx];
      if (!ca || !ca.email) {
        alert("无效的 Cockpit 账号选择");
        return;
      }
      const email = String(ca.email).trim();
      if (!confirm("确认为账号 " + email + " 初始化独立 Profile？\\n将自动从 Cockpit 同步该账号的 agy 登录态到独立 HOME。")) return;

      try {
        showToast("正在初始化 Profile...");
        const res = await fetch("/api/pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "init",
            email: email,
            cockpit_account_id: ca.accountId || undefined
          }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "初始化失败");
        closeModal("modal-init-profile");
        if (d.authSync && d.authSync.success === false) {
          showToast("⚠ Profile 已创建，但 Cockpit 登录同步失败");
          alert("Profile 已创建，但同步 Cockpit 登录态失败：\\n" + (d.authSync.error || d.login_reason || "未知错误") + "\\n\\n可稍后在列表中点「同步登录」重试。");
        } else {
          const loginMsg = d.login_label ? ("，登录状态：" + d.login_label) : "";
          showToast("✅ Profile " + (d.profile && d.profile.alias ? d.profile.alias : "") + " 初始化成功" + loginMsg);
        }
        await loadPool();
        if (d.profile && d.profile.home) {
          showLoginCmd(d.profile.home, d.profile.alias);
        }
      } catch (err) {
        alert("初始化 Profile 失败: " + err.message);
      }
    }

    async function pauseProfile(alias) {
      try {
        const res = await fetch("/api/pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pause", alias }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "暂停失败");
        showToast("⏸ Profile " + alias + " 已暂停");
        loadPool();
      } catch (err) {
        alert(err.message);
      }
    }

    async function resumeProfile(alias) {
      try {
        const res = await fetch("/api/pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resume", alias }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "恢复失败");
        showToast("▶ Profile " + alias + " 已恢复");
        loadPool();
      } catch (err) {
        alert(err.message);
      }
    }

    async function bindEmailProfile(alias) {
      const email = prompt("请输入要为 Profile " + alias + " 绑定的 Cockpit 邮箱：");
      if (!email) return;
      try {
        const res = await fetch("/api/pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "bind_email", alias, email: email.trim() }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "绑定失败");
        showToast("🔗 邮箱绑定成功！");
        loadPool();
      } catch (err) {
        alert(err.message);
      }
    }

    async function switchCockpitAccount(accountId) {
      if (!confirm("确认通过 Cockpit WebSocket 将主账号切换为 " + accountId + " 吗？")) return;
      try {
        showToast("正在向 Cockpit 发送切换指令...");
        const res = await fetch("/api/pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "switch_cockpit", account: accountId }),
        });
        const d = await res.json();
        if (!res.ok || !d.success) throw new Error(d.error || "切换失败");
        showToast("✅ Cockpit 主账号切换成功: " + (d.email || d.accountId));
        loadPool();
      } catch (err) {
        alert("切换失败: " + err.message);
      }
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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

        // Load System Stats & Quota & Tasks
        loadSystemStats();
        loadQuickQuota();
        loadRecentTasks();
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
        container.innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:24px 20px; border:1px dashed #334155; border-radius:10px;">暂无特定场景规则（默认直接派发至默认 Agent）。<br>您可以点击上方「+ 添加场景规则」由您自由制定属于您的场景分发规则。</div>';
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
      const hwBar = document.getElementById("compact-hw-bar");
      const hwCpu = document.getElementById("hw-cpu");
      const hwMem = document.getElementById("hw-mem");
      const hwWorker = document.getElementById("hw-worker");

      try {
        const res = await fetch("/api/system");
        if (!res.ok) return;
        const data = await res.json();
        
        // Populate settings detailed grid
        if (grid) {
          grid.innerHTML = 
            '<div class="stat-card"><div class="access-label">操作系统</div><div class="stat-num">' + (data.platform || "macOS") + ' (' + (data.arch || "arm64") + ')</div></div>' +
            '<div class="stat-card"><div class="access-label">CPU 规格</div><div class="stat-num">' + (data.cpuModel || "Apple Silicon") + ' (' + (data.cores || 8) + ' Cores)</div></div>' +
            '<div class="stat-card"><div class="access-label">内存状况</div><div class="stat-num">' + (data.freeMemGb || 0) + ' GB 可用 / ' + (data.totalMemGb || 0) + ' GB</div></div>' +
            '<div class="stat-card"><div class="access-label">后台守护进程</div><div class="stat-num" style="color:#34d399">● 运行中 (PID: ' + (data.workerPid || "Active") + ')</div></div>';
        }

        // Populate compact home hardware bar
        if (hwCpu) hwCpu.textContent = (data.cpuModel || "CPU") + " (" + (data.cores || 0) + "核)";
        if (hwMem) hwMem.textContent = (data.freeMemGb || 0) + " GB 可用 / " + (data.totalMemGb || 0) + " GB";
        if (hwWorker) {
          if (data.workerPid) {
            hwWorker.textContent = "● 正常 (PID " + data.workerPid + ")";
            hwWorker.style.color = "var(--green)";
          } else {
            hwWorker.textContent = "✕ 未检测到 PID";
            hwWorker.style.color = "var(--red)";
          }
        }

        // Anomaly highlight if free memory < 2GB or worker absent
        const freeMemNum = parseFloat(data.freeMemGb || "10");
        if (hwBar) {
          if (!data.workerPid || freeMemNum < 2.0) {
            hwBar.classList.add("warning");
          } else {
            hwBar.classList.remove("warning");
          }
        }
      } catch (e) {}
    }

    async function loadQuickQuota() {
      const grid = document.getElementById("quick-quota-grid");
      if (!grid) return;
      try {
        const res = await fetch("/api/pool");
        if (!res.ok) throw new Error("获取额度失败");
        const data = await res.json();
        lastPoolData = data;
        const accounts = data.accounts || [];

        if (accounts.length === 0) {
          grid.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:10px;">暂无本地 Cockpit 账号关联</div>';
          return;
        }

        grid.innerHTML = accounts.map(acc => {
          const email = acc.email || "-";
          const fraction = parseFloat(acc.quota_remaining || "1.0");
          const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
          const isCurrent = !!acc.cockpit_current;
          const isPaused = acc.paused_until && acc.paused_until !== "none";

          let barColor = "var(--green)";
          if (pct <= 20) barColor = "var(--red)";
          else if (pct <= 50) barColor = "var(--yellow)";

          let statusTag = '<span style="font-size:11px; color:var(--green);">● 正常</span>';
          if (isPaused) {
            const pauseTimeStr = formatTimeCompact(acc.paused_until);
            statusTag = '<span style="font-size:11px; color:var(--purple);">⏸ 暂停至 ' + pauseTimeStr + '</span>';
          } else if (pct <= 5) {
            statusTag = '<span style="font-size:11px; color:var(--red);">⚠ 额度耗尽</span>';
          }

          let resetTag = "";
          if (acc.reset_time) {
            resetTag = '<span style="font-size:11px; color:var(--text-muted);">重置: ' + formatTimeCompact(acc.reset_time) + '</span>';
          }

          return '<div class="quota-chip">' +
            '<div class="quota-chip-header">' +
              '<div style="font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px;">' +
                (isCurrent ? '<span style="color:var(--accent);" title="当前 Cockpit 主账号">★</span>' : '') +
                escapeHtml(email) +
              '</div>' +
              '<div style="font-family:monospace; font-weight:700; color:' + barColor + ';">' + pct + '%</div>' +
            '</div>' +
            '<div class="quota-chip-bar">' +
              '<div class="quota-chip-fill" style="width:' + pct + '%; background:' + barColor + ';"></div>' +
            '</div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">' +
              statusTag +
              resetTag +
            '</div>' +
          '</div>';
        }).join("");
      } catch (err) {
        grid.innerHTML = '<div style="color:var(--red); font-size:12px; padding:10px;">读取账号额度异常: ' + escapeHtml(err.message) + '</div>';
      }
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
