import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RotateCcw,
  RefreshCw,
  ExternalLink,
  Trash2,
  Copy,
  FileText,
  Terminal,
  UserCheck,
  Play,
  X,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { TaskItem } from '../types';

interface TaskTableProps {
  onOpenDetails: (taskId: string) => void;
  onOpenLogs: (taskId: string) => void;
  onOpenRetry: (task: TaskItem, mode: 'continue' | 'switch_account' | 'fresh') => void;
}

export const TaskTable: React.FC<TaskTableProps> = ({
  onOpenDetails,
  onOpenLogs,
  onOpenRetry,
}) => {
  const { t } = useTranslation();
  const {
    tasks,
    filterStatus,
    setFilterStatus,
    selectedTaskIds,
    toggleSelectTask,
    toggleSelectAllTasks,
    batchCancelTasks,
    batchArchiveTasks,
    loadTasks,
    cancelTask,
    archiveTask,
    showToast,
  } = useAppStore();

  const [search, setSearch] = useState('');

  const formatActivityAgo = (iso?: string) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60) return <span className="text-emerald-400 font-mono">{sec}s ago</span>;
    const min = Math.floor(sec / 60);
    if (min < 60) return <span className="text-sky-400 font-mono">{min}m ago</span>;
    const hr = Math.floor(min / 60);
    if (hr < 24) return <span className="text-amber-400 font-mono">{hr}h ago</span>;
    return <span className="text-base-content/50 font-mono">{Math.floor(hr / 24)}d ago</span>;
  };

  const formatTime = (iso?: string) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const copyPrompt = async (taskId: string) => {
    try {
      const res = await fetch(`/api/recent-tasks/details?taskId=${encodeURIComponent(taskId)}`);
      const data = await res.json();
      if (data.prompt) {
        navigator.clipboard.writeText(data.prompt);
        showToast(`已复制任务 ${taskId} 提示词`);
      }
    } catch {}
  };

  const filteredTasks = tasks.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.taskId.toLowerCase().includes(q) ||
      (t.session_id && t.session_id.toLowerCase().includes(q)) ||
      (t.project && t.project.toLowerCase().includes(q)) ||
      (t.account && t.account.toLowerCase().includes(q))
    );
  });

  const allSelected = filteredTasks.length > 0 && selectedTaskIds.size === filteredTasks.length;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm mb-6">
      <div className="card-body p-4 md:p-6">
        {/* Controls Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="card-title text-base font-bold flex items-center gap-2">
              🕒 任务监控与调度流
            </h2>
            <select
              className="select select-sm select-bordered font-medium"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="active">{t('filterActive')}</option>
              <option value="all">{t('filterAll')}</option>
              <option value="running">{t('filterRunning')}</option>
              <option value="paused_quota">{t('filterPausedQuota')}</option>
              <option value="completed">{t('filterCompleted')}</option>
              <option value="failed">{t('filterFailed')}</option>
              <option value="queued">{t('filterQueued')}</option>
              <option value="requirements">{t('filterRequirements')}</option>
              <option value="queue">{t('filterQueue')}</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="搜索任务 ID / 会话 / 账号..."
              className="input input-sm input-bordered w-full md:w-56"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn btn-sm btn-ghost gap-1" onClick={() => loadTasks()}>
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{t('refresh')}</span>
            </button>
          </div>
        </div>

        {/* Batch Toolbar */}
        {selectedTaskIds.size > 0 && (
          <div className="alert alert-info bg-sky-950/40 border border-sky-500/30 py-2 px-4 rounded-lg flex items-center justify-between mb-4">
            <span className="text-xs text-sky-200 font-medium">
              已选中 <strong className="text-sky-400 font-mono text-sm">{selectedTaskIds.size}</strong> 条任务
            </span>
            <div className="flex items-center gap-2">
              <button className="btn btn-xs btn-error" onClick={batchCancelTasks}>
                {t('batchCancel')}
              </button>
              <button className="btn btn-xs btn-ghost" onClick={() => batchArchiveTasks(false)}>
                {t('batchArchive')}
              </button>
              <button className="btn btn-xs btn-outline btn-error" onClick={() => batchArchiveTasks(true)}>
                {t('batchArchiveCleanWorktree')}
              </button>
            </div>
          </div>
        )}

        {/* Tasks Table */}
        <div className="overflow-x-auto min-h-[220px]">
          <table className="table table-zebra table-sm w-full font-sans">
            <thead>
              <tr className="border-b border-base-300 text-base-content/60 text-xs">
                <th className="w-8 text-center">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs"
                    checked={allSelected}
                    onChange={(e) => toggleSelectAllTasks(e.target.checked)}
                  />
                </th>
                <th className="w-40">{t('thTaskId')}</th>
                <th className="w-32">{t('thTopic')}</th>
                <th className="w-24">{t('thStatus')}</th>
                <th className="w-24">{t('thActivity')}</th>
                <th className="w-28">{t('thCreatedAt')}</th>
                <th className="w-28">{t('thFinishedAt')}</th>
                <th className="w-24">{t('thPr')}</th>
                <th>{t('thLogTail')}</th>
                <th className="text-right w-44">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-12 text-base-content/40 text-sm">
                    {t('noData')}
                  </td>
                </tr>
              ) : (
                filteredTasks.map((task) => {
                  const isChecked = selectedTaskIds.has(task.taskId);

                  let badgeClass = 'badge-warning';
                  let statusLabel = task.status;
                  if (task.status === 'running') {
                    badgeClass = 'badge-info animate-pulse';
                    statusLabel = '● 运行中';
                  } else if (task.status === 'completed') {
                    badgeClass = 'badge-success';
                    statusLabel = '✓ 完成';
                  } else if (task.status === 'failed' || task.state === 'cancelled') {
                    badgeClass = 'badge-error';
                    statusLabel = '✕ 异常';
                  } else if (task.status === 'paused_quota') {
                    badgeClass = 'badge-secondary';
                    statusLabel = '额度暂停';
                  } else if (task.status === 'paused') {
                    badgeClass = 'badge-secondary';
                    statusLabel = '队列挂起';
                  }

                  return (
                    <tr key={task.taskId} className="hover">
                      <td className="text-center">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-xs"
                          checked={isChecked}
                          onChange={() => toggleSelectTask(task.taskId)}
                        />
                      </td>
                      <td className="py-2.5">
                        <span
                          className="font-mono text-xs text-primary font-bold cursor-pointer hover:underline block"
                          title="点击复制 Task ID"
                          onClick={() => {
                            navigator.clipboard.writeText(task.taskId);
                            showToast(`已复制: ${task.taskId}`);
                          }}
                        >
                          {task.taskId}
                        </span>
                        {task.account && (
                          <div className="text-[11px] font-mono text-base-content/40 truncate max-w-[160px] mt-0.5" title={task.account}>
                            {task.account.replace('default:', '')}
                          </div>
                        )}
                      </td>
                      <td className="text-xs">
                        {task.session_id ? (
                          <span className="font-mono text-[11px] text-base-content/70" title={task.session_id}>
                            {task.session_id.slice(0, 14)}...
                          </span>
                        ) : task.project ? (
                          <span className="badge badge-sm badge-ghost">{task.project}</span>
                        ) : (
                          <span className="text-base-content/30">-</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge badge-sm ${badgeClass} font-medium text-[11px] whitespace-nowrap px-2.5 py-1`}>
                          {statusLabel}
                        </span>
                      </td>
                      <td className="text-xs">{formatActivityAgo(task.last_activity_at || task.created_at)}</td>
                      <td className="text-[11px] font-mono text-base-content/70 whitespace-nowrap">
                        {formatTime(task.created_at)}
                      </td>
                      <td className="text-[11px] font-mono text-base-content/70 whitespace-nowrap">
                        {task.status === 'running' ? (
                          <span className="text-info font-sans">进行中 {task.elapsed && `(${task.elapsed})`}</span>
                        ) : (
                          formatTime(task.finished_at)
                        )}
                      </td>
                      <td>
                        {task.pr_url ? (
                          <a
                            href={task.pr_url}
                            target="_blank"
                            rel="noreferrer"
                            className="link link-primary inline-flex items-center gap-1 text-xs font-semibold"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>PR</span>
                          </a>
                        ) : (
                          <span className="text-base-content/30">-</span>
                        )}
                      </td>
                      <td className="max-w-[280px]">
                        {task.reason ? (
                          <span className="text-xs font-mono text-rose-400 truncate block" title={task.reason}>
                            {task.reason}
                          </span>
                        ) : task.last_log_line ? (
                          <span className="text-xs font-mono text-base-content/60 truncate block" title={task.last_log_line}>
                            {task.last_log_line}
                          </span>
                        ) : (
                          <span className="text-base-content/30">-</span>
                        )}
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* Details & Logs */}
                          <button
                            className="btn btn-ghost btn-xs btn-square text-base-content/70 hover:text-primary"
                            title="查看详情"
                            onClick={() => onOpenDetails(task.taskId)}
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>
                          <button
                            className="btn btn-ghost btn-xs btn-square text-base-content/70 hover:text-primary"
                            title="查看实时尾部日志"
                            onClick={() => onOpenLogs(task.taskId)}
                          >
                            <Terminal className="w-3.5 h-3.5" />
                          </button>

                          {/* State buttons */}
                          {task.status === 'running' && (
                            <button
                              className="btn btn-ghost btn-xs btn-square text-rose-400 hover:bg-rose-500/10"
                              title="取消任务"
                              onClick={() => cancelTask(task.taskId)}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {(task.status === 'paused_quota' || task.status === 'paused') && (
                            <>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-emerald-400 hover:bg-emerald-500/10"
                                title="续跑任务"
                                onClick={() => onOpenRetry(task, 'continue')}
                              >
                                <Play className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-sky-400 hover:bg-sky-500/10"
                                title="换号改派"
                                onClick={() => onOpenRetry(task, 'switch_account')}
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-rose-400 hover:bg-rose-500/10"
                                title="取消"
                                onClick={() => cancelTask(task.taskId)}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          {(task.status === 'failed' || task.state === 'cancelled') && (
                            <>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-emerald-400 hover:bg-emerald-500/10"
                                title="从头重试"
                                onClick={() => onOpenRetry(task, 'continue')}
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-rose-400 hover:bg-rose-500/10"
                                title="归档删除此任务"
                                onClick={() => archiveTask(task.taskId, false)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          {task.status === 'completed' && (
                            <button
                              className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
                              title="归档任务"
                              onClick={() => archiveTask(task.taskId, false)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
                            className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
                            title="复制提示词"
                            onClick={() => copyPrompt(task.taskId)}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
