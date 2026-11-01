import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Cpu,
  HardDrive,
  Settings,
  Languages,
  Terminal,
  Sun,
  Moon,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';

export const Navbar: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { systemStats, setSettingsOpen } = useAppStore();

  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [port, setPort] = useState<string>('38080');

  useEffect(() => {
    const savedTheme = (localStorage.getItem('agent_bridge_theme') as 'dark' | 'light') || 'dark';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);
    if (typeof window !== 'undefined' && window.location.port) {
      setPort(window.location.port);
    }
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('agent_bridge_theme', nextTheme);
  };

  const toggleLang = () => {
    i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh');
  };

  const freeMem = parseFloat(systemStats?.freeMemGb || '10');
  const isMemLow = freeMem < 2.0;

  return (
    <header className="navbar bg-base-200 border-b border-base-300 px-3 md:px-8 sticky top-0 z-30 max-w-full overflow-hidden">
      <div className="flex-1 gap-2 md:gap-3 items-center min-w-0">
        <div className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-primary flex items-center justify-center shadow-lg text-primary-content font-bold text-lg md:text-xl shrink-0">
          ⚡
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
            <span className="font-bold text-sm md:text-lg tracking-tight truncate">Agent Bridge</span>
            <div className="badge badge-success badge-sm gap-1 text-[10px] md:text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
              {t('onlineStatus')} ({port})
            </div>
          </div>
          <p className="text-xs text-base-content/60 hidden sm:block truncate">
            {t('appSubtitle')}
          </p>
        </div>
      </div>

      {/* Center compact hardware indicators */}
      <div className="hidden lg:flex items-center gap-4 text-xs font-mono bg-base-100 px-3 py-1.5 rounded-lg border border-base-300 mr-4">
        <div className="flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-info" />
          <span>{systemStats?.cpuModel || 'CPU'} ({systemStats?.cores || 0}C)</span>
        </div>
        <div className={`flex items-center gap-1.5 ${isMemLow ? 'text-error font-bold' : ''}`}>
          <HardDrive className="w-3.5 h-3.5 text-secondary" />
          <span>{systemStats?.freeMemGb || 0}G / {systemStats?.totalMemGb || 0}G</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-success" />
          <span>PID: {systemStats?.workerPid || 'Active'}</span>
        </div>
      </div>

      <div className="flex-none gap-1 md:gap-2">
        {/* Theme toggle */}
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换至亮色模式 / Switch to Light' : '切换至暗黑模式 / Switch to Dark'}
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4 text-warning" />
          ) : (
            <Moon className="w-4 h-4 text-primary" />
          )}
        </button>

        {/* Language switch */}
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={toggleLang}
          title="切换语言 / Switch Language"
        >
          <Languages className="w-4 h-4" />
        </button>

        {/* Local links dropdown */}
        <div className="dropdown dropdown-end">
          <button tabIndex={0} className="btn btn-ghost btn-sm gap-1">
            <Terminal className="w-4 h-4" />
            <span className="hidden md:inline">API</span>
          </button>
          <ul tabIndex={0} className="dropdown-content menu p-2 shadow-xl bg-base-200 border border-base-300 rounded-box w-48 text-xs z-50">
            <li><a href="/health" target="_blank" rel="noreferrer">🩺 健康检测 (/health)</a></li>
            <li><a href="/status" target="_blank" rel="noreferrer">📊 运行状态 (/status)</a></li>
            <li><a href="/mcp" target="_blank" rel="noreferrer">🔌 MCP 端点 (/mcp)</a></li>
          </ul>
        </div>

        {/* Settings button */}
        <button
          className="btn btn-primary btn-sm gap-1.5 shadow"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="w-4 h-4" />
          <span>{t('settings')}</span>
        </button>
      </div>
    </header>
  );
};
