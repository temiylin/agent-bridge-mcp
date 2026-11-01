export type TaskStage =
  | 'needs_human/failed'
  | 'needs_human/quota'
  | 'needs_human/stalled'
  | 'needs_human/answer'
  | 'needs_human/review'
  | 'queued'
  | 'working'
  | 'done';

export type TaskOutcome = 'ready' | 'blocked' | 'failed' | 'dropped';

export interface TaskReport {
  outcome: TaskOutcome;
  pr_url: string | null;
  question: string | null;
  summary: string;
}

export interface SystemIssueItem {
  id: 'callback_failures' | 'pool_paused' | 'worker_offline';
  kind: 'callback' | 'pool' | 'worker';
  title: string;
  detail: string;
  consecutiveFailures: number;
}

export interface TaskItem {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'paused_quota' | 'queued' | string;
  stage?: TaskStage;
  outcome?: TaskOutcome;
  question?: string | null;
  report?: TaskReport;
  report_source?: 'report_json' | 'heuristic';
  hasFollowUp?: boolean;
  pr_open?: boolean;
  session_id?: string;
  project?: string;
  project_id?: string;
  project_name?: string;
  agent?: string;
  model?: string;
  account?: string;
  workDir?: string;
  elapsed?: string;
  last_activity_at?: string;
  created_at?: string;
  finished_at?: string;
  pr_url?: string;
  last_log_line?: string;
  state?: string;
  reason?: string;
}

export interface ProjectConfigItem {
  id: string;
  name: string;
  repo_path?: string;
  paths?: string[];
  path_valid?: boolean;
  path_error?: string;
  repo?: string;
  default_base_branch?: string;
  push_remote?: string;
  forbidden_remotes?: string[];
  worktree_root?: string;
  symlink_dirs?: string[];
  default_agent?: string;
  default_model?: string;
  default_account?: string;
  default_timeout_seconds?: number;
  callback_url?: string;
  callback_headers?: Record<string, string>;
  slack_webhook_env?: string;
  verify_pr?: {
    test_commands?: string[];
    timeout_seconds?: number;
  };
  merge_deploy?: {
    checkout_path?: string;
    target_branch?: string;
    remote?: string;
    services?: string[];
  };
  services?: Record<string, {
    name?: string;
    command: string;
    port?: number;
    health_url?: string;
    changed_paths?: string[];
  }>;
}

export interface CockpitAccount {
  accountId: string;
  email: string;
  name?: string;
  current: boolean;
  disabled?: boolean;
  provider: string;
  remainingFractionSummary?: number;
  resetTime?: string;
  lastUsed?: number;
  quotas?: Record<string, { remainingFraction?: number; resetTime?: string }>;
}

export interface QuotaBucketItem {
  bucketId: string;
  label: string;
  window: string;
  pct: number;
  reset_time?: string;
  disabled?: boolean;
}

export interface PoolAccountOverview {
  email: string;
  pools: string[];
  aliases: string[];
  cockpit_current: boolean;
  quota_remaining: string;
  paused_until: string;
  busy_task_id: string;
  running_task_count: number;
  reset_time?: string;
  pause_reason?: string;
  login_status?: string;
  quota_5h?: {
    fraction: number;
    pct: number;
    reset_time?: string;
  };
  quota_weekly?: {
    fraction: number;
    pct: number;
    reset_time?: string;
  };
  quota_buckets?: QuotaBucketItem[];
}

export interface ProfileItem {
  alias: string;
  home: string;
  email: string;
  enabled: boolean;
  max_concurrent: number;
  paused_until?: string;
  cockpit_account_id?: string;
  tasks_today: number;
  last_task_date?: string;
  login_synced_at?: string;
  login_label?: string;
}

export interface SystemStats {
  platform: string;
  arch: string;
  cpuModel: string;
  cores: number;
  totalMemGb: number;
  freeMemGb: string;
  workerPid: number | null;
  systemIssues?: SystemIssueItem[];
}

export interface RoutingRule {
  id: string;
  scenario: string;
  keywords: string[];
  agent: string;
  description: string;
}

export interface AgentConfig {
  command: string;
  args?: string[];
  input?: 'stdin' | 'arg';
}

export interface BridgeConfig {
  deviceToken: string;
  deviceUrl: string;
  agents: Record<string, AgentConfig>;
  routing: {
    defaultAgent: string;
    instructions: string;
    rules: RoutingRule[];
  };
}

export interface RequirementItem {
  id: string;
  title: string;
  project: string;
  topic?: string;
  tags?: string[];
  raw_text?: string;
  status: 'draft' | 'dispatched' | 'merged' | 'archived';
  created_at: string;
}

export interface QueueSession {
  session_id: string;
  paused: boolean;
  pause_reason?: string;
  items: Array<{
    id: string;
    task_id?: string;
    agent: string;
    model?: string;
    status: string;
    created_at: string;
  }>;
}
