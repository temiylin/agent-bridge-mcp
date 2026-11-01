import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Star, RefreshCw, Play, Clock, Calendar } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

export const QuotaOverviewStrip: React.FC = () => {
  const { t } = useTranslation();
  const { poolAccounts, loadPool } = useAppStore();
  const [resumingEmail, setResumingEmail] = useState<string | null>(null);

  const formatTime = (iso?: string | number) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handleResume = async (email: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setResumingEmail(email);
      const res = await fetch('/api/pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resume_email', email }),
      });
      if (res.ok) {
        await loadPool();
      }
    } catch (err) {
      console.error('Failed to resume email', err);
    } finally {
      setResumingEmail(null);
    }
  };

  const getProgressColor = (pct: number) => {
    if (pct <= 20) return 'progress-error';
    if (pct <= 50) return 'progress-warning';
    return 'progress-success';
  };

  const getTextColor = (pct: number) => {
    if (pct <= 20) return 'text-rose-400';
    if (pct <= 50) return 'text-amber-400';
    return 'text-emerald-400';
  };

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm mb-8">
      <div className="card-body p-4 md:p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="card-title text-sm md:text-base font-bold flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              <span>{t('quotaTitle')}</span>
            </h3>
            <p className="text-xs text-base-content/60">
              {t('quotaSubtitle')}
            </p>
          </div>
          <button className="btn btn-ghost btn-xs gap-1" onClick={() => loadPool()}>
            <RefreshCw className="w-3 h-3" />
            <span>{t('refresh')}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3.5 mt-2">
          {poolAccounts.length === 0 ? (
            <div className="text-xs text-base-content/40 py-4 col-span-full text-center">
              暂未检测到 Cockpit 本地账号
            </div>
          ) : (
            poolAccounts.map((acc) => {
              const fraction = parseFloat(acc.quota_remaining || '1.0');
              const overallPct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
              const isPaused = acc.paused_until && acc.paused_until !== 'none';

              // 5-hour short window
              const shortPct = acc.quota_5h !== undefined ? acc.quota_5h.pct : overallPct;
              const shortReset = acc.quota_5h?.reset_time || acc.reset_time;

              // Weekly window
              const weeklyPct = acc.quota_weekly !== undefined ? acc.quota_weekly.pct : null;
              const weeklyReset = acc.quota_weekly?.reset_time;

              return (
                <div
                  key={acc.email}
                  className="bg-base-100 p-4 rounded-xl border border-base-300 flex flex-col gap-2.5 hover:border-primary/40 transition-colors shadow-sm"
                >
                  {/* Account Header */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-bold text-xs truncate flex-1">
                      {acc.cockpit_current && (
                        <span title="当前 Cockpit 活跃主账号" className="inline-flex shrink-0">
                          <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                        </span>
                      )}
                      <span className="truncate" title={acc.email}>{acc.email}</span>
                    </div>
                    {/* Status Badge & Resume Button */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isPaused ? (
                        <div className="flex items-center gap-1">
                          <span
                            className="badge badge-xs badge-secondary font-medium"
                            title={`暂停至: ${formatTime(acc.paused_until)}${acc.pause_reason ? ` (${acc.pause_reason})` : ''}`}
                          >
                            ⏸ 暂停
                          </span>
                          <button
                            className="btn btn-ghost btn-xs text-[10px] h-5 min-h-0 px-1.5 text-success hover:bg-success/10 font-bold"
                            onClick={(e) => handleResume(acc.email, e)}
                            disabled={resumingEmail === acc.email}
                            title="解除暂停并立即恢复调度此账号"
                          >
                            <Play className="w-2.5 h-2.5" />
                            <span>{resumingEmail === acc.email ? '...' : '恢复'}</span>
                          </button>
                        </div>
                      ) : shortPct <= 5 ? (
                        <span className="text-rose-400 font-medium text-xs">⚠ 耗尽</span>
                      ) : (
                        <span className="text-emerald-400 text-xs">● 正常</span>
                      )}
                    </div>
                  </div>

                  {/* 5-Hour Rolling Window Bar */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-base-content/70 flex items-center gap-1">
                        <Clock className="w-3 h-3 text-base-content/50" />
                        <span>5小时额度</span>
                      </span>
                      <div className="flex items-center gap-2">
                        {shortReset && (
                          <span className="font-mono text-[10px] text-base-content/40">
                            重置: {formatTime(shortReset)}
                          </span>
                        )}
                        <span className={`font-mono font-bold ${getTextColor(shortPct)}`}>
                          {shortPct}%
                        </span>
                      </div>
                    </div>
                    <progress
                      className={`progress w-full h-1.5 ${getProgressColor(shortPct)}`}
                      value={shortPct}
                      max="100"
                    ></progress>
                  </div>

                  {/* Weekly Window Bar (if applicable) */}
                  {weeklyPct !== null ? (
                    <div className="space-y-1 border-t border-base-200 pt-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-base-content/70 flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-purple-400" />
                          <span>周额度 (Argon/每周)</span>
                        </span>
                        <div className="flex items-center gap-2">
                          {weeklyReset && (
                            <span className="font-mono text-[10px] text-base-content/40">
                              重置: {formatTime(weeklyReset)}
                            </span>
                          )}
                          <span className={`font-mono font-bold ${getTextColor(weeklyPct)}`}>
                            {weeklyPct}%
                          </span>
                        </div>
                      </div>
                      <progress
                        className={`progress w-full h-1.5 ${getProgressColor(weeklyPct)}`}
                        value={weeklyPct}
                        max="100"
                      ></progress>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
