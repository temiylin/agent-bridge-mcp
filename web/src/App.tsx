import React, { useEffect, useState } from 'react';
import { Navbar } from './components/Navbar';
import { MetricOverviewCards } from './components/MetricOverviewCards';
import { TaskTable } from './components/TaskTable';
import { QuotaOverviewStrip } from './components/QuotaOverviewStrip';
import { SettingsModal } from './components/SettingsModal';
import { ActionModals } from './components/ActionModals';
import { useAppStore } from './stores/appStore';
import type { TaskItem } from './types';

export const App: React.FC = () => {
  const {
    loadConfig,
    loadProjects,
    loadSystemStats,
    loadTasks,
    loadPool,
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
    loadSystemStats();
    loadTasks();
    loadPool();

    // Auto-refresh tasks every 5 seconds (pause when document is hidden)
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      loadTasks();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen bg-base-100 flex flex-col font-sans">
      <Navbar />

      <main className="flex-1 w-full p-4 md:p-8">
        {/* Top Metric Cards */}
        <MetricOverviewCards />

        {/* Task Monitoring Stream */}
        <TaskTable
          onOpenDetails={(tid) => setDetailsTaskId(tid)}
          onOpenLogs={(tid) => setLogsTaskId(tid)}
          onOpenRetry={(task, mode) => setRetryTask({ task, mode })}
        />

        {/* Read-Only Account Quota Strip */}
        <QuotaOverviewStrip />
      </main>

      {/* Settings Modal (Dedicated Layer) */}
      <SettingsModal />

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
