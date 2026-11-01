import React from 'react';
import { useTranslation } from 'react-i18next';
import { PlayCircle, Clock, PauseCircle, CheckCircle2, XCircle } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

export const MetricOverviewCards: React.FC = () => {
  const { t } = useTranslation();
  const { allTasks, filterStatus, setFilterStatus } = useAppStore();

  const now = new Date();
  const todayYMD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let running = 0;
  let queued = 0;
  let pausedQuota = 0;
  let completedToday = 0;
  let failedToday = 0;

  allTasks.forEach((t) => {
    if (t.status === 'running') running++;
    else if (t.status === 'queued') queued++;
    else if (t.status === 'paused_quota' || t.status === 'paused') pausedQuota++;

    const isToday =
      (t.finished_at && t.finished_at.startsWith(todayYMD)) ||
      (t.created_at && t.created_at.startsWith(todayYMD));
    if (isToday) {
      if (t.status === 'completed') completedToday++;
      else if (t.status === 'failed' || t.state === 'cancelled') failedToday++;
    }
  });

  const cards = [
    {
      id: 'running',
      icon: PlayCircle,
      title: t('metricRunning'),
      count: running,
      hint: t('metricRunningHint'),
      textColor: 'text-sky-400',
      activeBorder: 'border-sky-400/80 bg-sky-500/10',
    },
    {
      id: 'queued',
      icon: Clock,
      title: t('metricQueued'),
      count: queued,
      hint: t('metricQueuedHint'),
      textColor: 'text-amber-400',
      activeBorder: 'border-amber-400/80 bg-amber-500/10',
    },
    {
      id: 'paused_quota',
      icon: PauseCircle,
      title: t('metricPaused'),
      count: pausedQuota,
      hint: t('metricPausedHint'),
      textColor: 'text-purple-400',
      activeBorder: 'border-purple-400/80 bg-purple-500/10',
    },
    {
      id: 'completed',
      icon: CheckCircle2,
      title: t('metricCompletedToday'),
      count: completedToday,
      hint: t('metricCompletedTodayHint'),
      textColor: 'text-emerald-400',
      activeBorder: 'border-emerald-400/80 bg-emerald-500/10',
    },
    {
      id: 'failed',
      icon: XCircle,
      title: t('metricFailedToday'),
      count: failedToday,
      hint: t('metricFailedTodayHint'),
      textColor: 'text-rose-400',
      activeBorder: 'border-rose-400/80 bg-rose-500/10',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
      {cards.map((c) => {
        const Icon = c.icon;
        const isActive = filterStatus === c.id;
        return (
          <div
            key={c.id}
            onClick={() => setFilterStatus(c.id)}
            className={`cursor-pointer rounded-xl p-4 border bg-base-200 transition-all duration-200 hover:scale-[1.02] hover:border-primary/50 shadow-sm ${
              isActive ? c.activeBorder : 'border-base-300'
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs text-base-content/70 font-medium mb-1">
              <Icon className={`w-4 h-4 ${c.textColor}`} />
              <span>{c.title}</span>
            </div>
            <div className={`text-2xl lg:text-3xl font-extrabold font-mono tracking-tight ${c.textColor}`}>
              {c.count}
            </div>
            <div className="text-[11px] text-base-content/50 truncate mt-1">
              {c.hint}
            </div>
          </div>
        );
      })}
    </div>
  );
};
