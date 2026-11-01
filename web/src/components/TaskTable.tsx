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
  Pause,
  X,
  AlertTriangle,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { TaskItem } from '../types';

interface TaskTableProps {
  onOpenDetails: (taskId: string) => void;
  onOpenLogs: (taskId: string) => void;
  onOpenRetry: (task: TaskItem, mode: 'continue' | 'switch_account' | 'fresh') => void;
}

interface ConfirmState {
  type: 'cancel' | 'archive' | 'batch_cancel' | 'batch_archive';
  taskIds: string[];
  cleanWorktree?: boolean;
}

export const TaskTable: React.FC<TaskTableProps> = ({
  onOpenDetails,
  onOpenLogs,
  onOpenRetry,
}) => {
  const { t } = useTranslation();
  const {
    tasks,
    projects,
    plans,
    filterStatus,
    setFilterStatus,
    filterProject,
    setFilterProject,
    filterPlan,
    setFilterPlan,
    openPlanDrawer,
    selectedTaskIds,
    toggleSelectTask,
    toggleSelectFilteredTasks,
    batchCancelTasks,
    batchArchiveTasks,
    loadTasks,
    cancelTask,
    archiveTask,
    pauseQueueSession,
    resumeQueueSession,
    showToast,
  } = useAppStore();

  const [search, setSearch] = useState('');
  const [confirmModal, setConfirmModal] = useState<ConfirmState | null>(null);
  const [modalCleanWorktree, setModalCleanWorktree] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const formatActivityAgo = (iso?: string) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60) return <span className="text-emerald-400 font-mono">{sec}s ago</span>;
    const min = Math.floor(sec / 60);
    if (min < 60) return <span className="text-info font-mono">{min}m ago</span>;
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
    if (filterPlan && filterPlan !== 'all' && t.plan_id !== filterPlan) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.taskId.toLowerCase().includes(q) ||
      (t.session_id && t.session_id.toLowerCase().includes(q)) ||
      (t.project && t.project.toLowerCase().includes(q)) ||
      (t.account && t.account.toLowerCase().includes(q)) ||
      (t.plan_id && t.plan_id.toLowerCase().includes(q)) ||
      (t.plan_title && t.plan_title.toLowerCase().includes(q))
    );
  });

  const filteredIds = filteredTasks.map((t) => t.taskId);
  const allFilteredSelected =
    filteredTasks.length > 0 && filteredTasks.every((t) => selectedTaskIds.has(t.taskId));

  const handleExecuteConfirm = async () => {
    if (!confirmModal) return;
    setConfirming(true);
    try {
      if (confirmModal.type === 'cancel') {
        await cancelTask(confirmModal.taskIds[0]);
      } else if (confirmModal.type === 'archive') {
        await archiveTask(confirmModal.taskIds[0], modalCleanWorktree);
      } else if (confirmModal.type === 'batch_cancel') {
        await batchCancelTasks();
      } else if (confirmModal.type === 'batch_archive') {
        await batchArchiveTasks(modalCleanWorktree);
      }
    } finally {
      setConfirming(false);
      setConfirmModal(null);
    }
  };

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm mb-6 max-w-full overflow-hidden">
      <div className="card-body p-3 sm:p-4 md:p-6">
        {/* Controls Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <h2 className="card-title text-sm sm:text-base font-bold flex items-center gap-1.5 sm:gap-2">
              🕒 任务监控与调度流
            </h2>
            <select
              className="select select-sm select-bordered font-medium text-xs sm:text-sm"
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
            <select
              className="select select-sm select-bordered font-medium text-xs sm:text-sm"
              value={filterProject}
              onChange={(e) => setFilterProject(e.target.value)}
            >
              <option value="all">{t('filterAllProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  📁 {p.name || p.id}
                </option>
              ))}
            </select>
            <select
              className="select select-sm select-bordered font-medium text-xs sm:text-sm"
              value={filterPlan}
              onChange={(e) => setFilterPlan(e.target.value)}
            >
              <option value="all">按计划筛选 (全部)</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  📋 {p.title || p.id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="搜索任务 ID / 会话 / 账号..."
              className="input input-sm input-bordered w-full md:w-56 text-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn btn-sm btn-ghost gap-1" onClick={() => loadTasks()}>
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('refresh')}</span>
            </button>
          </div>
        </div>

        {/* Batch Toolbar */}
        {selectedTaskIds.size > 0 && (
          <div className="alert alert-info bg-info/10 border border-info/30 py-2 px-3 sm:px-4 rounded-lg flex flex-wrap items-center justify-between gap-2 mb-4">
            <span className="text-xs font-medium">
              已选中 <strong className="text-primary font-mono text-sm">{selectedTaskIds.size}</strong> 条任务
            </span>
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <button
                className="btn btn-xs btn-error"
                onClick={() =>
                  setConfirmModal({
                    type: 'batch_cancel',
                    taskIds: Array.from(selectedTaskIds),
                  })
                }
              >
                {t('batchCancel')}
              </button>
              <button
                className="btn btn-xs btn-ghost border border-base-300"
                onClick={() => {
                  setModalCleanWorktree(false);
                  setConfirmModal({
                    type: 'batch_archive',
                    taskIds: Array.from(selectedTaskIds),
                  });
                }}
              >
                {t('batchArchive')}
              </button>
              <button
                className="btn btn-xs btn-outline btn-error"
                onClick={() => {
                  setModalCleanWorktree(true);
                  setConfirmModal({
                    type: 'batch_archive',
                    taskIds: Array.from(selectedTaskIds),
                  });
                }}
              >
                {t('batchArchiveCleanWorktree')}
              </button>
            </div>
          </div>
        )}

        {/* Desktop / Tablet Table View (hidden on <= 640px) */}
        <div className="hidden sm:block overflow-x-auto min-h-[220px]">
          <table className="table table-zebra table-sm w-full font-sans">
            <thead>
              <tr className="border-b border-base-300 text-base-content/60 text-xs">
                <th className="w-8 text-center">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs"
                    checked={allFilteredSelected}
                    onChange={(e) => toggleSelectFilteredTasks(filteredIds, e.target.checked)}
                  />
                </th>
                <th className="w-40">{t('thTaskId')}</th>
                <th className="w-32">{t('thTopic')}</th>
                <th className="w-24">{t('thStatus')}</th>
                <th className="w-24">{t('thActivity')}</th>
                <th className="w-28">{t('thCreatedAt')}</th>
                <th className="w-28">{t('thFinishedAt')}</th>
                <th className="w-24">{t('thPr')}</th>
                <th className="w-36">引用计划</th>
                <th>{t('thLogTail')}</th>
                <th className="text-right w-48">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-base-content/40 text-sm">
                    {t('noData')}
                  </td>
                </tr>
              ) : (
                filteredTasks.map((task) => {
                  const isChecked = selectedTaskIds.has(task.taskId);

                  let badgeClass = 'badge-warning';
                  let statusLabel: string = task.status;
                  if (task.status === 'running') {
                    badgeClass = 'badge-info animate-pulse';
                    statusLabel = '● 运行中';
                  } else if (task.status === 'completed') {
                    badgeClass = 'badge-success';
                    statusLabel = '✓ 完成';
                  } else if (task.status === 'failed') {
                    badgeClass = 'badge-error';
                    statusLabel = '✕ 异常';
                  } else if (task.status === 'cancelled' || task.state === 'cancelled') {
                    badgeClass = 'badge-ghost border-base-content/30';
                    statusLabel = '已取消';
                  } else if (task.status === 'paused_quota') {
                    badgeClass = 'badge-secondary';
                    statusLabel = '额度暂停';
                  } else if (task.status === 'paused') {
                    badgeClass = 'badge-secondary';
                    statusLabel = '队列挂起';
                  } else if (task.status === 'queued') {
                    badgeClass = 'badge-warning';
                    statusLabel = '排队中';
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
                          className="font-mono text-xs text-primary font-bold cursor-pointer hover:underline block truncate max-w-[150px]"
                          title="点击复制 Task ID"
                          onClick={() => {
                            navigator.clipboard.writeText(task.taskId);
                            showToast(`已复制: ${task.taskId}`);
                          }}
                        >
                          {task.taskId}
                        </span>
                        {task.account && (
                          <div className="text-[11px] font-mono text-base-content/40 truncate max-w-[150px] mt-0.5" title={task.account}>
                            {task.account.replace('default:', '')}
                          </div>
                        )}
                      </td>
                      <td className="text-xs">
                        <div className="flex flex-col gap-1 items-start">
                          {(task.project_name || task.project) && (
                            <span className="badge badge-xs badge-primary badge-outline font-mono truncate max-w-[120px]" title={task.project_id || task.project}>
                              {task.project_name || task.project}
                            </span>
                          )}
                          {task.session_id ? (
                            <span className="font-mono text-[11px] text-base-content/70" title={task.session_id}>
                              {task.session_id.slice(0, 14)}...
                            </span>
                          ) : !task.project_name && !task.project ? (
                            <span className="text-base-content/30">-</span>
                          ) : null}
                        </div>
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
                      <td>
                        {task.plan_id ? (
                          <button
                            type="button"
                            onClick={() => openPlanDrawer(task.plan_id!, task.step_id)}
                            className="btn btn-ghost btn-xs text-primary font-medium hover:underline flex items-center gap-1 p-0 h-auto text-left"
                            title={`查看计划: ${task.plan_title || task.plan_id}`}
                          >
                            <span className="truncate max-w-[130px] font-mono text-xs">
                              {task.plan_title || task.plan_id}
                              {task.step_id ? ` · ${task.step_id}` : ''}
                            </span>
                          </button>
                        ) : (
                          <span className="text-base-content/30">–</span>
                        )}
                      </td>
                      <td className="max-w-[260px]">
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

                          {/* Running / Queued Cancel */}
                          {(task.status === 'running' || task.status === 'queued') && (
                            <button
                              className="btn btn-ghost btn-xs btn-square text-rose-400 hover:bg-rose-500/10"
                              title={task.status === 'queued' ? '取消排队' : '取消运行'}
                              onClick={() =>
                                setConfirmModal({
                                  type: 'cancel',
                                  taskIds: [task.taskId],
                                })
                              }
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {/* Queue Pause / Resume button if session_id is available */}
                          {task.session_id && (
                            task.status === 'paused' ? (
                              <button
                                className="btn btn-ghost btn-xs btn-square text-success hover:bg-success/10"
                                title="恢复该会话排队"
                                onClick={() => resumeQueueSession(task.session_id!)}
                              >
                                <Play className="w-3.5 h-3.5" />
                              </button>
                            ) : task.status === 'queued' ? (
                              <button
                                className="btn btn-ghost btn-xs btn-square text-warning hover:bg-warning/10"
                                title="暂停该会话排队"
                                onClick={() => pauseQueueSession(task.session_id!)}
                              >
                                <Pause className="w-3.5 h-3.5" />
                              </button>
                            ) : null
                          )}

                          {/* Paused Quota options */}
                          {task.status === 'paused_quota' && (
                            <>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-emerald-400 hover:bg-emerald-500/10"
                                title="续跑任务"
                                onClick={() => onOpenRetry(task, 'continue')}
                              >
                                <Play className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-info hover:bg-info/10"
                                title="换号改派"
                                onClick={() => onOpenRetry(task, 'switch_account')}
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="btn btn-ghost btn-xs btn-square text-rose-400 hover:bg-rose-500/10"
                                title="取消"
                                onClick={() =>
                                  setConfirmModal({
                                    type: 'cancel',
                                    taskIds: [task.taskId],
                                  })
                                }
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          {/* Failed / Cancelled / Completed options */}
                          {(task.status === 'failed' || task.status === 'cancelled' || task.state === 'cancelled') && (
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
                                title="归档此任务"
                                onClick={() => {
                                  setModalCleanWorktree(false);
                                  setConfirmModal({
                                    type: 'archive',
                                    taskIds: [task.taskId],
                                  });
                                }}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          {task.status === 'completed' && (
                            <button
                              className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
                              title="归档任务"
                              onClick={() => {
                                setModalCleanWorktree(false);
                                setConfirmModal({
                                  type: 'archive',
                                  taskIds: [task.taskId],
                                });
                              }}
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

        {/* Mobile Card List View (visible only on <= 640px) */}
        <div className="sm:hidden flex flex-col gap-3 min-w-0">
          <div className="flex items-center justify-between text-xs px-1 text-base-content/60">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={allFilteredSelected}
                onChange={(e) => toggleSelectFilteredTasks(filteredIds, e.target.checked)}
              />
              <span>全选当前 ({filteredTasks.length})</span>
            </label>
            <span>共 {filteredTasks.length} 条</span>
          </div>

          {filteredTasks.length === 0 ? (
            <div className="text-center py-8 text-base-content/40 text-xs">
              {t('noData')}
            </div>
          ) : (
            filteredTasks.map((task) => {
              const isChecked = selectedTaskIds.has(task.taskId);

              let badgeClass = 'badge-warning';
              let statusLabel: string = task.status;
              if (task.status === 'running') {
                badgeClass = 'badge-info animate-pulse';
                statusLabel = '● 运行中';
              } else if (task.status === 'completed') {
                badgeClass = 'badge-success';
                statusLabel = '✓ 完成';
              } else if (task.status === 'failed') {
                badgeClass = 'badge-error';
                statusLabel = '✕ 异常';
              } else if (task.status === 'cancelled' || task.state === 'cancelled') {
                badgeClass = 'badge-ghost border-base-content/30';
                statusLabel = '已取消';
              } else if (task.status === 'paused_quota') {
                badgeClass = 'badge-secondary';
                statusLabel = '额度暂停';
              } else if (task.status === 'paused') {
                badgeClass = 'badge-secondary';
                statusLabel = '队列挂起';
              } else if (task.status === 'queued') {
                badgeClass = 'badge-warning';
                statusLabel = '排队中';
              }

              return (
                <div
                  key={task.taskId}
                  className="bg-base-100 rounded-xl p-3 border border-base-300 shadow-sm flex flex-col gap-2 min-w-0"
                >
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <div className="flex items-start gap-2 min-w-0">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-xs mt-0.5 shrink-0"
                        checked={isChecked}
                        onChange={() => toggleSelectTask(task.taskId)}
                      />
                      <div className="min-w-0">
                        <div
                          className="font-mono text-xs text-primary font-bold truncate cursor-pointer hover:underline"
                          title="点击复制 Task ID"
                          onClick={() => {
                            navigator.clipboard.writeText(task.taskId);
                            showToast(`已复制: ${task.taskId}`);
                          }}
                        >
                          {task.taskId}
                        </div>
                        {task.account && (
                          <div className="text-[10px] font-mono text-base-content/40 truncate mt-0.5">
                            {task.account.replace('default:', '')}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className={`badge badge-sm ${badgeClass} text-[10px] font-medium shrink-0`}>
                      {statusLabel}
                    </span>
                  </div>

                  {/* Meta rows */}
                  <div className="grid grid-cols-2 gap-1 text-[11px] text-base-content/60 font-mono">
                    <div>创建: {formatTime(task.created_at)}</div>
                    <div className="text-right">
                      {task.status === 'running' ? (
                        <span className="text-info font-sans">进行中 {task.elapsed && `(${task.elapsed})`}</span>
                      ) : (
                        `结束: ${formatTime(task.finished_at)}`
                      )}
                    </div>
                  </div>

                  {/* Log Tail / Reason */}
                  {(task.reason || task.last_log_line) && (
                    <div className="bg-base-200/80 p-2 rounded text-[11px] font-mono truncate text-base-content/70">
                      {task.reason ? (
                        <span className="text-rose-400">{task.reason}</span>
                      ) : (
                        task.last_log_line
                      )}
                    </div>
                  )}

                  {/* Card Actions */}
                  <div className="flex items-center justify-between pt-1 border-t border-base-200/60 mt-1">
                    <div className="flex items-center gap-1.5">
                      <button
                        className="btn btn-ghost btn-xs text-xs px-2"
                        onClick={() => onOpenDetails(task.taskId)}
                      >
                        详情
                      </button>
                      <button
                        className="btn btn-ghost btn-xs text-xs px-2"
                        onClick={() => onOpenLogs(task.taskId)}
                      >
                        日志
                      </button>
                      {task.pr_url && (
                        <a
                          href={task.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-ghost btn-xs text-xs px-2 text-primary"
                        >
                          PR
                        </a>
                      )}
                      {task.plan_id && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-xs px-2 text-primary"
                          onClick={() => openPlanDrawer(task.plan_id!, task.step_id)}
                        >
                          计划: {task.plan_title || task.plan_id}
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      {(task.status === 'running' || task.status === 'queued') && (
                        <button
                          className="btn btn-ghost btn-xs text-rose-400"
                          onClick={() =>
                            setConfirmModal({
                              type: 'cancel',
                              taskIds: [task.taskId],
                            })
                          }
                        >
                          取消
                        </button>
                      )}

                      {task.status === 'paused_quota' && (
                        <>
                          <button
                            className="btn btn-ghost btn-xs text-emerald-400"
                            onClick={() => onOpenRetry(task, 'continue')}
                          >
                            续跑
                          </button>
                          <button
                            className="btn btn-ghost btn-xs text-rose-400"
                            onClick={() =>
                              setConfirmModal({
                                type: 'cancel',
                                taskIds: [task.taskId],
                              })
                            }
                          >
                            取消
                          </button>
                        </>
                      )}

                      {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                        <button
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => {
                            setModalCleanWorktree(false);
                            setConfirmModal({
                              type: 'archive',
                              taskIds: [task.taskId],
                            });
                          }}
                        >
                          归档
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Confirmation Modal (DaisyUI dialog) */}
      {confirmModal && (
        <div className="modal modal-open">
          <div className="modal-box bg-base-200 border border-base-300 max-w-md">
            <h3 className="font-bold text-base flex items-center gap-2 text-warning">
              <AlertTriangle className="w-5 h-5" />
              <span>
                {confirmModal.type === 'cancel' && '确认取消该任务？'}
                {confirmModal.type === 'batch_cancel' && '确认批量取消选中的任务？'}
                {confirmModal.type === 'archive' && '确认归档该任务？'}
                {confirmModal.type === 'batch_archive' && '确认批量归档选中的任务？'}
              </span>
            </h3>

            <div className="py-4 space-y-3 text-xs">
              <p className="text-base-content/80">
                将影响共 <strong className="text-primary font-bold font-mono text-sm">{confirmModal.taskIds.length}</strong> 条任务：
              </p>
              <div className="bg-base-100 p-2.5 rounded-lg border border-base-300 max-h-36 overflow-y-auto font-mono text-[11px] text-base-content/70 space-y-1">
                {confirmModal.taskIds.map((id) => (
                  <div key={id} className="truncate">
                    • {id}
                  </div>
                ))}
              </div>

              {(confirmModal.type === 'archive' || confirmModal.type === 'batch_archive') && (
                <div className="bg-warning/10 border border-warning/20 p-2.5 rounded-lg space-y-2">
                  <p className="text-warning-content text-[11px]">
                    默认归档会将任务状态、日志和结果移至 archive 目录中安全保存。
                  </p>
                  <label className="flex items-start gap-2 cursor-pointer text-xs font-semibold text-rose-400">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-xs checkbox-error mt-0.5"
                      checked={modalCleanWorktree}
                      onChange={(e) => setModalCleanWorktree(e.target.checked)}
                    />
                    <div className="space-y-0.5">
                      <span>同时清理关联的 Git Worktree 目录 (通过 git worktree remove)</span>
                      {modalCleanWorktree && (
                        <p className="text-[11px] text-error font-bold block animate-pulse">
                          ⚠ 会强制删除 worktree 中未提交的改动！
                        </p>
                      )}
                    </div>
                  </label>
                </div>
              )}
            </div>

            <div className="modal-action">
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setConfirmModal(null)}
                disabled={confirming}
              >
                取消
              </button>
              <button
                className={`btn btn-sm ${confirmModal.type.includes('cancel') ? 'btn-error' : 'btn-primary'}`}
                onClick={handleExecuteConfirm}
                disabled={confirming}
              >
                {confirming ? '处理中...' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};