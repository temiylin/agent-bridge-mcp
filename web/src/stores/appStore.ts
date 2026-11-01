import { create } from 'zustand';
import type {
  TaskItem,
  BridgeConfig,
  SystemStats,
  PoolAccountOverview,
  CockpitAccount,
  ProfileItem,
  RequirementItem,
  QueueSession,
} from '../types';

interface AppStore {
  // Config
  config: BridgeConfig | null;
  loadConfig: () => Promise<void>;
  saveConfig: (cfg: Partial<BridgeConfig>) => Promise<boolean>;

  // System Stats
  systemStats: SystemStats | null;
  loadSystemStats: () => Promise<void>;

  // Tasks
  tasks: TaskItem[];
  allTasks: TaskItem[];
  filterStatus: string;
  setFilterStatus: (st: string) => void;
  selectedTaskIds: Set<string>;
  toggleSelectTask: (tid: string) => void;
  toggleSelectAllTasks: (all: boolean) => void;
  clearSelectedTasks: () => void;
  loadTasks: () => Promise<void>;
  cancelTask: (taskId: string) => Promise<boolean>;
  archiveTask: (taskId: string, cleanWorktree?: boolean) => Promise<boolean>;
  batchCancelTasks: () => Promise<void>;
  batchArchiveTasks: (cleanWorktree: boolean) => Promise<void>;

  // Pool
  poolAccounts: PoolAccountOverview[];
  cockpitAccounts: CockpitAccount[];
  profiles: ProfileItem[];
  customPoolEnabled: boolean;
  loadPool: () => Promise<void>;
  toggleCustomPool: (enabled: boolean) => Promise<void>;
  switchCockpit: (accountId: string) => Promise<void>;
  syncAuth: (alias: string) => Promise<void>;

  // Requirements & Queue
  requirements: RequirementItem[];
  loadRequirements: () => Promise<void>;
  queues: QueueSession[];
  loadQueues: () => Promise<void>;

  // UI state
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  toast: string | null;
  showToast: (msg: string) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  config: null,
  systemStats: null,
  tasks: [],
  allTasks: [],
  filterStatus: 'active',
  selectedTaskIds: new Set(),
  poolAccounts: [],
  cockpitAccounts: [],
  profiles: [],
  customPoolEnabled: true,
  requirements: [],
  queues: [],
  settingsOpen: false,
  toast: null,

  showToast: (msg: string) => {
    set({ toast: msg });
    setTimeout(() => {
      if (get().toast === msg) set({ toast: null });
    }, 2800);
  },

  setSettingsOpen: (open: boolean) => set({ settingsOpen: open }),

  setFilterStatus: (st: string) => {
    set({ filterStatus: st });
    get().loadTasks();
  },

  toggleSelectTask: (tid: string) => {
    const s = new Set(get().selectedTaskIds);
    if (s.has(tid)) s.delete(tid);
    else s.add(tid);
    set({ selectedTaskIds: s });
  },

  toggleSelectAllTasks: (all: boolean) => {
    if (all) {
      set({ selectedTaskIds: new Set(get().tasks.map((t) => t.taskId)) });
    } else {
      set({ selectedTaskIds: new Set() });
    }
  },

  clearSelectedTasks: () => set({ selectedTaskIds: new Set() }),

