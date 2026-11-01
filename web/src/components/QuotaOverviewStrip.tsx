import React from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Star, RefreshCw } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

export const QuotaOverviewStrip: React.FC = () => {
  const { t } = useTranslation();
  const { poolAccounts, loadPool } = useAppStore();

  const formatTime = (iso?: string) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mt-2">
          {poolAccounts.length === 0 ? (
            <div className="text-xs text-base-content/40 py-4 col-span-full text-center">
              暂未检测到 Cockpit 本地账号
            </div>
          ) : (
            poolAccounts.map((acc) => {
              const fraction = parseFloat(acc.quota_remaining || '1.0');
              const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
              const isPaused = acc.paused_until && acc.paused_until !== 'none';

              let progressColor = 'progress-success';
              let textColor = 'text-emerald-400';
              if (pct <= 20) {
                progressColor = 'progress-error';
                textColor = 'text-rose-400';
              } else if (pct <= 50) {
                progressColor = 'progress-warning';
                textColor = 'text-amber-400';
              }

              return (
                <div
                  key={acc.email}
                  className="bg-base-100 p-3.5 rounded-xl border border-base-300 flex flex-col gap-2 hover:border-primary/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-bold text-xs truncate flex-1">
                      {acc.cockpit_current && (
                        <span title="当前 Cockpit 活跃主账号" className="inline-flex shrink-0">
                          <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                        </span>
                      )}
                      <span className="truncate">{acc.email}</span>
                    </div>
                    <span className={`font-mono text-xs font-bold shrink-0 ${textColor}`}>
                      {pct}%
                    </span>
                  </div>

                  <progress
                    className={`progress w-full h-1.5 ${progressColor}`}
                    value={pct}
                    max="100"
                  ></progress>

                  <div className="flex items-center justify-between text-[11px] text-base-content/60">
                    <div className="shrink-0">
                      {isPaused ? (
                        <span className="badge badge-xs badge-secondary font-medium">⏸ 暂停</span>
                      ) : pct <= 5 ? (
                        <span className="text-rose-400 font-medium">⚠ 耗尽</span>
                      ) : (
                        <span className="text-emerald-400">● 正常</span>
                      )}
                    </div>
                    {acc.reset_time && (
                      <span className="font-mono text-[10px] text-base-content/40 truncate text-right ml-2">
                        重置: {formatTime(acc.reset_time)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
