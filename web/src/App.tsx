import React, { useEffect, useState } from 'react';
import { Navbar } from './components/Navbar';
import { ActionHomeView, buildHomePageViewModel } from './components/ActionHomeView';
import { MetricOverviewCards } from './components/MetricOverviewCards';
import { TaskTable } from './components/TaskTable';
import { QuotaOverviewStrip } from './components/QuotaOverviewStrip';
import { SettingsModal } from './components/SettingsModal';
import { PlanDrawer } from './components/PlanDrawer';
import { ActionModals } from './components/ActionModals';
import { useAppStore } from './stores/appStore';
import type { TaskItem } from './types';

export const App: React.FC = () => {
  const {
    loadConfig,
    loadProjects,
    loadPlans,
    loadSystemStats,
    loadTasks,
    loadPool,
    allTasks,
    systemIssues,
    poolAccounts,
    activeMainTab,
    setActiveMainTab,
    setSettingsOpen,
    toast,
  } = useAppStore();

  const [detailsTaskId, setDetailsTaskId] = useState<string | null>(null);
  const [logsTaskId, setLogsTaskId] = useState<string | null>(null);
  const [retryTask, setRetryTask] = useState<{
    task: TaskItem;
    mode: 'continue' | 'switch_account' | 'fresh';
  } | null>(null);

  useEffect(() => {
    loadConfig();
    loadProjects();
    loadPlans();
    loadSystemStats();
    loadTasks();
    loadPool();

    // Auto-refresh tasks every 5 seconds (pause when document is hidden)
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      loadTasks();
      loadSystemStats();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const homeVm = buildHomePageViewModel(allTasks, systemIssues);
  const homeActionCount =
    homeVm.needsHumanTasks.length +
    homeVm.visibleSystemIssues.length +
    homeVm.workingAndQueuedTasks.length;

  return (
    <div className="min-h-screen bg-base-100 flex flex-col font-sans">
      <Navbar />

      <main className="flex-1 w-full p-4 md:p-8">
        {/* Secondary Navigation Tabs */}
        <div className="flex items-center justify-between flex-wrap gap-2 mb-6 border-b border-base-300 pb-3">
          <div className="tabs tabs-boxed bg-base-200 p-1">
            <button
              type="button"
              className={`tab tab-sm md:tab-md gap-1.5 font-bold ${
                activeMainTab === 'home' ? 'tab-active' : ''
              }`}
              onClick={() => setActiveMainTab('home')}
            >
              <span>🏠 首页工作台</span>
              <span className="badge badge-xs font-mono">{homeActionCount}</span>
            </button>
            <button
              type="button"
              className={`tab tab-sm md:tab-md gap-1.5 font-bold ${
                activeMainTab === 'tasks' ? 'tab-active' : ''
              }`}
              onClick={() => setActiveMainTab('tasks')}
            >
              <span>📋 完整任务表</span>
              <span className="badge badge-xs font-mono">{allTasks.length}</span>
            </button>
            <button
              type="button"
              className={`tab tab-sm md:tab-md gap-1.5 font-bold ${
                activeMainTab === 'quota' ? 'tab-active' : ''
              }`}
              onClick={() => setActiveMainTab('quota')}
            >
              <span>🔋 配额明细</span>
              <span className="badge badge-xs font-mono">{poolAccounts.length}</span>
            </button>
          </div>

          <button
            type="button"
            className="btn btn-xs md:btn-sm btn-ghost border border-base-300 gap-1"
            onClick={() => setSettingsOpen(true)}
          >
            <span>📁 项目管理 / 设置</span>
          </button>
        </div>

        {/* Tab 1: Home View (Strictly 3 blocks: 待处理, 系统问题[hidden when healthy], 执行中) */}
        {activeMainTab === 'home' && (
          <ActionHomeView
            onOpenDetails={(tid) => setDetailsTaskId(tid)}
            onOpenLogs={(tid) => setLogsTaskId(tid)}
            onOpenRetry={(task, mode) => setRetryTask({ task, mode })}
          />
        )}

        {/* Tab 2: Full Task Table & Metric Cards */}
        {activeMainTab === 'tasks' && (
          <>
            <MetricOverviewCards />
            <TaskTable
              onOpenDetails={(tid) => setDetailsTaskId(tid)}
              onOpenLogs={(tid) => setLogsTaskId(tid)}
              onOpenRetry={(task, mode) => setRetryTask({ task, mode })}
            />
          </>
        )}

        {/* Tab 3: Quota Details */}
        {activeMainTab === 'quota' && <QuotaOverviewStrip />}
      </main>

      {/* Settings Modal (Dedicated Layer including Project Management) */}
      <SettingsModal />

      {/* Plan Details & Steps Drawer */}
      <PlanDrawer />

      {/* Modals for Task Details, Logs, Retry */}
      <ActionModals
        detailsTaskId={detailsTaskId}
        onCloseDetails={() => setDetailsTaskId(null)}
        logsTaskId={logsTaskId}
        onCloseLogs={() => setLogsTaskId(null)}
        retryTask={retryTask}
        onCloseRetry={() => setRetryTask(null)}
      />

      {/* Floating Toast Notification */}
      {toast && (
        <div className="toast toast-top toast-end z-50">
          <div className="alert alert-success shadow-lg text-xs font-bold py-2 px-4 rounded-xl flex items-center gap-2">
            <span>✅</span>
            <span>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
