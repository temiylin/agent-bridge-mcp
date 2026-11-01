import React, { useState, useEffect } from 'react';
import { X, Copy, RefreshCw, Send } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { TaskItem } from '../types';

interface ModalsProps {
  detailsTaskId: string | null;
  onCloseDetails: () => void;
  logsTaskId: string | null;
  onCloseLogs: () => void;
  retryTask: { task: TaskItem; mode: 'continue' | 'switch_account' | 'fresh' } | null;
  onCloseRetry: () => void;
}

export const ActionModals: React.FC<ModalsProps> = ({
  detailsTaskId,
  onCloseDetails,
  logsTaskId,
  onCloseLogs,
  retryTask,
  onCloseRetry,
}) => {
  const { showToast, config, loadTasks } = useAppStore();

  // Details Modal Data
  const [detailsData, setDetailsData] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  useEffect(() => {
    if (!detailsTaskId) return;
    setLoadingDetails(true);
    fetch(`/api/recent-tasks/details?taskId=${encodeURIComponent(detailsTaskId)}`)
      .then((r) => r.json())
      .then((d) => setDetailsData(d))
      .catch(() => setDetailsData(null))
      .finally(() => setLoadingDetails(false));
  }, [detailsTaskId]);

  // Logs Modal Data
  const [logsContent, setLogsContent] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);

  const fetchLogs = () => {
    if (!logsTaskId) return;
    setLoadingLogs(true);
    fetch(`/api/recent-tasks/logs?taskId=${encodeURIComponent(logsTaskId)}&lines=500`)
      .then((r) => r.json())
      .then((d) => {
        let combined = '';
        if (d.stdout) combined += `[STDOUT]\n${d.stdout}\n`;
        if (d.stderr) combined += `\n[STDERR]\n${d.stderr}`;
        setLogsContent(combined || '(暂无输出日志)');
      })
      .catch((e) => setLogsContent(`读取异常: ${e.message}`))
      .finally(() => setLoadingLogs(false));
  };

  useEffect(() => {
    if (logsTaskId) fetchLogs();
  }, [logsTaskId]);

  // Retry Modal State
  const [retryMode, setRetryMode] = useState<'continue' | 'fresh'>('continue');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customAccount, setCustomAccount] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [submittingRetry, setSubmittingRetry] = useState(false);

  useEffect(() => {
    if (retryTask) {
      setRetryMode(retryTask.mode === 'fresh' ? 'fresh' : 'continue');
      setSelectedAgent(retryTask.task.agent || '');
      setCustomModel(retryTask.task.model || '');
      setCustomAccount(retryTask.task.account || '');
      setCustomPrompt('');
    }
  }, [retryTask]);

  const handleExecuteRetry = async () => {
    if (!retryTask) return;
    setSubmittingRetry(true);
    try {
      const res = await fetch('/api/recent-tasks/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: retryTask.task.taskId,
          mode: retryMode,
          agent: selectedAgent || undefined,
          model: customModel || undefined,
          account: customAccount || undefined,
          prompt: customPrompt || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || '任务已派发执行');
        onCloseRetry();
        loadTasks();
      } else {
        alert(data.error || '执行失败');
      }
    } catch (e: any) {
      alert(`派发失败: ${e.message}`);
    } finally {
      setSubmittingRetry(false);
    }
  };

  return (
    <>
      {/* 1. Details Modal */}
      {detailsTaskId && (
        <div className="modal modal-open">
          <div className="modal-box max-w-3xl bg-base-200 border border-base-300">
            <div className="flex items-center justify-between pb-3 border-b border-base-300 mb-4">
              <h3 className="font-bold text-sm md:text-base flex items-center gap-2">
                📄 任务详情: <span className="font-mono text-primary">{detailsTaskId}</span>
              </h3>
              <button className="btn btn-sm btn-circle btn-ghost" onClick={onCloseDetails}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {loadingDetails ? (
              <div className="py-12 text-center text-xs text-base-content/40">加载任务详情中...</div>
            ) : detailsData ? (
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 bg-base-100 p-3 rounded-xl border border-base-300">
                  <div>
                    <span className="text-base-content/50">状态</span>
                    <div className="font-bold mt-0.5">{detailsData.status?.state || 'unknown'}</div>
                  </div>
                  <div>
                    <span className="text-base-content/50">Agent / Model</span>
                    <div className="font-bold mt-0.5 font-mono">{detailsData.status?.agent || '-'} ({detailsData.status?.model || '-'})</div>
                  </div>
                  <div>
                    <span className="text-base-content/50">账号 / Profile</span>
                    <div className="font-bold mt-0.5 truncate">{detailsData.status?.account || '-'}</div>
                  </div>
                  <div className="col-span-full">
                    <span className="text-base-content/50">工作目录 (Worktree)</span>
                    <div className="font-mono text-[11px] text-base-content/70 truncate">{detailsData.workDir || '-'}</div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5 font-medium">
                    <span>提示词 (Prompt)</span>
                    <button
                      className="btn btn-xs btn-ghost gap-1"
                      onClick={() => {
                        navigator.clipboard.writeText(detailsData.prompt || '');
                        showToast('已复制提示词');
                      }}
                    >
                      <Copy className="w-3 h-3" />
                      <span>复制</span>
                    </button>
                  </div>
                  <textarea
                    readOnly
                    className="textarea textarea-bordered w-full h-32 font-mono text-[11px]"
                    value={detailsData.prompt || '(无提示词)'}
                  />
                </div>

                {detailsData.resultRaw && (
                  <div>
                    <span className="font-medium mb-1.5 block">产物与结果 (Result Markdown)</span>
                    <div className="bg-base-100 p-3 rounded-lg border border-base-300 font-mono text-[11px] max-h-40 overflow-y-auto whitespace-pre-wrap">
                      {detailsData.resultRaw}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="modal-action">
              <button className="btn btn-sm btn-ghost" onClick={onCloseDetails}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Logs Modal */}
      {logsTaskId && (
        <div className="modal modal-open">
          <div className="modal-box max-w-4xl bg-base-200 border border-base-300">
            <div className="flex items-center justify-between pb-3 border-b border-base-300 mb-3">
              <h3 className="font-bold text-sm md:text-base flex items-center gap-2">
                📜 日志尾部 (Tail): <span className="font-mono text-primary">{logsTaskId}</span>
              </h3>
              <div className="flex items-center gap-2">
                <button className="btn btn-xs btn-ghost gap-1" onClick={fetchLogs}>
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? 'animate-spin' : ''}`} />
                  <span>刷新</span>
                </button>
                <button className="btn btn-sm btn-circle btn-ghost" onClick={onCloseLogs}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <pre className="bg-[#080d16] text-base-content/90 p-4 rounded-xl font-mono text-xs max-h-[500px] overflow-y-auto whitespace-pre-wrap break-all border border-base-300">
              {logsContent}
            </pre>

            <div className="modal-action">
              <button className="btn btn-sm btn-ghost" onClick={onCloseLogs}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Retry / Switch Account Modal */}
      {retryTask && (
        <div className="modal modal-open">
          <div className="modal-box max-w-xl bg-base-200 border border-base-300">
            <div className="flex items-center justify-between pb-3 border-b border-base-300 mb-4">
              <h3 className="font-bold text-base flex items-center gap-2">
                ⚡ {retryTask.mode === 'switch_account' ? '改派账号 / 引擎' : '重试 / 续跑任务'}:{' '}
                <span className="font-mono text-primary text-xs">{retryTask.task.taskId}</span>
              </h3>
              <button className="btn btn-sm btn-circle btn-ghost" onClick={onCloseRetry}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <label className="font-medium block mb-2">执行模式</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="retry-mode"
                      className="radio radio-sm radio-primary"
                      checked={retryMode === 'continue'}
                      onChange={() => setRetryMode('continue')}
                    />
                    <span>续跑模式（继承历史会话与上下文）</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="retry-mode"
                      className="radio radio-sm radio-primary"
                      checked={retryMode === 'fresh'}
                      onChange={() => setRetryMode('fresh')}
                    />
                    <span>全新重跑（不继承上下文）</span>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium block mb-1">执行 Agent</label>
                  <select
                    className="select select-sm select-bordered w-full font-mono text-xs"
                    value={selectedAgent}
                    onChange={(e) => setSelectedAgent(e.target.value)}
                  >
                    <option value="">保持原 Agent</option>
                    {Object.keys(config?.agents || {}).map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="font-medium block mb-1">模型设定 (可选)</label>
                  <input
                    type="text"
                    className="input input-sm input-bordered w-full font-mono text-xs"
                    placeholder="留空保持原模型"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="font-medium block mb-1">指定账号 / Profile (用于改派换号)</label>
                <input
                  type="text"
                  className="input input-sm input-bordered w-full font-mono text-xs"
                  placeholder="auto 或输入 profile 别名如 jianjianlin380"
                  value={customAccount}
                  onChange={(e) => setCustomAccount(e.target.value)}
                />
              </div>

              <div>
                <label className="font-medium block mb-1">提示词调整 (选填，留空沿用原提示词)</label>
                <textarea
                  className="textarea textarea-bordered w-full h-20 text-xs font-mono"
                  placeholder="留空沿用原提示词..."
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-action">
              <button className="btn btn-sm btn-ghost" onClick={onCloseRetry}>
                取消
              </button>
              <button
                className="btn btn-sm btn-primary gap-1.5"
                disabled={submittingRetry}
                onClick={handleExecuteRetry}
              >
                <Send className="w-3.5 h-3.5" />
                <span>{submittingRetry ? '正在派发...' : '立即执行'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
