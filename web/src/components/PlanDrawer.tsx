import React from 'react';
import { useAppStore } from '../stores/appStore';
import {
  X,
  FileText,
  CheckCircle2,
  Clock,
  AlertCircle,
  ExternalLink,
  GitPullRequest,
  Check,
  Copy,
  FolderGit2,
} from 'lucide-react';
import type { PlanStepStatus } from '../types';

export const PlanDrawer: React.FC = () => {
  const {
    planDrawerOpen,
    planDrawerPlanId,
    planDrawerStepId,
    closePlanDrawer,
    activePlan,
    showToast,
  } = useAppStore();

  const [copiedTask, setCopiedTask] = React.useState<string | null>(null);

  if (!planDrawerOpen) return null;

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedTask(text);
    showToast(`已复制 ${label}: ${text}`);
    setTimeout(() => setCopiedTask(null), 2000);
  };

  const getStatusBadge = (status: PlanStepStatus) => {
    switch (status) {
      case 'done':
        return <span className="badge badge-success badge-sm gap-1"><CheckCircle2 className="w-3 h-3" /> 已完成</span>;
      case 'in_progress':
        return <span className="badge badge-info badge-sm gap-1 animate-pulse"><Clock className="w-3 h-3" /> 执行中</span>;
      case 'failed':
        return <span className="badge badge-error badge-sm gap-1"><AlertCircle className="w-3 h-3" /> 失败</span>;
      case 'skipped':
        return <span className="badge badge-warning badge-sm gap-1">已跳过</span>;
      case 'todo':
      default:
        return <span className="badge badge-ghost badge-sm text-base-content/60">待开始</span>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-xs flex justify-end animate-fadeIn">
      <div
        className="fixed inset-0"
        onClick={closePlanDrawer}
        aria-hidden="true"
      />

      <div className="relative w-full max-w-2xl bg-base-100 h-full shadow-2xl flex flex-col z-10 border-l border-base-300">
        {/* Header */}
        <div className="p-4 border-b border-base-300 flex items-start justify-between bg-base-200/50">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="badge badge-primary badge-outline font-mono text-xs">
                Plan v{activePlan?.version ?? 1}
              </span>
              {activePlan?.project_id && (
                <span className="badge badge-ghost badge-sm font-mono flex items-center gap-1">
                  <FolderGit2 className="w-3 h-3" />
                  {activePlan.project_id}
                </span>
              )}
            </div>
            <h2 className="text-lg font-bold text-base-content flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              <span>{activePlan?.title || planDrawerPlanId}</span>
            </h2>
            <div className="font-mono text-xs text-base-content/50">
              ID: {planDrawerPlanId}
            </div>
          </div>
          <button
            onClick={closePlanDrawer}
            className="btn btn-ghost btn-sm btn-circle"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {!activePlan ? (
            <div className="flex items-center justify-center py-12">
              <span className="loading loading-spinner loading-md text-primary" />
              <span className="ml-2 text-sm text-base-content/60">加载计划详情中...</span>
            </div>
          ) : (
            <>
              {/* Context Section */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-base-content/60 uppercase tracking-wider">
                  背景说明与目标 (Context)
                </h3>
                <div className="bg-base-200 rounded-lg p-3 text-xs md:text-sm font-sans whitespace-pre-wrap text-base-content/80 max-h-48 overflow-y-auto border border-base-300">
                  {activePlan.context || <span className="italic text-base-content/40">无背景说明</span>}
                </div>
              </div>

              {/* Steps Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-base-content/60 uppercase tracking-wider">
                    执行步骤 ({activePlan.steps.length})
                  </h3>
                  <span className="text-xs font-mono text-base-content/50">
                    完成率: {activePlan.steps.filter((s) => s.status === 'done').length}/{activePlan.steps.length}
                  </span>
                </div>

                <div className="space-y-3">
                  {activePlan.steps.map((step, idx) => {
                    const isCurrentStep = step.id === planDrawerStepId;

                    return (
                      <div
                        key={step.id || idx}
                        className={`rounded-lg border p-3.5 transition-all ${
                          isCurrentStep
                            ? 'border-primary bg-primary/5 shadow-xs ring-1 ring-primary/30'
                            : 'border-base-300 bg-base-100 hover:border-base-content/20'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="badge badge-sm badge-neutral font-mono font-bold">
                              #{idx + 1}
                            </span>
                            <span className="font-semibold text-sm text-base-content">
                              {step.title}
                            </span>
                            {isCurrentStep && (
                              <span className="badge badge-primary badge-xs font-bold animate-pulse">
                                当前步骤
                              </span>
                            )}
                          </div>
                          <div>{getStatusBadge(step.status)}</div>
                        </div>

                        {step.detail && (
                          <div className="text-xs text-base-content/70 whitespace-pre-wrap bg-base-200/50 rounded p-2.5 mb-2 font-mono border border-base-300/40">
                            {step.detail}
                          </div>
                        )}

                        {/* Associated Task IDs & PR Links */}
                        <div className="flex items-center gap-2 flex-wrap text-xs pt-1">
                          {step.task_ids && step.task_ids.length > 0 && (
                            <div className="flex items-center gap-1 flex-wrap">
                              <span className="text-base-content/50 text-[11px]">任务:</span>
                              {step.task_ids.map((tid) => (
                                <button
                                  key={tid}
                                  onClick={() => handleCopy(tid, 'Task ID')}
                                  className="badge badge-ghost badge-sm font-mono gap-1 hover:badge-primary cursor-pointer"
                                  title="点击复制 Task ID"
                                >
                                  {copiedTask === tid ? (
                                    <Check className="w-2.5 h-2.5 text-success" />
                                  ) : (
                                    <Copy className="w-2.5 h-2.5 opacity-60" />
                                  )}
                                  <span>{tid}</span>
                                </button>
                              ))}
                            </div>
                          )}

                          {step.pr_urls && step.pr_urls.length > 0 && (
                            <div className="flex items-center gap-1 flex-wrap ml-auto">
                              {step.pr_urls.map((prUrl, prIdx) => (
                                <a
                                  key={prIdx}
                                  href={prUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="btn btn-xs btn-outline btn-success gap-1"
                                >
                                  <GitPullRequest className="w-3 h-3" />
                                  <span>PR #{prUrl.split('/').pop()}</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-base-300 flex justify-end bg-base-200/30">
          <button onClick={closePlanDrawer} className="btn btn-sm btn-ghost">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
