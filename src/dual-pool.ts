/**
 * Dual account pool for agy.
 *
 * - DEFAULT pool: original behavior — machine default HOME, the single Cockpit
 *   "current" account, rotating via Cockpit switch among Cockpit accounts.
 * - CUSTOM pool: user-added isolated Profiles (agy-pool.json), one account per HOME.
 *
 * Accounts are shared by email across both pools: one quota/pause state per email
 * (account-state.json) and at most one running task per email (account-locks/).
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

function lockPath(rootDir: string, email: string): string {
  const safe = normEmail(email).replace(/[^a-z0-9@._-]+/g, "_");
  return path.join(locksDir(rootDir), `${safe}.json`);
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
  const p = lockPath(rootDir, email);
  try {
    const lock = JSON.parse(fs.readFileSync(p, "utf8")) as AccountLock;
    if (!pidAlive(lock.pid)) {
      fs.rmSync(p, { force: true });
      return undefined;
    }
    return lock;
  } catch {
    return undefined;
  }
}

/** Busy = held by a live lock, or a running task status on a profile bound to this email. */
export function getEmailBusyTask(rootDir: string, email: string, profiles?: AgyPoolProfile[]): string | undefined {
  const key = normEmail(email);
  if (!key) return undefined;
  const lock = readAccountLock(rootDir, key);
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

/** Atomically claim an email for a task. Returns false if someone else holds it. */
export function acquireAccountLock(rootDir: string, lock: Omit<AccountLock, "since">): boolean {
  const key = normEmail(lock.email);
  if (!key) return true;
  fs.mkdirSync(locksDir(rootDir), { recursive: true });
  const p = lockPath(rootDir, key);
  readAccountLock(rootDir, key); // clears stale lock
  try {
    fs.writeFileSync(p, JSON.stringify({ ...lock, email: key, since: new Date().toISOString() }), { flag: "wx" });
    return true;
  } catch {
    const cur = readAccountLock(rootDir, key);
    return !!cur && cur.taskId === lock.taskId;
  }
}

export function releaseAccountLock(rootDir: string, email: string | undefined, taskId: string): void {
  const key = normEmail(email);
  if (!key) return;
  const p = lockPath(rootDir, key);
  try {
    const cur = JSON.parse(fs.readFileSync(p, "utf8"));
    if (cur.taskId === taskId) fs.rmSync(p, { force: true });
  } catch {}
}

/** True if any default-pool task currently holds a lock (default HOME is single-account). */
export function getDefaultPoolBusyTask(rootDir: string): string | undefined {
  const dir = locksDir(rootDir);
  if (!fs.existsSync(dir)) return undefined;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AccountLock;
      if (lock.pool === "default" && pidAlive(lock.pid)) return lock.taskId;
    } catch {}
  }
  return undefined;
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
      isEmailBusy: (email) => !!getEmailBusyTask(rootDir, email, profiles),
      isEmailBlocked: (email) =>
        !!isEmailPaused(rootDir, email, now) ||
        (quotaByEmail.has(normEmail(email)) && (quotaByEmail.get(normEmail(email)) ?? 1) < MIN_QUOTA_FRACTION),
    });
    if (pick) return { pool: "custom", alias: pick.alias, home: pick.home, email: pick.profile.email, profile: pick.profile };
  }

  // 2. Default pool (single default HOME — only one default task at a time since a switch would affect it)
  const defaultHome = opts.defaultHome || process.env.HOME || os.homedir();
  const defBusy = getDefaultPoolBusyTask(rootDir);
  if (defBusy) return { pool: "none", kind: "busy", reason: `default pool busy with ${defBusy}; no custom profile available` };

  const usable = cockpit.filter((c) => !c.disabled && c.email);
  if (usable.length === 0) {
    // No Cockpit data: exact legacy behavior (default HOME, no rotation)
    return { pool: "default", home: defaultHome, needsSwitch: false, legacy: true };
  }
  const ok = (c: AgentAccountSummary) =>
    !isEmailPaused(rootDir, c.email, now) &&
    !getEmailBusyTask(rootDir, c.email, profiles) &&
    (c.remainingFractionSummary ?? 1) >= MIN_QUOTA_FRACTION;

  const current = usable.find((c) => c.current);
  if (current && ok(current)) {
    return { pool: "default", home: defaultHome, email: current.email, cockpitAccountId: current.accountId, needsSwitch: false, legacy: false };
  }
  const others = usable.filter((c) => c !== current && ok(c)).sort((a, b) => (b.remainingFractionSummary ?? 1) - (a.remainingFractionSummary ?? 1));
  if (others.length > 0) {
    const c = others[0];
    return { pool: "default", home: defaultHome, email: c.email, cockpitAccountId: c.accountId, needsSwitch: true, legacy: false };
  }
  // Distinguish "someone is busy" (wait) from "every account is exhausted" (tell the caller).
  const anyBusy = usable.some((c) => !!getEmailBusyTask(rootDir, c.email, profiles)) ||
    profiles.some((p) => p.email && !!getEmailBusyTask(rootDir, p.email, profiles));
  if (anyBusy) return { pool: "none", kind: "busy", reason: "all usable accounts are busy" };
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
  busy_task_id: string; // taskId | "idle"
  login_status?: string;
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
      r = { email: key, pools: [], aliases: [], cockpit_current: false, quota_remaining: "unknown", paused_until: "none", busy_task_id: "idle" };
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
    r.busy_task_id = getEmailBusyTask(rootDir, r.email, profiles) || "idle";
  }
  return [...rows.values()];
}
