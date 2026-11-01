import React from 'react';
import {
  AlertTriangle,
  ExternalLink,
  RotateCcw,
  Play,
  HelpCircle,
  CheckCircle2,
  Loader2,
  Clock,
  ShieldAlert,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { TaskItem, SystemIssueItem } from '../types';

export interface HomePageViewModel {
  needsHumanTasks: TaskItem[];
  needsHumanBadgeCount: number;
  visibleSystemIssues: SystemIssueItem[];
  systemIssuesBadgeCount: number;
  showSystemIssuesBlock: boolean;
  workingAndQueuedTasks: TaskItem[];
  workingBadgeCount: number;
  isHealthyEmpty: boolean;
  emptyStateText: string;
}

/**
 * Pure selector building the Home Page view model so both React rendering and automated tests
 * verify the exact invariants:
 * - Only `stage` starting with `needs_human/` in "待处理"
 * - Only `consecutiveFailures >= 3` in "系统问题", hidden completely when healthy (0 items)
 * - Only `working` / `queued` in "执行中"
 * - Every badge count strictly equals its rendered list length (`list.length`)
 * - When all three blocks are empty, shows `"没有需要你处理的事"`
 */
export function buildHomePageViewModel(
  allTasks: TaskItem[],
  systemIssues: SystemIssueItem[]
): HomePageViewModel {
  const needsHumanTasks = allTasks.filter((t) => Boolean(t.stage && t.stage.startsWith('needs_human/')));
  const visibleSystemIssues = (systemIssues || []).filter(
    (issue) => typeof issue.consecutiveFailures === 'number' && issue.consecutiveFailures >= 3
  );
  const workingAndQueuedTasks = allTasks.filter(
    (t) => t.stage === 'working' || t.stage === 'queued'
  );

  const isHealthyEmpty =
    needsHumanTasks.length === 0 &&
    visibleSystemIssues.length === 0 &&
    workingAndQueuedTasks.length === 0;

  return {
    needsHumanTasks,
    needsHumanBadgeCount: needsHumanTasks.length,
    visibleSystemIssues,
    systemIssuesBadgeCount: visibleSystemIssues.length,
    showSystemIssuesBlock: visibleSystemIssues.length > 0,
    workingAndQueuedTasks,
    workingBadgeCount: workingAndQueuedTasks.length,
    isHealthyEmpty,
    emptyStateText: '没有需要你处理的事',
  };
}

interface ActionHomeViewProps {
  onOpenDetails: (taskId: string) => void;
  onOpenLogs: (taskId: string) => void;
  onOpenRetry: (task: TaskItem, mode: 'continue' | 'switch_account' | 'fresh') => void;
  tasksOverride?: TaskItem[];
  systemIssuesOverride?: SystemIssueItem[];
}

export const ActionHomeView: React.FC<ActionHomeViewProps> = ({
  onOpenDetails,
  onOpenRetry,
  tasksOverride,
  systemIssuesOverride,
}) => {
  const {
    allTasks,
    systemIssues,
    resumeQueueSession,
    setSettingsOpen,
    showToast,
  } = useAppStore();

  const vm = buildHomePageViewModel(
    tasksOverride ?? allTasks,
    systemIssuesOverride ?? systemIssues
  );

  const describeWaitingReason = (task: TaskItem): { badge: string; badgeClass: string; reasonText: string } => {
    switch (task.stage) {
      case 'needs_human/failed':
        return {
          badge: '执行失败',
          badgeClass: 'badge-error',
          reasonText: task.reason || task.report?.summary || task.last_log_line || '任务执行失败或超时，等待重试或排查',
        };
      case 'needs_human/quota':
        return {
          badge: '额度暂停',
          badgeClass: 'badge-secondary',
          reasonText: task.reason || '账号额度耗尽已挂起，等待切换账号或恢复队列',
        };
      case 'needs_human/stalled':
        return {
          badge: '疑似卡住',
          badgeClass: 'badge-warning',
          reasonText: task.reason || '长时间无输出或文件变更，等待人工确认或重试',
        };
      case 'needs_human/answer':
        return {
          badge: '等待回答',
          badgeClass: 'badge-info',
          reasonText: task.question || task.report?.question || 'Agent 提出了待确认问题，等待回复后继续',
        };
      case 'needs_human/review':
        return {
          badge: '待审 PR',
          badgeClass: 'badge-success',
          reasonText: task.report?.summary || task.pr_url || 'PR 已就绪且处于 Open 状态，等待 Review / 合并',
        };
      default:
        return {
          badge: '待处理',
          badgeClass: 'badge-warning',
          reasonText: task.reason || task.last_log_line || '等待人工处理',
        };
    }
  };

  if (vm.isHealthyEmpty) {
    return (
      <div
        data-testid="home-empty-state"
        className="card bg-base-200 border border-base-300 shadow-sm p-12 text-center my-4"
      >
        <div className="flex flex-col items-center justify-center gap-3">
          <CheckCircle2 className="w-10 h-10 text-emerald-400" />
          <p className="text-base font-bold text-base-content">{vm.emptyStateText}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Block A: 待处理 (needs_human/*) */}
      <section
        data-testid="home-needs-human-section"
        className="card bg-base-200 border border-base-300 shadow-sm"
      >
        <div className="card-body p-4 md:p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title text-sm md:text-base font-bold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" />
              <span>待处理</span>
              <span
                data-testid="badge-needs-human"
                className="badge badge-warning badge-sm font-mono"
              >
                {vm.needsHumanBadgeCount}
              </span>
            </h2>
          </div>

          {vm.needsHumanTasks.length === 0 ? (
            <div className="text-xs text-base-content/50 py-3">暂无待处理任务</div>
          ) : (
            <div className="divide-y divide-base-300">
              {vm.needsHumanTasks.map((task) => {
                const info = describeWaitingReason(task);
                const prLink = task.pr_url || task.report?.pr_url || undefined;
                return (
                  <div
                    key={task.taskId}
                    className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`badge badge-xs ${info.badgeClass} py-2 font-semibold`}>
                          {info.badge}
                        </span>
                        <button
                          type="button"
                          className="font-mono text-xs font-bold text-primary hover:underline truncate"
                          onClick={() => onOpenDetails(task.taskId)}
                        >
                          {task.taskId}
                        </button>
                        {(task.project_name || task.project) && (
                          <span className="badge badge-ghost badge-xs font-mono">
                            📁 {task.project_name || task.project}
                          </span>
                        )}
                        {task.agent && (
                          <span className="text-[11px] text-base-content/60 font-mono">
                            [{task.agent}{task.model ? ` / ${task.model}` : ''}]
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-base-content/80 break-words line-clamp-2">
                        {info.reasonText}
                      </p>
                    </div>

                    {/* Direct Action Buttons */}
                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      {prLink && (
                        <a
                          href={prLink}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-xs btn-success gap-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>打开 PR</span>
                        </a>
                      )}

                      {(task.stage === 'needs_human/failed' ||
                        task.stage === 'needs_human/stalled' ||
                        task.stage === 'needs_human/quota') && (
                        <button
                          type="button"
                          className="btn btn-xs btn-primary gap-1"
                          onClick={() =>
                            onOpenRetry(
                              task,
                              task.stage === 'needs_human/quota' ? 'switch_account' : 'continue'
                            )
                          }
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>重试</span>
                        </button>
                      )}

                      {(task.stage === 'needs_human/quota' || task.session_id) && (
                        <button
                          type="button"
                          className="btn btn-xs btn-secondary btn-outline gap-1"
                          onClick={() => {
                            if (task.session_id) {
                              resumeQueueSession(task.session_id);
                            } else {
                              onOpenRetry(task, 'continue');
                            }
                          }}
                        >
                          <Play className="w-3 h-3" />
                          <span>恢复队列</span>
                        </button>
                      )}

                      {(task.stage === 'needs_human/answer' ||
                        Boolean(task.question || task.report?.question)) && (
                        <button
                          type="button"
                          className="btn btn-xs btn-info gap-1"
                          onClick={() => {
                            onOpenDetails(task.taskId);
                            const qText = task.question || task.report?.question;
                            if (qText) showToast(`问题: ${qText.slice(0, 60)}`);
                          }}
                        >
                          <HelpCircle className="w-3 h-3" />
                          <span>查看问题</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Block B: 系统问题 (only shown when consecutiveFailures >= 3; completely hidden when healthy) */}
      {vm.showSystemIssuesBlock && (
        <section
          data-testid="home-system-issues-section"
          className="card bg-error/10 border border-error/40 shadow-sm"
        >
          <div className="card-body p-4 md:p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="card-title text-sm md:text-base font-bold text-error flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" />
                <span>系统问题</span>
                <span
                  data-testid="badge-system-issues"
                  className="badge badge-error badge-sm font-mono"
                >
                  {vm.systemIssuesBadgeCount}
                </span>
              </h2>
            </div>

            <div className="divide-y divide-error/20">
              {vm.visibleSystemIssues.map((issue) => (
                <div
                  key={issue.id}
                  className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div>
                    <div className="font-bold text-xs text-error flex items-center gap-2">
                      <span>{issue.title}</span>
                      <span className="badge badge-error badge-outline badge-xs font-mono">
                        连续 {issue.consecutiveFailures} 次
                      </span>
                    </div>
                    <p className="text-xs text-base-content/70 mt-0.5">{issue.detail}</p>
                  </div>
                  <div className="shrink-0">
                    <button
                      type="button"
                      className="btn btn-xs btn-outline btn-error"
                      onClick={() => setSettingsOpen(true)}
                    >
                      打开设置排查
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Block C: 执行中 (working / queued, one compact line per task) */}
      <section
        data-testid="home-working-section"
        className="card bg-base-200 border border-base-300 shadow-sm"
      >
        <div className="card-body p-4 md:p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title text-sm md:text-base font-bold flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-info animate-spin" />
              <span>执行中</span>
              <span
                data-testid="badge-working"
                className="badge badge-info badge-sm font-mono"
              >
                {vm.workingBadgeCount}
              </span>
            </h2>
          </div>

          {vm.workingAndQueuedTasks.length === 0 ? (
            <div className="text-xs text-base-content/50 py-2">当前无运行或排队任务</div>
          ) : (
            <div className="divide-y divide-base-300">
              {vm.workingAndQueuedTasks.map((task) => {
                const isWorking = task.stage === 'working';
                return (
                  <div
                    key={task.taskId}
                    className="py-2 flex items-center justify-between gap-3 text-xs overflow-hidden"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                      <span
                        className={`badge badge-xs shrink-0 ${
                          isWorking ? 'badge-info' : 'badge-warning'
                        }`}
                      >
                        {isWorking ? '运行中' : '排队中'}
                      </span>
                      <button
                        type="button"
                        className="font-mono font-bold text-primary hover:underline shrink-0"
                        onClick={() => onOpenDetails(task.taskId)}
                      >
                        {task.taskId}
                      </button>
                      {(task.project_name || task.project) && (
                        <span className="badge badge-ghost badge-xs font-mono shrink-0">
                          {task.project_name || task.project}
                        </span>
                      )}
                      {task.agent && (
                        <span className="text-base-content/60 font-mono shrink-0">
                          {task.agent}
                        </span>
                      )}
                      <span className="text-base-content/60 truncate">
                        {task.last_log_line || task.reason || ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 font-mono text-[11px] text-base-content/60">
                      <Clock className="w-3 h-3" />
                      <span>{task.elapsed || '排队'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
