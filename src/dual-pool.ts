/**
 * Dual account pool for agy.
 *
 * - DEFAULT pool: original behavior — machine default HOME, the single Cockpit
 *   "current" account, rotating via Cockpit switch among Cockpit accounts.
 * - CUSTOM pool: user-added isolated Profiles (agy-pool.json), one account per HOME.
 *
 * Accounts are shared by email across both pools: one quota/pause state per email
 * (account-state.json). Task claims are tracked per task in account-locks/ (reference
 * counts, not a single global mutex per email). Custom profiles honor max_concurrent;
 * the default pool is unlimited unless AGENT_BRIDGE_DEFAULT_POOL_MAX_CONCURRENT is set.
 * A Profile that is merely configured (idle) never blocks the default pool.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveBridgeRoot } from "./config.js";
import {
  loadPoolConfig,
  selectPoolAccount,
  isProfilePaused,
  detectProfileLoginStatus,
  getRunningTasksPerProfile,
  isProfileLoggedIn,
  type AgyPoolProfile,
} from "./account-pool.js";
import {
  listAccountsFromCockpitStorage,
  switchAgentAccount,
  type AgentAccountSummary,
} from "./account-manager.js";

export type PoolKind = "default" | "custom";

export interface AccountStateEntry {
  paused_until?: string;
  reason?: string;
  updated_at?: string;
}

export interface AccountLock {
  email: string;
  taskId: string;
  pid: number;
  pool: PoolKind;
  alias?: string;
  since: string;
}

/** Minimum Cockpit remaining fraction for an account to be considered usable. */
const MIN_QUOTA_FRACTION = 0.01;

export function normEmail(email?: string | null): string {
  return String(email || "").trim().toLowerCase();
}

function stateFile(rootDir: string): string {
  return path.join(rootDir, "account-state.json");
}

function locksDir(rootDir: string): string {
  return path.join(rootDir, "account-locks");
}

function lockEmailToken(email: string): string {
  const key = normEmail(email);
  return key ? key.replace(/[^a-z0-9@._-]+/g, "_") : "__default_home__";
}

/** Legacy single-lock path (pre-concurrency); still cleaned up on release. */
function legacyLockPath(rootDir: string, email: string): string {
  return path.join(locksDir(rootDir), `${lockEmailToken(email)}.json`);
}

function lockPathForTask(rootDir: string, email: string, taskId: string): string {
  const safeTask = String(taskId).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(locksDir(rootDir), `${lockEmailToken(email)}__${safeTask}.json`);
}

/** Max concurrent default-pool tasks; 0 = unlimited (unset or non-positive env). */
export function getDefaultPoolMaxConcurrent(): number {
  const raw = process.env.AGENT_BRIDGE_DEFAULT_POOL_MAX_CONCURRENT;
  if (raw === undefined || raw.trim() === "") return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function listLiveAccountLocks(rootDir: string): AccountLock[] {
  const dir = locksDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  const out: AccountLock[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const full = path.join(dir, f);
      const lock = JSON.parse(fs.readFileSync(full, "utf8")) as AccountLock;
      if (!pidAlive(lock.pid)) {
        fs.rmSync(full, { force: true });
        continue;
      }
      out.push(lock);
    } catch {}
  }
  return out;
}

export function countDefaultPoolRunning(rootDir: string, email?: string): number {
  const target = email ? normEmail(email) : "";
  return listLiveAccountLocks(rootDir).filter((l) => {
    if (l.pool !== "default") return false;
    if (!target) return true;
    return normEmail(l.email) === target || (!l.email && target === normEmail("__default_home__"));
  }).length;
}

export function getEmailRunningTaskCount(rootDir: string, email: string, profiles?: AgyPoolProfile[]): number {
  const key = normEmail(email);
  if (!key) return 0;
  const fromLocks = listLiveAccountLocks(rootDir).filter((l) => normEmail(l.email) === key).length;
  const list = profiles || loadPoolConfig(rootDir);
  const running = getRunningTasksPerProfile(rootDir);
  let fromProfiles = 0;
  for (const p of list) {
    if (normEmail(p.email) === key) {
      fromProfiles += (running.get(p.alias) || []).length;
    }
  }
  return Math.max(fromLocks, fromProfiles);
}