  loadConfig: async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        set({ config: data });
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  },

  saveConfig: async (partial: Partial<BridgeConfig>) => {
    try {
      const current = get().config;
      if (!current) return false;
      const body = {
        agents: partial.agents || current.agents,
        routing: partial.routing || current.routing,
      };
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        get().showToast('配置保存成功！');
        get().loadConfig();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  loadSystemStats: async () => {
    try {
      const res = await fetch('/api/system');
      if (res.ok) {
        const data = await res.json();
        set({ systemStats: data });
      }
    } catch {}
  },

  loadTasks: async () => {
    const filter = get().filterStatus;
    if (filter === 'requirements') {
      get().loadRequirements();
      return;
    }
    if (filter === 'queue') {
      get().loadQueues();
      return;
    }

    try {
      const res = await fetch('/api/recent-tasks');
      if (res.ok) {
        const data = await res.json();
        const all: TaskItem[] = data.tasks || [];
        set({ allTasks: all });

        if (filter === 'active') {
          const activeTasks = all.filter(
            (t) =>
              t.status === 'running' ||
              t.status === 'queued' ||
              t.status === 'paused' ||
              t.status === 'paused_quota'
          );
          set({ tasks: activeTasks });
        } else if (filter === 'all') {
          set({ tasks: all });
        } else {
          set({ tasks: all.filter((t) => t.status === filter) });
        }
      }
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  },

  cancelTask: async (taskId: string) => {
    try {
      const res = await fetch('/api/recent-tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      const data = await res.json();
      if (data.success) {
        get().showToast(`任务 ${taskId} 已取消`);
        get().loadTasks();
        return true;
      }
    } catch {}
    return false;
  },

  archiveTask: async (taskId: string, cleanWorktree = false) => {
    try {
      const res = await fetch('/api/recent-tasks/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: [taskId], cleanWorktree }),
      });
      const data = await res.json();
      if (data.success) {
        get().showToast(data.message || '任务已归档');
        const s = new Set(get().selectedTaskIds);
        s.delete(taskId);
        set({ selectedTaskIds: s });
        get().loadTasks();
        return true;
      }
    } catch {}
    return false;
  },

  batchCancelTasks: async () => {
    const ids = Array.from(get().selectedTaskIds);
    if (ids.length === 0) return;
    for (const tid of ids) {
      await fetch('/api/recent-tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: tid }),
      });
    }
    get().showToast(`已批量取消 ${ids.length} 条任务`);
    get().clearSelectedTasks();
    get().loadTasks();
  },

  batchArchiveTasks: async (cleanWorktree: boolean) => {
    const ids = Array.from(get().selectedTaskIds);
    if (ids.length === 0) return;
    const res = await fetch('/api/recent-tasks/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: ids, cleanWorktree }),
    });
    const d = await res.json();
    get().showToast(d.message || '批量归档成功');
    get().clearSelectedTasks();
    get().loadTasks();
  },

  loadPool: async () => {
    try {
      const res = await fetch('/api/pool');
      if (res.ok) {
        const data = await res.json();
        set({
          poolAccounts: data.accounts || [],
          cockpitAccounts: data.cockpitAccounts || [],
          profiles: data.profiles || [],
          customPoolEnabled: data.custom_pool_enabled !== false,
        });
      }
    } catch (e) {
      console.error('Failed to load pool:', e);
    }
  },

  toggleCustomPool: async (enabled: boolean) => {
    await fetch('/api/pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_custom_enabled', enabled }),
    });
    get().loadPool();
  },

  switchCockpit: async (accountId: string) => {
    const res = await fetch('/api/pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'switch_cockpit', account: accountId }),
    });
    const d = await res.json();
    if (d.success) {
      get().showToast(`已切换当前主账号: ${d.email || accountId}`);
      get().loadPool();
    }
  },

  syncAuth: async (alias: string) => {
    const res = await fetch('/api/pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync_auth', alias }),
    });
    const d = await res.json();
    if (d.success) {
      get().showToast(`${alias} 同步成功 (${d.login_label || '已登录'})`);
      get().loadPool();
    }
  },

  loadRequirements: async () => {
    try {
      const res = await fetch('/api/requirements');
      if (res.ok) {
        const data = await res.json();
        set({ requirements: data.requirements || [] });
      }
    } catch {}
  },

  loadQueues: async () => {
    try {
      const res = await fetch('/api/queue');
      if (res.ok) {
        const data = await res.json();
        set({ queues: data.queues || [] });
      }
    } catch {}
  },
}));
