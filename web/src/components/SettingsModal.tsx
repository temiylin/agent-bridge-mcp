import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Copy,
  Terminal,
  Cpu,
  Layers,
  Users,
  Plus,
  Trash2,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';

export const SettingsModal: React.FC = () => {
  const { t } = useTranslation();
  const {
    settingsOpen,
    setSettingsOpen,
    config,
    saveConfig,
    showToast,
    systemStats,
    poolAccounts,
    cockpitAccounts,
    profiles,
    customPoolEnabled,
    toggleCustomPool,
    switchCockpit,
    syncAuth,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<'routing' | 'agents' | 'pool' | 'system'>('routing');
  const [instructions, setInstructions] = useState(config?.routing.instructions || '');
  const [defaultAgent, setDefaultAgent] = useState(config?.routing.defaultAgent || 'codex');
  const [rules, setRules] = useState(config?.routing.rules || []);

  if (!settingsOpen) return null;

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    showToast(`已复制 ${label}: ${text}`);
  };

  const handleSave = async () => {
    const success = await saveConfig({
      routing: {
        defaultAgent,
        instructions,
        rules,
      },
    });
    if (success) {
      setSettingsOpen(false);
    }
  };

  const handleAddRule = () => {
    const scenario = prompt('场景名称 (如：前端页面开发 / 数据库优化)：');
    if (!scenario) return;
    const agent = prompt('执行 Agent (如：agy 或 codex)：', 'codex') || 'codex';
    const kws = prompt('触发关键词 (英文或中文逗号隔开)：', '') || '';
    const keywords = kws.split(/[,，]/).map((s) => s.trim()).filter(Boolean);

    setRules([
      ...rules,
      {
        id: `rule_${Date.now()}`,
        scenario,
        agent,
        keywords,
        description: `${scenario} 任务优先路由至 ${agent}`,
      },
    ]);
  };

  const handleDeleteRule = (id: string) => {
    setRules(rules.filter((r) => r.id !== id));
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-5xl bg-base-200 border border-base-300 p-6 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-base-300">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-lg">⚙️ {t('settingsTitle')}</h3>
          </div>
          <button
            className="btn btn-sm btn-circle btn-ghost"
            onClick={() => setSettingsOpen(false)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Access Bar (Device Token & MCP Endpoint) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 my-4 bg-base-100 p-3 rounded-xl border border-base-300 text-xs">
          <div>
            <div className="text-base-content/60 font-medium mb-1">本机专属识别码 (DEVICE TOKEN)</div>
            <div className="flex items-center justify-between bg-base-200 px-2.5 py-1.5 rounded-lg border border-base-300 font-mono text-primary">
              <span className="truncate">{config?.deviceToken || 'dev_loading...'}</span>
              <button
                className="btn btn-xs btn-ghost gap-1"
                onClick={() => handleCopy(config?.deviceToken || '', 'Token')}
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div>
            <div className="text-base-content/60 font-medium mb-1">云端 MCP 接入地址 (用于 CHATGPT)</div>
            <div className="flex items-center justify-between bg-base-200 px-2.5 py-1.5 rounded-lg border border-base-300 font-mono text-primary">
              <span className="truncate">{config?.deviceUrl || 'http://localhost:38080/mcp'}</span>
              <button
                className="btn btn-xs btn-ghost gap-1"
                onClick={() => handleCopy(config?.deviceUrl || '', 'URL')}
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        {/* Tabs Bar */}
        <div className="tabs tabs-boxed bg-base-100 p-1 mb-4">
          <button
            className={`tab tab-sm font-semibold gap-1.5 ${activeTab === 'routing' ? 'tab-active !bg-primary !text-primary-content' : ''}`}
            onClick={() => setActiveTab('routing')}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>{t('tabRouting')}</span>
          </button>
          <button
            className={`tab tab-sm font-semibold gap-1.5 ${activeTab === 'agents' ? 'tab-active !bg-primary !text-primary-content' : ''}`}
            onClick={() => setActiveTab('agents')}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>{t('tabAgents')}</span>
          </button>
          <button
            className={`tab tab-sm font-semibold gap-1.5 ${activeTab === 'pool' ? 'tab-active !bg-primary !text-primary-content' : ''}`}
            onClick={() => setActiveTab('pool')}
          >
            <Users className="w-3.5 h-3.5" />
            <span>{t('tabPool')}</span>
          </button>
          <button
            className={`tab tab-sm font-semibold gap-1.5 ${activeTab === 'system' ? 'tab-active !bg-primary !text-primary-content' : ''}`}
            onClick={() => setActiveTab('system')}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>{t('tabSystem')}</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto pr-1">
          {activeTab === 'routing' && (
            <div className="space-y-4">
              <div className="card bg-base-100 border border-base-300 p-4">
                <label className="label font-bold text-xs">
                  <span>📝 全局分发指导说明 (AI Dispatch Instructions)</span>
                </label>
                <textarea
                  className="textarea textarea-bordered h-24 text-xs font-mono"
                  placeholder="例如：涉及后端开发走 codex；涉及前端页面与可视化走 agy..."
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />

                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs font-medium">兜底默认 Agent (Default Fallback Agent)</span>
                  <select
                    className="select select-sm select-bordered w-48 text-xs font-mono"
                    value={defaultAgent}
                    onChange={(e) => setDefaultAgent(e.target.value)}
                  >
                    {Object.keys(config?.agents || { codex: {}, agy: {} }).map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Rules List */}
              <div className="card bg-base-100 border border-base-300 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-bold text-xs">⚡ 场景路由表与关键词规则</h4>
                  <button className="btn btn-xs btn-primary gap-1" onClick={handleAddRule}>
                    <Plus className="w-3 h-3" />
                    <span>添加规则</span>
                  </button>
                </div>

                <div className="space-y-2">
                  {rules.map((r) => (
                    <div
                      key={r.id}
                      className="p-3 bg-base-200 rounded-lg border border-base-300 flex items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{r.scenario}</span>
                          <span className="badge badge-sm badge-primary font-mono">{r.agent}</span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                          {r.keywords.map((kw) => (
                            <span key={kw} className="badge badge-xs badge-ghost font-mono">
                              {kw}
                            </span>
                          ))}
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => handleDeleteRule(r.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'agents' && (
            <div className="card bg-base-100 border border-base-300 p-4">
              <h4 className="font-bold text-xs mb-3">🤖 已配置的本地执行 Agent (agents.json)</h4>
              <div className="space-y-3">
                {Object.entries(config?.agents || {}).map(([name, cfg]) => (
                  <div key={name} className="p-3 bg-base-200 rounded-lg border border-base-300 text-xs">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold font-mono text-sm text-primary">🤖 {name}</span>
                      <span className="badge badge-sm badge-ghost">输入方式: {cfg.input || 'stdin'}</span>
                    </div>
                    <div className="font-mono text-[11px] bg-base-300/50 p-2 rounded text-base-content/70 truncate">
                      {cfg.command} {(cfg.args || []).join(' ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'pool' && (
            <div className="space-y-4">
              <div className="card bg-base-100 border border-base-300 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="font-bold text-xs">🧮 账号总览与独立 Profile 池</h4>
                    <p className="text-[11px] text-base-content/60">
                      默认池与独立 Profile 共享额度，同一邮箱同一时刻互斥调度。
                    </p>
                  </div>
                  <label className="cursor-pointer label gap-2">
                    <span className="label-text text-xs">自定义池</span>
                    <input
                      type="checkbox"
                      className="toggle toggle-primary toggle-sm"
                      checked={customPoolEnabled}
                      onChange={(e) => toggleCustomPool(e.target.checked)}
                    />
                  </label>
                </div>

                <div className="overflow-x-auto">
                  <table className="table table-xs table-zebra w-full font-mono">
                    <thead>
                      <tr>
                        <th>邮箱</th>
                        <th>主账号</th>
                        <th>额度</th>
                        <th>暂停状态</th>
                        <th className="text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poolAccounts.map((acc) => (
                        <tr key={acc.email}>
                          <td className="font-sans font-medium">{acc.email}</td>
                          <td>{acc.cockpit_current ? '★ 主账号' : '-'}</td>
                          <td>{Math.round(parseFloat(acc.quota_remaining || '1') * 100)}%</td>
                          <td>{acc.paused_until !== 'none' ? '⏸ 暂停' : '● 正常'}</td>
                          <td className="text-right">
                            {!acc.cockpit_current && (
                              <button
                                className="btn btn-xs btn-ghost"
                                onClick={() => {
                                  const c = cockpitAccounts.find((a) => a.email === acc.email);
                                  if (c) switchCockpit(c.accountId);
                                }}
                              >
                                切为主号
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Profiles list */}
              <div className="card bg-base-100 border border-base-300 p-4">
                <h4 className="font-bold text-xs mb-3">👥 隔离 Profile 实例 ({profiles.length})</h4>
                <div className="space-y-2">
                  {profiles.map((p) => (
                    <div
                      key={p.alias}
                      className="p-3 bg-base-200 rounded-lg border border-base-300 flex items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold font-mono">{p.alias}</span>
                          <span className="badge badge-xs badge-success">{p.login_label || '已登录'}</span>
                        </div>
                        <div className="text-[11px] text-base-content/50 mt-1 font-mono truncate max-w-md">
                          {p.email} · {p.home}
                        </div>
                      </div>
                      <button className="btn btn-xs btn-outline btn-primary" onClick={() => syncAuth(p.alias)}>
                        同步登录
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="card bg-base-100 border border-base-300 p-4 space-y-3">
              <h4 className="font-bold text-xs">💻 宿主机物理硬件与环境详情</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 bg-base-200 rounded-lg border border-base-300 text-xs">
                  <div className="text-base-content/60">操作系统</div>
                  <div className="font-bold mt-1 font-mono">{systemStats?.platform} ({systemStats?.arch})</div>
                </div>
                <div className="p-3 bg-base-200 rounded-lg border border-base-300 text-xs">
                  <div className="text-base-content/60">CPU 规格</div>
                  <div className="font-bold mt-1 font-mono">{systemStats?.cpuModel} ({systemStats?.cores}C)</div>
                </div>
                <div className="p-3 bg-base-200 rounded-lg border border-base-300 text-xs">
                  <div className="text-base-content/60">可用内存</div>
                  <div className="font-bold mt-1 font-mono">{systemStats?.freeMemGb} GB / {systemStats?.totalMemGb} GB</div>
                </div>
                <div className="p-3 bg-base-200 rounded-lg border border-base-300 text-xs">
                  <div className="text-base-content/60">后台守护进程</div>
                  <div className="font-bold mt-1 font-mono text-emerald-400">PID: {systemStats?.workerPid || 'None'}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-base-300 mt-4">
          <div className="text-xs text-base-content/50">修改后将直接写盘并即刻生效。</div>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm btn-ghost" onClick={() => setSettingsOpen(false)}>
              {t('cancel')}
            </button>
            <button className="btn btn-sm btn-primary" onClick={handleSave}>
              {t('save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