function settingsFile(rootDir: string): string {
  return path.join(rootDir, "agy-pool-settings.json");
}

/** Custom-pool master toggle (default: enabled). When disabled every task uses the default pool. */
export function isCustomPoolEnabled(rootDir: string = resolveBridgeRoot()): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(rootDir), "utf8"));
    return s?.custom_pool_enabled !== false;
  } catch {
    return true;
  }
}

export function setCustomPoolEnabled(rootDir: string, enabled: boolean): { success: true; custom_pool_enabled: boolean } {
  let s: any = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(rootDir), "utf8")) || {}; } catch {}
  s.custom_pool_enabled = !!enabled;
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(`${settingsFile(rootDir)}.tmp`, JSON.stringify(s, null, 2), "utf8");
  fs.renameSync(`${settingsFile(rootDir)}.tmp`, settingsFile(rootDir));
  return { success: true, custom_pool_enabled: !!enabled };
}

export function loadAccountState(rootDir: string = resolveBridgeRoot()): Record<string, AccountStateEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(rootDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveAccountState(rootDir: string, state: Record<string, AccountStateEntry>): void {
  fs.mkdirSync(rootDir, { recursive: true });
  const f = stateFile(rootDir);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(`${f}.tmp`, f);
}

/** Shared (cross-pool) pause for an email. */
export function pauseEmail(rootDir: string, email: string, until: string, reason?: string): void {
  const key = normEmail(email);
  if (!key) return;
  const st = loadAccountState(rootDir);
  st[key] = { paused_until: until, ...(reason ? { reason } : {}), updated_at: new Date().toISOString() };
  saveAccountState(rootDir, st);
}

export function resumeEmail(rootDir: string, email: string): void {
  const key = normEmail(email);
  const st = loadAccountState(rootDir);
  if (st[key]) {
    delete st[key];
    saveAccountState(rootDir, st);
  }
}

export function isEmailPaused(rootDir: string, email: string, now: number = Date.now()): string | undefined {
  const key = normEmail(email);
  if (!key) return undefined;
  const entry = loadAccountState(rootDir)[key];
  if (!entry?.paused_until) return undefined;
  const t = new Date(entry.paused_until).getTime();
  return !isNaN(t) && t > now ? entry.paused_until : undefined;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export function readAccountLock(rootDir: string, email: string): AccountLock | undefined {
  const key = normEmail(email);
  if (!key) return undefined;
  const locks = listLiveAccountLocks(rootDir).filter((l) => normEmail(l.email) === key);
  return locks[0];
}

/** First in-flight task id for an email, if any (for compact busy display). */
export function getEmailBusyTask(rootDir: string, email: string, profiles?: AgyPoolProfile[]): string | undefined {
  const key = normEmail(email);
  if (!key) return undefined;
  const lock = listLiveAccountLocks(rootDir).find((l) => normEmail(l.email) === key);
  if (lock) return lock.taskId;
  const list = profiles || loadPoolConfig(rootDir);
  const running = getRunningTasksPerProfile(rootDir);
  for (const p of list) {
    if (normEmail(p.email) === key) {
      const ids = running.get(p.alias) || [];
      if (ids.length > 0) return ids[0];
    }
  }
  return undefined;
}

/** Atomically claim a task slot (per-task lock file). */
export function acquireAccountLock(rootDir: string, lock: Omit<AccountLock, "since">): boolean {
  const key = normEmail(lock.email) || (lock.pool === "default" ? "__default_home__" : "");
  if (!key) return true;
  fs.mkdirSync(locksDir(rootDir), { recursive: true });
  listLiveAccountLocks(rootDir); // prune stale
  const p = lockPathForTask(rootDir, key, lock.taskId);
  try {
    fs.writeFileSync(
      p,
      JSON.stringify({ ...lock, email: normEmail(lock.email) || key, since: new Date().toISOString() }),
      { flag: "wx" }
    );
    return true;
  } catch {
    try {
      const cur = JSON.parse(fs.readFileSync(p, "utf8")) as AccountLock;
      return cur.taskId === lock.taskId && pidAlive(cur.pid);
    } catch {
      return false;
    }
  }
}

export function releaseAccountLock(rootDir: string, email: string | undefined, taskId: string): void {
  const token = normEmail(email) || "__default_home__";
  const p = lockPathForTask(rootDir, token, taskId);
  try {
    fs.rmSync(p, { force: true });
  } catch {}
  try {
    const legacy = legacyLockPath(rootDir, token);
    const cur = JSON.parse(fs.readFileSync(legacy, "utf8"));
    if (cur.taskId === taskId) fs.rmSync(legacy, { force: true });
  } catch {}
}

/** @deprecated Use countDefaultPoolRunning; kept for callers expecting a single busy task id. */
export function getDefaultPoolBusyTask(rootDir: string): string | undefined {
  const lock = listLiveAccountLocks(rootDir).find((l) => l.pool === "default");
  return lock?.taskId;
}

function safeCockpitAccounts(): AgentAccountSummary[] {
  try {
    return listAccountsFromCockpitStorage("antigravity");
  } catch {
    return [];
  }
}

export type AccountSelection =
  | { pool: "custom"; alias: string; home: string; email?: string; profile: AgyPoolProfile }
  | { pool: "default"; home: string; email?: string; cockpitAccountId?: string; needsSwitch: boolean; legacy: boolean }
  | { pool: "none"; reason: string; kind?: "busy" | "no_quota"; earliest_reset?: string };

export interface SelectOptions {
  session_id?: string;
  requestedAccount?: string;
  now?: number;
  /** Injected for tests; defaults to reading Cockpit local storage. */
  cockpitAccounts?: AgentAccountSummary[];
  defaultHome?: string;
}

/**
 * Pick an account across both pools (pure decision; no side effects).
 * Order: custom Profiles → default pool (Cockpit current, else best other Cockpit account) → none (queue).
 */
export function selectDualPoolAccount(rootDir: string, opts: SelectOptions = {}): AccountSelection {
  const now = opts.now ?? Date.now();
  const profiles = loadPoolConfig(rootDir);
  const cockpit = opts.cockpitAccounts ?? safeCockpitAccounts();
  const quotaByEmail = new Map(cockpit.map((c) => [normEmail(c.email), c.remainingFractionSummary ?? 1]));

  // 1. Custom pool
  if (profiles.length > 0 && isCustomPoolEnabled(rootDir)) {
    const pick = selectPoolAccount(rootDir, {
      session_id: opts.session_id,
      requestedAccount: opts.requestedAccount,
      now,
      cockpitQuota: quotaByEmail,
      isEmailBlocked: (email) =>
        !!isEmailPaused(rootDir, email, now) ||
        (quotaByEmail.has(normEmail(email)) && (quotaByEmail.get(normEmail(email)) ?? 1) < MIN_QUOTA_FRACTION),
    });
    if (pick) {
      const running = (getRunningTasksPerProfile(rootDir).get(pick.alias) || []).length;
      const maxC = pick.profile.max_concurrent || 1;
      if (running >= maxC) {
        return { pool: "none", kind: "busy", reason: `profile ${pick.alias} at max concurrent (${maxC})` };
      }
      return { pool: "custom", alias: pick.alias, home: pick.home, email: pick.profile.email, profile: pick.profile };
    }
    const runningMap = getRunningTasksPerProfile(rootDir);
    const customCandidates = profiles.filter(
      (p) =>
        p.enabled &&
        !isProfilePaused(p, now) &&
        isProfileLoggedIn(p) &&
        !(
          (p.email && isEmailPaused(rootDir, p.email, now)) ||
          (p.email &&
            quotaByEmail.has(normEmail(p.email)) &&
            (quotaByEmail.get(normEmail(p.email)) ?? 1) < MIN_QUOTA_FRACTION)
        )
    );
    if (
      customCandidates.length > 0 &&
      customCandidates.every((p) => (runningMap.get(p.alias) || []).length >= (p.max_concurrent || 1))
    ) {
      return { pool: "none", kind: "busy", reason: "all custom profiles at max concurrent" };
    }
  }

  // 2. Default pool (shared default HOME + Cockpit rotation; concurrent unless capped by env)
  const defaultHome = opts.defaultHome || process.env.HOME || os.homedir();
  const defMax = getDefaultPoolMaxConcurrent();
  const defRunning = countDefaultPoolRunning(rootDir);
  if (defMax > 0 && defRunning >= defMax) {
    return { pool: "none", kind: "busy", reason: `default pool at max concurrent (${defMax})` };
  }

  const usable = cockpit.filter((c) => !c.disabled && c.email);
  if (usable.length === 0) {
    // No Cockpit data: exact legacy behavior (default HOME, no rotation)
    return { pool: "default", home: defaultHome, needsSwitch: false, legacy: true };
  }
  const ok = (c: AgentAccountSummary) =>
    !isEmailPaused(rootDir, c.email, now) &&
    (c.remainingFractionSummary ?? 1) >= MIN_QUOTA_FRACTION;

  // Reuse a Cockpit account that already has default-pool runners (no switch; same HOME).
  const activeDefaultEmails = new Set(
    listLiveAccountLocks(rootDir)
      .filter((l) => l.pool === "default" && l.email)
      .map((l) => normEmail(l.email))
  );
  for (const activeEmail of activeDefaultEmails) {
    const match = usable.find((c) => normEmail(c.email) === activeEmail && ok(c));
    if (match) {
      return {
        pool: "default",
        home: defaultHome,
        email: match.email,
        cockpitAccountId: match.accountId,
        needsSwitch: false,
        legacy: false,
      };
    }
  }

  const current = usable.find((c) => c.current);
  const runningOnCurrent = current?.email ? countDefaultPoolRunning(rootDir, current.email) : 0;

  if (current && ok(current)) {
    return {
      pool: "default",
      home: defaultHome,
      email: current.email,
      cockpitAccountId: current.accountId,
      needsSwitch: false,
      legacy: false,
    };
  }

  if (runningOnCurrent > 0) {
    return {
      pool: "none",
      kind: "busy",
      reason: `Cockpit current account ${current?.email || "(unknown)"} has ${runningOnCurrent} running default-pool task(s); cannot rotate`,
    };
  }

  const others = usable.filter((c) => c !== current && ok(c)).sort((a, b) => (b.remainingFractionSummary ?? 1) - (a.remainingFractionSummary ?? 1));
  if (others.length > 0) {
    const c = others[0];
    return { pool: "default", home: defaultHome, email: c.email, cockpitAccountId: c.accountId, needsSwitch: true, legacy: false };
  }
  const anyProfileBusy = profiles.some((p) => {
    const running = (getRunningTasksPerProfile(rootDir).get(p.alias) || []).length;
    return running >= (p.max_concurrent || 1);
  });
  if (anyProfileBusy && defMax > 0 && defRunning >= defMax) {
    return { pool: "none", kind: "busy", reason: "all usable accounts are busy" };
  }
  const resets: number[] = [];
  for (const c of usable) {
    const pu = isEmailPaused(rootDir, c.email, now);
    if (pu) resets.push(new Date(pu).getTime());
    else if (c.resetTime) {
      const t = typeof c.resetTime === "number" ? c.resetTime : new Date(c.resetTime).getTime();
      if (!isNaN(t) && t > now) resets.push(t);
    }
  }
  const earliest = resets.length ? new Date(Math.min(...resets)).toISOString() : undefined;
  return {
    pool: "none",
    kind: "no_quota",
    reason: `all agy accounts are out of quota${earliest ? `; earliest reset ${earliest}` : ""}`,
    ...(earliest ? { earliest_reset: earliest } : {}),
  };
}

/**
 * Select + claim (lock, Cockpit switch if needed). Returns "none" when the caller should wait and retry.
 */
export async function acquireDualPoolAccount(
  rootDir: string,
  taskId: string,
  opts: SelectOptions & { logger?: (level: "ERROR" | "INFO" | "WARN", msg: string) => void; switchFn?: typeof switchAgentAccount } = {}
): Promise<AccountSelection> {
  const sel = selectDualPoolAccount(rootDir, opts);
  if (sel.pool === "none") return sel;
  const email = sel.email;
  const locked = acquireAccountLock(rootDir, {
    email: email || (sel.pool === "default" ? "__default_home__" : ""),
    taskId,
    pid: process.pid,
    pool: sel.pool,
    ...(sel.pool === "custom" ? { alias: sel.alias } : {}),
  });
  if (!locked) return { pool: "none", kind: "busy", reason: `account ${email} was just claimed by another task` };

  if (sel.pool === "default" && sel.needsSwitch && sel.cockpitAccountId) {
    const cockpit = opts.cockpitAccounts ?? safeCockpitAccounts();
    const current = cockpit.find((c) => c.current);
    if (current?.email && countDefaultPoolRunning(rootDir, current.email) > 0) {
      releaseAccountLock(rootDir, email, taskId);
      return {
        pool: "none",
        kind: "busy",
        reason: `Cockpit current account ${current.email} has running default-pool tasks; cannot rotate`,
      };
    }
    const sw = await (opts.switchFn || switchAgentAccount)({
      provider: "antigravity",
      targetEmailOrAccount: sel.cockpitAccountId,
    });
    if (!sw.success) {
      releaseAccountLock(rootDir, email, taskId);
      opts.logger?.("WARN", `Default pool: Cockpit switch to ${email} failed: ${sw.error}`);
      return { pool: "none", kind: "busy", reason: `cockpit switch to ${email} failed: ${sw.error}` };
    }
    opts.logger?.("INFO", `Default pool: switched Cockpit current account to ${email}`);
  }
  return sel;
}

export function releaseSelection(rootDir: string, sel: AccountSelection | undefined, taskId: string): void {
  if (!sel || sel.pool === "none") return;
  releaseAccountLock(rootDir, sel.email || (sel.pool === "default" ? "__default_home__" : ""), taskId);
}

export interface AccountOverviewRow {
  email: string;
  pools: PoolKind[];
  aliases: string[];
  cockpit_current: boolean;
  quota_remaining: string; // "0.85" | "unknown"
  reset_time?: string | number;
  paused_until: string; // ISO | "none"
  pause_reason?: string;
  busy_task_id: string; // taskId | "idle" (first task, compact)
  running_task_count: number;
  login_status?: string;
  quota_5h?: {
    fraction: number;
    pct: number;
    reset_time?: string | number;
  };
  quota_weekly?: {
    fraction: number;
    pct: number;
    reset_time?: string | number;
  };
}

/** One row per account email across both pools. */
export function queryAccountOverview(
  rootDir: string = resolveBridgeRoot(),
  cockpitAccounts?: AgentAccountSummary[]
): AccountOverviewRow[] {
  const now = Date.now();
  const profiles = loadPoolConfig(rootDir);
  const cockpit = cockpitAccounts ?? safeCockpitAccounts();
  const rows = new Map<string, AccountOverviewRow>();
  const row = (email: string): AccountOverviewRow => {
    const key = normEmail(email);
    let r = rows.get(key);
    if (!r) {
      r = {
        email: key,
        pools: [],
        aliases: [],
        cockpit_current: false,
        quota_remaining: "unknown",
        paused_until: "none",
        busy_task_id: "idle",
        running_task_count: 0,
      };
      rows.set(key, r);
    }
    return r;
  };
  for (const c of cockpit) {
    if (!c.email) continue;
    const r = row(c.email);
    if (!r.pools.includes("default")) r.pools.push("default");
    r.cockpit_current = r.cockpit_current || !!c.current;
    r.quota_remaining = (c.remainingFractionSummary ?? 1).toFixed(2);
    if (c.resetTime) r.reset_time = c.resetTime;

    // Split quotas into 5-hour rolling window vs multi-day / weekly window
    if (c.quotas && typeof c.quotas === "object") {
      let min5h = 1.0;
      let reset5h: string | number | undefined;
      let has5h = false;

      let minWeekly = 1.0;
      let resetWeekly: string | number | undefined;
      let hasWeekly = false;

      for (const [mName, q] of Object.entries(c.quotas)) {
        if (!q || !q.resetTime) continue;
        const resetMs = typeof q.resetTime === "number" ? q.resetTime : new Date(q.resetTime).getTime();
        if (isNaN(resetMs)) continue;
        const diffHours = (resetMs - now) / (3600 * 1000);
        const frac = typeof q.remainingFraction === "number" ? q.remainingFraction : 1.0;

        // Models with longer reset cycles (e.g. gemini-4-argon or resets > 14 hours)
        if (mName.includes("argon") || diffHours > 14) {
          hasWeekly = true;
          if (frac < minWeekly) minWeekly = frac;
          if (!resetWeekly || resetMs < (typeof resetWeekly === "number" ? resetWeekly : new Date(resetWeekly).getTime())) {
            resetWeekly = q.resetTime;
          }
        }

        // Standard rolling models (e.g. Gemini 2.5 / 3.x, or resets <= 14 hours)
        if (!mName.includes("argon") && (diffHours <= 14 || mName.startsWith("gemini-") || mName.startsWith("claude-"))) {
          has5h = true;
          if (frac < min5h) min5h = frac;
          if (!reset5h || resetMs < (typeof reset5h === "number" ? reset5h : new Date(reset5h).getTime())) {
            reset5h = q.resetTime;
          }
        }
      }

      // Important: If weekly quota is depleted or lower, 5-hour quota is capped by weekly quota!
      // An account cannot have a "full" usable quota if its weekly quota is exhausted.
      if (hasWeekly && minWeekly < min5h) {
        min5h = minWeekly;
        if (!reset5h || (resetWeekly && new Date(resetWeekly).getTime() > new Date(reset5h).getTime())) {
          reset5h = resetWeekly;
        }
      }

      // Also ensure min5h is bounded by cockpit's remainingFractionSummary
      if (typeof c.remainingFractionSummary === "number" && c.remainingFractionSummary < min5h) {
        min5h = c.remainingFractionSummary;
      }

      if (has5h) {
        r.quota_5h = {
          fraction: min5h,
          pct: Math.max(0, Math.min(100, Math.round(min5h * 100))),
          reset_time: reset5h,
        };
      }
      if (hasWeekly) {
        r.quota_weekly = {
          fraction: minWeekly,
          pct: Math.max(0, Math.min(100, Math.round(minWeekly * 100))),
          reset_time: resetWeekly,
        };
      }
    }
  }
  for (const p of profiles) {
    if (!p.email) continue;
    const r = row(p.email);
    if (!r.pools.includes("custom")) r.pools.push("custom");
    r.aliases.push(p.alias);
    r.login_status = detectProfileLoginStatus(p).status;
    if (isProfilePaused(p, now) && p.paused_until && r.paused_until === "none") {
      r.paused_until = p.paused_until;
      r.pause_reason = p.enabled ? "profile paused" : "profile disabled";
    }
  }
  const state = loadAccountState(rootDir);
  for (const r of rows.values()) {
    const until = isEmailPaused(rootDir, r.email, now);
    if (until) {
      r.paused_until = until;
      r.pause_reason = state[r.email]?.reason || "quota";
    }
    const count = getEmailRunningTaskCount(rootDir, r.email, profiles);
    r.running_task_count = count;
    r.busy_task_id = count > 0 ? getEmailBusyTask(rootDir, r.email, profiles) || "idle" : "idle";
  }
  return [...rows.values()];
}
