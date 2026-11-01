import React, { useState, useEffect } from 'react';
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
  FolderGit2,
  Edit3,
  CheckCircle2,
  AlertCircle,
  FileText,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { ProjectConfigItem, PlanStepStatus } from '../types';

export const SettingsModal: React.FC = () => {
  const { t } = useTranslation();
  const {
    settingsOpen,
    setSettingsOpen,
    config,
    saveConfig,
    projects,
    saveProject,
    deleteProject,
    plans,
    loadPlans,
    loadPlanDetails,
    savePlan,
    archivePlan,
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

  const [activeTab, setActiveTab] = useState<'projects' | 'plans' | 'routing' | 'agents' | 'pool' | 'system'>('projects');
  const [instructions, setInstructions] = useState(config?.routing.instructions || '');
  const [defaultAgent, setDefaultAgent] = useState(config?.routing.defaultAgent || 'codex');
  const [rules, setRules] = useState(config?.routing.rules || []);

  // Plan Form State
  const [editingPlanMode, setEditingPlanMode] = useState<'none' | 'create' | 'update'>('none');
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({
    id: '',
    title: '',
    project_id: '',
    context: '',
    steps: [] as Array<{ id: string; title: string; detail: string; status: PlanStepStatus }>,
  });

  useEffect(() => {
    if (activeTab === 'plans') {
      loadPlans();
    }
  }, [activeTab]);

  const handleStartCreatePlan = () => {
    setPlanForm({
      id: '',
      title: '',
      project_id: '',
      context: '',
      steps: [
        { id: 'step-1', title: 'Step 1', detail: '', status: 'todo' },
      ],
    });
    setPlanError(null);
    setEditingPlanMode('create');
  };

  const handleStartEditPlan = async (planId: string) => {
    setPlanError(null);
    const plan = await loadPlanDetails(planId);
    if (!plan) {
      showToast('获取计划详情失败');
      return;
    }
    setPlanForm({
      id: plan.id,
      title: plan.title,
      project_id: plan.project_id || '',
      context: plan.context || '',
      steps: (plan.steps || []).map((s) => ({
        id: s.id,
        title: s.title,
        detail: s.detail || '',
        status: s.status,
      })),
    });
    setEditingPlanMode('update');
  };

  const handleSavePlan = async () => {
    if (editingPlanMode === 'none') return;
    if (!planForm.title.trim()) {
      setPlanError('计划标题不能为空');
      return;
    }
    setPlanSaving(true);
    setPlanError(null);
    try {
      const payload: Record<string, any> = {
        title: planForm.title.trim(),
        project_id: planForm.project_id.trim() || undefined,
        context: planForm.context,
        steps: planForm.steps.map((s, idx) => ({
          id: s.id.trim() || `step-${idx + 1}`,
          title: s.title.trim() || `Step ${idx + 1}`,
          detail: s.detail,
          status: s.status,
        })),
      };
      if (editingPlanMode === 'create' && planForm.id.trim()) {
        payload.id = planForm.id.trim();
      }
      if (editingPlanMode === 'update') {
        payload.plan_id = planForm.id;
      }
      const res = await savePlan(editingPlanMode, payload);
      if (res.success) {
        setEditingPlanMode('none');
      } else {
        setPlanError(res.error || '保存计划失败');
      }
    } finally {
      setPlanSaving(false);
    }
  };

  const handleArchivePlan = async (planId: string) => {
    if (!confirm(`确定要归档计划 "${planId}" 吗？归档后该计划不可再派发任务。`)) {
      return;
    }
    const res = await archivePlan(planId);
    if (!res.success) {
      alert(`归档失败: ${res.error}`);
    }
  };

  // Project Form State
  const [editingProjMode, setEditingProjMode] = useState<'none' | 'add' | 'update'>('none');
  const [projError, setProjError] = useState<string | null>(null);
  const [projSaving, setProjSaving] = useState(false);
  const [projForm, setProjForm] = useState({
    id: '',
    name: '',
    repo_path: '',
    repo: '',
    default_base_branch: 'develop',
    push_remote: 'origin',
    forbidden_remotes: '',
    worktree_root: '',
    default_agent: '',
    default_model: '',
    default_account: '',
    default_timeout_seconds: '',
    callback_url: '',
    callback_headers_text: '',
    test_commands_text: '',
  });

  const openAddProjectForm = () => {
    setProjError(null);
    setProjForm({
      id: '',
      name: '',
      repo_path: '',
      repo: '',
      default_base_branch: 'develop',
      push_remote: 'origin',
      forbidden_remotes: '',
      worktree_root: '',
      default_agent: '',
      default_model: '',
      default_account: '',
      default_timeout_seconds: '',
      callback_url: '',
      callback_headers_text: '',
      test_commands_text: '',
    });
    setEditingProjMode('add');
  };

  const openEditProjectForm = (p: ProjectConfigItem) => {
    setProjError(null);
    const headersText = Object.entries(p.callback_headers || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    setProjForm({
      id: p.id,
      name: p.name || p.id,
      repo_path: p.repo_path || p.paths?.[0] || '',
      repo: p.repo || '',
      default_base_branch: p.default_base_branch || 'develop',
      push_remote: p.push_remote || 'origin',
      forbidden_remotes: (p.forbidden_remotes || []).join(', '),
      worktree_root: p.worktree_root || '',
      default_agent: p.default_agent || '',
      default_model: p.default_model || '',
      default_account: p.default_account || '',
      default_timeout_seconds: p.default_timeout_seconds ? String(p.default_timeout_seconds) : '',
      callback_url: p.callback_url || '',
      callback_headers_text: headersText,
      test_commands_text: (p.verify_pr?.test_commands || []).join('\n'),
    });
    setEditingProjMode('update');
  };

  const handleSaveProjectForm = async () => {
    setProjError(null);
    if (!projForm.id.trim() || !projForm.repo_path.trim()) {
      setProjError('项目 ID 与主仓库路径 (repo_path) 不能为空');
      return;
    }

    const callbackHeaders: Record<string, string> = {};
    for (const line of projForm.callback_headers_text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) {
        setProjError(`回调 Header 格式错误: "${trimmed}"，应为 Header-Name=$ENV_VAR_NAME`);
        return;
      }
      const hKey = trimmed.slice(0, eqIdx).trim();
      const hVal = trimmed.slice(eqIdx + 1).trim();
      const m = hVal.match(/^(?:([A-Za-z0-9._-]+)\s+)?\$?(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))$/);
      if (!m) {
        setProjError(`回调密钥只允许填写环境变量名（如 $AGENT_BRIDGE_CB_TOKEN 或 Bearer $AGENT_BRIDGE_CB_TOKEN），禁止直接填入密钥明文: "${hVal}"`);
        return;
      }
      const prefix = m[1];
      const envName = m[2] || m[3];
      callbackHeaders[hKey] = prefix ? `${prefix} $${envName}` : `$${envName}`;
    }

    const testCmds = projForm.test_commands_text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: Record<string, any> = {
      id: projForm.id.trim(),
      name: projForm.name.trim() || projForm.id.trim(),
      repo_path: projForm.repo_path.trim(),
      repo: projForm.repo.trim() || undefined,
      default_base_branch: projForm.default_base_branch.trim() || 'develop',
      push_remote: projForm.push_remote.trim() || 'origin',
      forbidden_remotes: projForm.forbidden_remotes
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      worktree_root: projForm.worktree_root.trim() || undefined,
      default_agent: projForm.default_agent.trim() || undefined,
      default_model: projForm.default_model.trim() || undefined,
      default_account: projForm.default_account.trim() || undefined,
      default_timeout_seconds: projForm.default_timeout_seconds
        ? Number(projForm.default_timeout_seconds)
        : undefined,
      callback_url: projForm.callback_url.trim() || undefined,
      callback_headers: callbackHeaders,
      verify_pr: testCmds.length > 0 ? { test_commands: testCmds } : undefined,
    };

    setProjSaving(true);
    try {
      const res = await saveProject(editingProjMode === 'add' ? 'add' : 'update', payload);
      if (res.success) {
        setEditingProjMode('none');
      } else {
        setProjError(res.error || '保存项目失败');
      }
    } finally {
      setProjSaving(false);
    }
  };

  const handleDeleteProject = async (id: string) => {
    if (!confirm(`确定要移除项目 "${id}" 吗？（仅移除注册配置，不会删除本地仓库文件）`)) return;
    const res = await deleteProject(id);
    if (!res.success && res.error) {
      alert(res.error);
    }
  };

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
            className={`tab tab-sm font-semibold gap-1.5 ${activeTab === 'projects' ? 'tab-active !bg-primary !text-primary-content' : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            <FolderGit2 className="w-3.5 h-3.5" />
            <span>{t('tabProjects')}</span>
          </button>
          <button
            className={`tab tab-sm font-semibold gap-1.5 ${activeTab === 'plans' ? 'tab-active !bg-primary !text-primary-content' : ''}`}
            onClick={() => setActiveTab('plans')}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>计划 (Plans)</span>
          </button>
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
          {activeTab === 'projects' && (
            <div className="space-y-4">
              {editingProjMode !== 'none' ? (
                <div className="card bg-base-100 border border-base-300 p-4 space-y-3 text-xs">
                  <div className="flex items-center justify-between border-b border-base-300 pb-2">
                    <h4 className="font-bold text-sm">
                      {editingProjMode === 'add' ? '➕ 新增项目配置' : `✏️ 编辑项目: ${projForm.id}`}
                    </h4>
                    <button className="btn btn-xs btn-ghost" onClick={() => setEditingProjMode('none')}>
                      返回列表
                    </button>
                  </div>

                  {projError && (
                    <div className="alert alert-error py-2 px-3 text-xs rounded-lg">
                      <span>{projError}</span>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="label py-1 font-semibold">项目 ID (project_id) *</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="如 vision_hub"
                        disabled={editingProjMode === 'update'}
                        value={projForm.id}
                        onChange={(e) => setProjForm({ ...projForm, id: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">项目名称</label>
                      <input
                        className="input input-xs input-bordered w-full"
                        placeholder="如 Vision Hub"
                        value={projForm.name}
                        onChange={(e) => setProjForm({ ...projForm, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">GitHub 仓库 (owner/repo)</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="如 org/vision_hub"
                        value={projForm.repo}
                        onChange={(e) => setProjForm({ ...projForm, repo: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="label py-1 font-semibold">主仓库本地路径 (repo_path) *</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="/Users/.../vision_hub"
                        value={projForm.repo_path}
                        onChange={(e) => setProjForm({ ...projForm, repo_path: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">Worktree 根目录 (可选)</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="/Users/.../worktrees/vision_hub"
                        value={projForm.worktree_root}
                        onChange={(e) => setProjForm({ ...projForm, worktree_root: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="label py-1 font-semibold">默认基础分支 (default_base_branch)</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="develop"
                        value={projForm.default_base_branch}
                        onChange={(e) => setProjForm({ ...projForm, default_base_branch: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">默认推送 Remote (push_remote)</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="github 或 origin"
                        value={projForm.push_remote}
                        onChange={(e) => setProjForm({ ...projForm, push_remote: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">禁止推送的 Remote URL 规则 (逗号隔开)</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="如 gitee.com, git@gitee.com:org/repo"
                        value={projForm.forbidden_remotes}
                        onChange={(e) => setProjForm({ ...projForm, forbidden_remotes: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div>
                      <label className="label py-1 font-semibold">默认 Agent</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="如 agy-sdk / codex"
                        value={projForm.default_agent}
                        onChange={(e) => setProjForm({ ...projForm, default_agent: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">默认模型</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="可选"
                        value={projForm.default_model}
                        onChange={(e) => setProjForm({ ...projForm, default_model: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">默认账号/池</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="可选邮箱或 alias"
                        value={projForm.default_account}
                        onChange={(e) => setProjForm({ ...projForm, default_account: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">默认超时 (秒)</label>
                      <input
                        type="number"
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="如 1800"
                        value={projForm.default_timeout_seconds}
                        onChange={(e) => setProjForm({ ...projForm, default_timeout_seconds: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="label py-1 font-semibold">默认回调 URL (callback_url)</label>
                      <input
                        className="input input-xs input-bordered w-full font-mono"
                        placeholder="http://127.0.0.1:8000/api/webhook"
                        value={projForm.callback_url}
                        onChange={(e) => setProjForm({ ...projForm, callback_url: e.target.value })}
                      />
                      <label className="label py-1 font-semibold mt-1">
                        <span>回调 Header 环境变量引用 (仅限 $ENV_VAR 名，禁止明文密钥)</span>
                      </label>
                      <textarea
                        className="textarea textarea-bordered w-full h-16 font-mono text-xs"
                        placeholder={'Authorization=$VISION_HUB_WEBHOOK_TOKEN\nX-Project-Key=$VISION_HUB_KEY'}
                        value={projForm.callback_headers_text}
                        onChange={(e) => setProjForm({ ...projForm, callback_headers_text: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">PR 验证测试命令 (每行一条)</label>
                      <textarea
                        className="textarea textarea-bordered w-full h-28 font-mono text-xs"
                        placeholder={'pnpm build\npytest'}
                        value={projForm.test_commands_text}
                        onChange={(e) => setProjForm({ ...projForm, test_commands_text: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button className="btn btn-xs btn-ghost" onClick={() => setEditingProjMode('none')}>
                      取消
                    </button>
                    <button
                      className="btn btn-xs btn-primary"
                      disabled={projSaving}
                      onClick={handleSaveProjectForm}
                    >
                      {projSaving ? '保存中...' : '保存项目'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="card bg-base-100 border border-base-300 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h4 className="font-bold text-xs">📁 已注册项目配置 (projects.json)</h4>
                      <p className="text-[11px] text-base-content/60">
                        派发任务时仅需传 <code className="font-mono">project_id</code> 即可自动套用路径、分支、Remote 拦截与默认回调。回调密钥仅展示环境变量名。
                      </p>
                    </div>
                    <button className="btn btn-xs btn-primary gap-1" onClick={openAddProjectForm}>
                      <Plus className="w-3 h-3" />
                      <span>添加项目</span>
                    </button>
                  </div>

                  {projects.length === 0 ? (
                    <div className="text-center py-8 text-xs text-base-content/40">
                      暂未配置项目，点击右上角「添加项目」即可创建。
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {projects.map((p) => (
                        <div
                          key={p.id}
                          className="p-3 bg-base-200 rounded-lg border border-base-300 flex flex-col gap-2 text-xs"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold font-mono text-sm text-primary">{p.id}</span>
                              <span className="text-base-content/80 font-medium">{p.name}</span>
                              {p.path_valid !== false ? (
                                <span className="badge badge-xs badge-success gap-1">
                                  <CheckCircle2 className="w-2.5 h-2.5" /> 仓库正常
                                </span>
                              ) : (
                                <span className="badge badge-xs badge-error gap-1" title={p.path_error}>
                                  <AlertCircle className="w-2.5 h-2.5" /> 路径异常
                                </span>
                              )}
                              {p.default_base_branch && (
                                <span className="badge badge-xs badge-ghost font-mono">
                                  base: {p.default_base_branch}
                                </span>
                              )}
                              {p.push_remote && (
                                <span className="badge badge-xs badge-info badge-outline font-mono">
                                  push: {p.push_remote}
                                </span>
                              )}
                              {p.default_agent && (
                                <span className="badge badge-xs badge-primary font-mono">
                                  agent: {p.default_agent}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                className="btn btn-ghost btn-xs"
                                title="编辑项目"
                                onClick={() => openEditProjectForm(p)}
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="btn btn-ghost btn-xs text-error"
                                title="删除项目"
                                onClick={() => handleDeleteProject(p.id)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="font-mono text-[11px] text-base-content/60 truncate">
                            📍 {p.repo_path || p.paths?.[0]}
                          </div>

                          <div className="flex items-center gap-2 flex-wrap text-[11px]">
                            {p.forbidden_remotes && p.forbidden_remotes.length > 0 && (
                              <span className="text-rose-400 font-mono">
                                🚫 禁推 URL: {p.forbidden_remotes.join(', ')}
                              </span>
                            )}
                            {p.callback_url && (
                              <span className="text-base-content/60 font-mono">
                                🔔 回调: {p.callback_url}
                              </span>
                            )}
                            {p.callback_headers && Object.keys(p.callback_headers).length > 0 && (
                              <span className="text-emerald-400 font-mono">
                                🔑 环境变量引用:{' '}
                                {Object.entries(p.callback_headers)
                                  .map(([hk, hv]) => `${hk}=${hv}`)
                                  .join(', ')}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'plans' && (
            <div className="space-y-4">
              {editingPlanMode !== 'none' ? (
                <div className="card bg-base-100 border border-base-300 p-4 space-y-4 text-xs">
                  <div className="flex items-center justify-between border-b border-base-300 pb-2">
                    <h4 className="font-bold text-sm flex items-center gap-2">
                      <FileText className="w-4 h-4 text-primary" />
                      <span>{editingPlanMode === 'create' ? '新建多步骤计划' : `编辑计划: ${planForm.id}`}</span>
                    </h4>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => setEditingPlanMode('none')}
                    >
                      取消
                    </button>
                  </div>

                  {planError && (
                    <div className="alert alert-error text-xs py-2">
                      <AlertCircle className="w-4 h-4" />
                      <span>{planError}</span>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="label py-1 font-semibold">计划标题 (Title) *</label>
                      <input
                        type="text"
                        className="input input-sm input-bordered w-full"
                        placeholder="例如: 重构统一认证流程"
                        value={planForm.title}
                        onChange={(e) => setPlanForm({ ...planForm, title: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label py-1 font-semibold">计划 ID (可选，留空自动生成)</label>
                      <input
                        type="text"
                        className="input input-sm input-bordered w-full font-mono"
                        placeholder="plan_auth_refactor"
                        disabled={editingPlanMode === 'update'}
                        value={planForm.id}
                        onChange={(e) => setPlanForm({ ...planForm, id: e.target.value })}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="label py-1 font-semibold">关联项目 (Project)</label>
                    <select
                      className="select select-sm select-bordered w-full"
                      value={planForm.project_id}
                      onChange={(e) => setPlanForm({ ...planForm, project_id: e.target.value })}
                    >
                      <option value="">(无项目关联)</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          📁 {p.name || p.id} ({p.id})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="label py-1 font-semibold">背景说明与目标 (Markdown Context)</label>
                    <textarea
                      className="textarea textarea-bordered w-full h-28 font-mono text-xs"
                      placeholder="计划整体目标、技术约束、上下文信息..."
                      value={planForm.context}
                      onChange={(e) => setPlanForm({ ...planForm, context: e.target.value })}
                    />
                  </div>

                  {/* Steps Editor */}
                  <div className="space-y-2 border-t border-base-300 pt-3">
                    <div className="flex items-center justify-between">
                      <label className="font-bold text-xs uppercase tracking-wider text-base-content/70">
                        步骤列表 ({planForm.steps.length})
                      </label>
                      <button
                        type="button"
                        className="btn btn-xs btn-outline btn-primary gap-1"
                        onClick={() => {
                          const nextIdx = planForm.steps.length + 1;
                          setPlanForm({
                            ...planForm,
                            steps: [
                              ...planForm.steps,
                              { id: `step-${nextIdx}`, title: `Step ${nextIdx}`, detail: '', status: 'todo' },
                            ],
                          });
                        }}
                      >
                        <Plus className="w-3 h-3" />
                        <span>添加步骤</span>
                      </button>
                    </div>

                    <div className="space-y-3">
                      {planForm.steps.map((st, sIdx) => (
                        <div key={sIdx} className="card bg-base-200/60 border border-base-300 p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="badge badge-sm badge-neutral font-mono font-bold">#{sIdx + 1}</span>
                            <input
                              type="text"
                              className="input input-xs input-bordered w-24 font-mono"
                              placeholder="step-id"
                              value={st.id}
                              onChange={(e) => {
                                const next = [...planForm.steps];
                                next[sIdx] = { ...st, id: e.target.value };
                                setPlanForm({ ...planForm, steps: next });
                              }}
                            />
                            <input
                              type="text"
                              className="input input-xs input-bordered flex-1 font-semibold"
                              placeholder="步骤标题"
                              value={st.title}
                              onChange={(e) => {
                                const next = [...planForm.steps];
                                next[sIdx] = { ...st, title: e.target.value };
                                setPlanForm({ ...planForm, steps: next });
                              }}
                            />
                            <select
                              className="select select-xs select-bordered font-mono"
                              value={st.status}
                              onChange={(e) => {
                                const next = [...planForm.steps];
                                next[sIdx] = { ...st, status: e.target.value as PlanStepStatus };
                                setPlanForm({ ...planForm, steps: next });
                              }}
                            >
                              <option value="todo">todo</option>
                              <option value="in_progress">in_progress</option>
                              <option value="done">done</option>
                              <option value="failed">failed</option>
                              <option value="skipped">skipped</option>
                            </select>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs text-rose-400 btn-square"
                              title="删除此步骤"
                              onClick={() => {
                                setPlanForm({
                                  ...planForm,
                                  steps: planForm.steps.filter((_, idx) => idx !== sIdx),
                                });
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <textarea
                            className="textarea textarea-bordered w-full h-16 text-xs font-mono"
                            placeholder="步骤详细要求与说明..."
                            value={st.detail}
                            onChange={(e) => {
                              const next = [...planForm.steps];
                              next[sIdx] = { ...st, detail: e.target.value };
                              setPlanForm({ ...planForm, steps: next });
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2 border-t border-base-300">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditingPlanMode('none')}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={planSaving}
                      onClick={handleSavePlan}
                    >
                      {planSaving ? '保存中...' : '保存计划'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-bold text-sm">📋 计划管理 (Execution Plans)</h4>
                      <p className="text-xs text-base-content/60">
                        管理多步骤计划。派任务时可引用计划 ID 与步骤 ID，自动注入上下文并回写任务执行状态。
                      </p>
                    </div>
                    <button
                      className="btn btn-sm btn-primary gap-1"
                      onClick={handleStartCreatePlan}
                    >
                      <Plus className="w-4 h-4" />
                      <span>新建计划</span>
                    </button>
                  </div>

                  {plans.length === 0 ? (
                    <div className="card bg-base-100 border border-base-300 p-8 text-center text-xs text-base-content/50">
                      暂无计划，点击上方按钮创建新计划。
                    </div>
                  ) : (
                    <div className="overflow-x-auto border border-base-300 rounded-lg bg-base-100">
                      <table className="table table-xs table-zebra w-full font-mono">
                        <thead>
                          <tr className="border-b border-base-300 text-base-content/60 font-sans">
                            <th>计划名称 / ID</th>
                            <th>所属项目</th>
                            <th>版本</th>
                            <th>步骤进度</th>
                            <th>更新时间</th>
                            <th className="text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plans.map((p) => {
                            const pct = p.total_steps > 0 ? Math.round((p.completed_steps / p.total_steps) * 100) : 0;
                            return (
                              <tr key={p.id}>
                                <td className="py-2.5">
                                  <div className="font-sans font-bold text-xs text-base-content">
                                    {p.title}
                                  </div>
                                  <div className="text-[11px] text-base-content/40 font-mono">
                                    {p.id}
                                  </div>
                                </td>
                                <td>
                                  {p.project_id ? (
                                    <span className="badge badge-ghost badge-xs font-mono">
                                      📁 {p.project_id}
                                    </span>
                                  ) : (
                                    <span className="text-base-content/30">–</span>
                                  )}
                                </td>
                                <td>
                                  <span className="badge badge-outline badge-xs font-mono">v{p.version}</span>
                                </td>
                                <td>
                                  <div className="flex items-center gap-1.5 font-sans text-xs">
                                    <span>{p.completed_steps}/{p.total_steps}</span>
                                    <span className="text-[11px] text-base-content/50">({pct}%)</span>
                                  </div>
                                </td>
                                <td className="text-[11px] text-base-content/60">
                                  {new Date(p.updated_at).toLocaleString()}
                                </td>
                                <td className="text-right">
                                  <div className="flex items-center justify-end gap-1 font-sans">
                                    <button
                                      className="btn btn-ghost btn-xs gap-1 text-primary"
                                      onClick={() => handleStartEditPlan(p.id)}
                                    >
                                      <Edit3 className="w-3 h-3" />
                                      <span>编辑</span>
                                    </button>
                                    <button
                                      className="btn btn-ghost btn-xs gap-1 text-rose-400"
                                      onClick={() => handleArchivePlan(p.id)}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                      <span>归档</span>
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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
