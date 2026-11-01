import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

const resources = {
  zh: {
    translation: {
      appName: 'Agent Bridge 智能调度控制台',
      appSubtitle: '本地 AI Agent 场景路由偏好与执行环境管理',
      onlineStatus: '本地服务已激活',
      settings: '设置与配置',
      save: '保存配置',
      saveSuccess: '配置保存成功，即刻生效！',
      refresh: '刷新',
      cancel: '取消',
      confirm: '确定',
      close: '关闭',
      status: '状态',
      actions: '操作',
      viewAll: '全部',
      loading: '加载中...',
      noData: '暂无数据',
      copied: '已复制到剪贴板',

      // Overview Cards
      metricRunning: '运行中任务',
      metricRunningHint: '正在占用 Agent 执行',
      metricQueued: '排队等待中',
      metricQueuedHint: '等待可用空闲通道',
      metricPaused: '额度暂停',
      metricPausedHint: '等待额度恢复或改派',
      metricCompletedToday: '今日完成',
      metricCompletedTodayHint: '今日已交付的 PR/产物',
      metricFailedToday: '今日异常/取消',
      metricFailedTodayHint: '失败或用户手动取消',

      // Compact Hardware
      hwMemory: '内存',
      hwDaemon: '守护进程',
      hwNormal: '正常',
      hwDown: '未运行',

      // Task Filter
      filterActive: '⚡ 活跃任务 (运行中/排队/暂停)',
      filterAll: '全部历史任务 (All Tasks)',
      filterRunning: '运行中 (running)',
      filterPausedQuota: '额度暂停 (paused_quota)',
      filterCompleted: '已完成 (completed)',
      filterFailed: '失败/取消 (failed)',
      filterQueued: '排队中 (queued)',
      filterRequirements: '📋 需求暂存草稿 (Requirements)',
      filterQueue: '⏳ 会话排队序列 (Queue Details)',
      filterAllProjects: '📁 全部项目',

      // Table Headers
      thTaskId: '任务 ID',
      thTopic: '主题 / 会话',
      thStatus: '状态',
      thActivity: '活跃度',
      thCreatedAt: '创建时间',
      thFinishedAt: '完成时间',
      thPr: 'PR 链接',
      thLogTail: '最新日志输出 (Tail)',

      // Actions
      actDetails: '详情',
      actLogs: '日志',
      actCancel: '取消',
      actResume: '续跑',
      actSwitchAccount: '换号',
      actRetry: '重试',
      actPauseSession: '挂起',
      actArchive: '归档',
      actCopyPrompt: '复制提示词',
      batchCancel: '批量取消',
      batchArchive: '批量归档',
      batchArchiveCleanWorktree: '批量归档 + 清理 Worktree',

      // Quota Strip
      quotaTitle: '账号池额度概览 (Quota Overview)',
      quotaSubtitle: '实时汇总本地 Cockpit 与 Profile 账号 5 小时窗口可用额度与重置时间。',
      quotaNormal: '正常',
      quotaExhausted: '额度耗尽',
      quotaReset: '重置',

      // Settings
      settingsTitle: '系统设置与环境管理',
      tabProjects: '📁 项目管理',
      tabRouting: '🎯 调度偏好与场景规则',
      tabAgents: '🤖 本地 Agent 注册',
      tabPool: '👥 agy 账号池管理',
      tabSystem: '💻 硬件诊断详细',
    },
  },
  en: {
    translation: {
      appName: 'Agent Bridge Cockpit',
      appSubtitle: 'Local AI Agent scenario router & execution environment',
      onlineStatus: 'Local daemon active',
      settings: 'Settings',
      save: 'Save Config',
      saveSuccess: 'Configuration saved and applied immediately!',
      refresh: 'Refresh',
      cancel: 'Cancel',
      confirm: 'Confirm',
      close: 'Close',
      status: 'Status',
      actions: 'Actions',
      viewAll: 'All',
      loading: 'Loading...',
      noData: 'No data available',
      copied: 'Copied to clipboard',

      // Overview Cards
      metricRunning: 'Running Tasks',
      metricRunningHint: 'Currently occupying agents',
      metricQueued: 'Queued',
      metricQueuedHint: 'Waiting for available channel',
      metricPaused: 'Quota Paused',
      metricPausedHint: 'Waiting for reset or switch',
      metricCompletedToday: 'Completed Today',
      metricCompletedTodayHint: 'PRs/Results delivered today',
      metricFailedToday: 'Failed Today',
      metricFailedTodayHint: 'Failed or cancelled today',

      // Compact Hardware
      hwMemory: 'Memory',
      hwDaemon: 'Daemon',
      hwNormal: 'Running',
      hwDown: 'Down',

      // Task Filter
      filterActive: '⚡ Active Tasks (Running / Queued / Paused)',
      filterAll: 'All Tasks History',
      filterRunning: 'Running',
      filterPausedQuota: 'Quota Paused (paused_quota)',
      filterCompleted: 'Completed',
      filterFailed: 'Failed / Cancelled',
      filterQueued: 'Queued',
      filterRequirements: '📋 Requirements Backlog',
      filterQueue: '⏳ Auto Queue Sessions',
      filterAllProjects: '📁 All Projects',

      // Table Headers
      thTaskId: 'Task ID',
      thTopic: 'Topic / Session',
      thStatus: 'Status',
      thActivity: 'Activity',
      thCreatedAt: 'Created At',
      thFinishedAt: 'Finished At',
      thPr: 'PR Link',
      thLogTail: 'Latest Log (Tail)',

      // Actions
      actDetails: 'Details',
      actLogs: 'Logs',
      actCancel: 'Cancel',
      actResume: 'Resume',
      actSwitchAccount: 'Switch Acc',
      actRetry: 'Retry',
      actPauseSession: 'Pause Queue',
      actArchive: 'Archive',
      actCopyPrompt: 'Copy Prompt',
      batchCancel: 'Batch Cancel',
      batchArchive: 'Batch Archive',
      batchArchiveCleanWorktree: 'Archive + Clean Worktree',

      // Quota Strip
      quotaTitle: '👥 Account Pool Quota Overview',
      quotaSubtitle: 'Real-time 5-hour rolling quota window and reset times from Cockpit and Profiles.',
      quotaNormal: 'Normal',
      quotaExhausted: 'Exhausted',
      quotaReset: 'Reset',

      // Settings
      settingsTitle: 'System Settings & Profiles',
      tabProjects: '📁 Projects',
      tabRouting: '🎯 Routing Rules',
      tabAgents: '🤖 Local Agents',
      tabPool: '👥 agy Account Pool',
      tabSystem: '💻 Hardware Diagnostics',
    },
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh',
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
