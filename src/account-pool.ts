import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveBridgeRoot } from "./config.js";
import { resolveSafePath } from "./validator.js";
import { listAccountsFromCockpitStorage } from "./account-manager.js";
import { getSessionAccount, recordSessionAccount } from "./sessions.js";

export interface AgyPoolProfile {
  alias: string;
  home: string;
  email?: string;
  enabled: boolean;
  max_concurrent: number; // default 1
  paused_until?: string; // ISO timestamp
  cockpit_account_id?: string;
  tasks_today?: number;
  last_task_date?: string; // YYYY-MM-DD
}

export interface PoolStatusLine {
  alias: string;
  email: string;
  enabled: boolean;
  busy_task_id: string; // taskId or "idle"
  paused_until: string; // ISO string or "none"
  tasks_today: number;
  cockpit_remaining: string; // e.g. "0.98" or "1.00" or "unknown"
}

export function getPoolConfigFile(rootDir: string = resolveBridgeRoot()): string {
  return path.join(rootDir, "agy-pool.json");
}

export function getProfilesBaseDir(rootDir: string = resolveBridgeRoot()): string {
  return path.join(rootDir, "agy-profiles");
}

/**
 * Loads the agy account pool configuration.
 * Returns empty array if file is missing or invalid.
 */
export function loadPoolConfig(rootDir: string = resolveBridgeRoot()): AgyPoolProfile[] {
  const configFile = getPoolConfigFile(rootDir);
  if (!fs.existsSync(configFile)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((p) => ({
        alias: String(p.alias || "").trim(),
        home: String(p.home || "").trim(),
        email: p.email ? String(p.email).trim() : undefined,
        enabled: p.enabled !== false,
        max_concurrent: typeof p.max_concurrent === "number" && p.max_concurrent > 0 ? p.max_concurrent : 1,
        paused_until: p.paused_until ? String(p.paused_until) : undefined,
        cockpit_account_id: p.cockpit_account_id ? String(p.cockpit_account_id) : undefined,
        tasks_today: typeof p.tasks_today === "number" ? p.tasks_today : 0,
        last_task_date: p.last_task_date ? String(p.last_task_date) : undefined,
      })).filter((p) => p.alias && p.home);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Saves the agy account pool configuration atomically.
 */
export function savePoolConfig(rootDir: string, profiles: AgyPoolProfile[]): void {
  const configFile = getPoolConfigFile(rootDir);
  const tmpFile = `${configFile}.tmp`;
  const dir = path.dirname(configFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tmpFile, JSON.stringify(profiles, null, 2), "utf8");
  fs.renameSync(tmpFile, configFile);
}

/**
 * Validates profile alias name (letters, numbers, hyphens, underscores).
 * Never allows email format or path traversal as alias.
 */
export function isValidAlias(alias: unknown): alias is string {
  if (typeof alias !== "string" || !alias.trim()) return false;
  return /^[a-zA-Z0-9_-]+$/.test(alias.trim()) && !alias.includes("@");
}

/**
 * Sanitize an email local-part into a stable alias candidate.
 * e.g. "jianjianlin380@gmail.com" -> "jianjianlin380"
 */
export function sanitizeEmailLocalPart(email: string): string {
  const local = String(email || "").trim().split("@")[0] || "";
  let cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  if (!cleaned) cleaned = "profile";
  // Cap length to keep HOME paths readable
  if (cleaned.length > 48) cleaned = cleaned.slice(0, 48).replace(/[_-]+$/g, "") || "profile";
  return cleaned;
}

/**
 * Derive a unique, stable alias from an email address.
 * Uses the sanitized local-part; appends -2, -3, ... on alias collision.
 */
export function deriveUniqueAlias(
  email: string,
  existingAliases: Iterable<string>
): string {
  const taken = new Set(
    [...existingAliases].map((a) => String(a || "").trim().toLowerCase()).filter(Boolean)
  );
  const base = sanitizeEmailLocalPart(email);
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Checks whether a profile is currently paused.
 */
export function isProfilePaused(profile: AgyPoolProfile, now: number = Date.now()): boolean {
  if (!profile.enabled) return true;
  if (!profile.paused_until) return false;
  const pausedTime = new Date(profile.paused_until).getTime();
  if (isNaN(pausedTime)) return false;
  return pausedTime > now;
}

/**
 * Scans status/ directory to get in-flight task IDs per profile alias.
 */
export function getRunningTasksPerProfile(rootDir: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const statusDir = path.join(rootDir, "status");
  if (!fs.existsSync(statusDir)) return map;

  try {
    const files = fs.readdirSync(statusDir);
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      try {
        const raw = fs.readFileSync(path.join(statusDir, f), "utf8");
        const st = JSON.parse(raw);
        if (st && st.state === "running" && st.account) {
          const alias = String(st.account).trim();
          const list = map.get(alias) || [];
          const tid = st.taskId || f.replace(/\.json$/, "");
          list.push(tid);
          map.set(alias, list);
        }
      } catch {}
    }
  } catch {}

  return map;
}

/**
 * Initializes a new profile directory with safe symlinks and non-secret config copies.
 * Enforces one-account-one-dir invariant.
 */
export function initPoolProfile(
  rootDir: string,
  params: { alias?: string; email?: string; cockpit_account_id?: string }
): { success: boolean; profile?: AgyPoolProfile; loginCommand?: string; error?: string } {
  const emailRaw = params.email ? String(params.email).trim() : "";
  const email = emailRaw ? emailRaw.toLowerCase() : undefined;
  if (email && !email.includes("@")) {
    return {
      success: false,
      error: `Invalid email address "${params.email}".`,
    };
  }

  const profiles = loadPoolConfig(rootDir);

  // Invariant: One account must never be used in two profile dirs at once.
  if (email) {
    const duplicate = profiles.find((p) => p.email && p.email.toLowerCase() === email);
    if (duplicate) {
      return {
        success: false,
        error: `Cannot bind account "${email}": it is already bound to profile "${duplicate.alias}". One account cannot be used in two profile dirs at once.`,
      };
    }
  }

  let alias = params.alias ? String(params.alias).trim() : "";
  if (!alias) {
    if (!email) {
      return {
        success: false,
        error: "Either alias or email is required to initialize a profile.",
      };
    }
    alias = deriveUniqueAlias(
      email,
      profiles.map((p) => p.alias)
    );
  }

  if (!isValidAlias(alias)) {
    return {
      success: false,
      error: `Invalid profile alias "${alias}". Alias must only contain alphanumeric characters, hyphens, or underscores (no emails, no slashes).`,
    };
  }

  // Alias / HOME collision: never overwrite an existing profile slot
  const existingByAlias = profiles.find((p) => p.alias === alias);
  if (existingByAlias) {
    return {
      success: false,
      error: `Alias "${alias}" already exists (HOME=${existingByAlias.home}). Choose a different alias or remove the existing profile first.`,
    };
  }

  // Profile directory under agy-profiles/<alias>
  const baseDir = getProfilesBaseDir(rootDir);
  const profileDir = path.join(baseDir, alias);

  if (fs.existsSync(profileDir)) {
    // Orphan HOME dir without a pool entry still counts as a collision
    return {
      success: false,
      error: `HOME directory already exists at "${profileDir}". Remove it or pick a different alias.`,
    };
  }

  try {
    fs.mkdirSync(profileDir, { recursive: true });

    // Symlink safe developer configs from user's real home
    const realHome = os.homedir();
    const safeSharedConfigs = [".gitconfig", ".ssh", path.join(".config", "gh"), ".npmrc"];

    for (const relPath of safeSharedConfigs) {
      const src = path.join(realHome, relPath);
      const dst = path.join(profileDir, relPath);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try {
          const parent = path.dirname(dst);
          if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
          fs.symlinkSync(src, dst);
        } catch {}
      }
    }

    // Copy (not symlink) .gemini/settings.json and MCP config if present — NEVER copy credentials / cockpit tokens
    const realGemini = path.join(realHome, ".gemini");
    const profileGemini = path.join(profileDir, ".gemini");
    if (fs.existsSync(realGemini)) {
      if (!fs.existsSync(profileGemini)) fs.mkdirSync(profileGemini, { recursive: true });
      const settingsSrc = path.join(realGemini, "settings.json");
      const settingsDst = path.join(profileGemini, "settings.json");
      if (fs.existsSync(settingsSrc) && !fs.existsSync(settingsDst)) {
        try {
          fs.copyFileSync(settingsSrc, settingsDst);
        } catch {}
      }

      // MCP configs
      const mcpSrc = path.join(realGemini, "antigravity-cli", "mcp");
      const mcpDst = path.join(profileGemini, "antigravity-cli", "mcp");
      if (fs.existsSync(mcpSrc) && !fs.existsSync(mcpDst)) {
        try {
          fs.cpSync(mcpSrc, mcpDst, { recursive: true });
        } catch {}
      }
    }

    const cockpitId = params.cockpit_account_id
      ? String(params.cockpit_account_id).trim()
      : undefined;

    const profile: AgyPoolProfile = {
      alias,
      home: profileDir,
      ...(email ? { email } : {}),
      ...(cockpitId ? { cockpit_account_id: cockpitId } : {}),
      enabled: true,
      max_concurrent: 1,
    };
    profiles.push(profile);

    savePoolConfig(rootDir, profiles);

    const loginCommand = `HOME=${profileDir} agy`;

    return {
      success: true,
      profile,
      loginCommand,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to initialize profile directory: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Pauses a pool profile until an optional timestamp.
 */
export function pausePoolProfile(
  rootDir: string,
  alias: string,
  until?: string | number
): { success: boolean; error?: string } {
  const profiles = loadPoolConfig(rootDir);
  const target = profiles.find((p) => p.alias === alias);
  if (!target) {
    return { success: false, error: `Profile "${alias}" not found in account pool.` };
  }

  let pausedUntilStr: string | undefined;
  if (typeof until === "number") {
    pausedUntilStr = new Date(Date.now() + until * 1000).toISOString();
  } else if (typeof until === "string" && until.trim()) {
    const d = new Date(until.trim());
    if (!isNaN(d.getTime())) {
      pausedUntilStr = d.toISOString();
    } else {
      pausedUntilStr = until.trim();
    }
  } else {
    // Indefinite pause
    pausedUntilStr = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  }

  target.enabled = false;
  target.paused_until = pausedUntilStr;
  savePoolConfig(rootDir, profiles);
  return { success: true };
}

/**
 * Resumes a paused profile.
 */
export function resumePoolProfile(
  rootDir: string,
  alias: string
): { success: boolean; error?: string } {
  const profiles = loadPoolConfig(rootDir);
  const target = profiles.find((p) => p.alias === alias);
  if (!target) {
    return { success: false, error: `Profile "${alias}" not found in account pool.` };
  }

  target.enabled = true;
  delete target.paused_until;
  savePoolConfig(rootDir, profiles);
  return { success: true };
}

/**
 * Binds an email address to a profile alias.
 * Enforces one-account-one-dir invariant.
 */
export function bindProfileEmail(
  rootDir: string,
  alias: string,
  email: string
): { success: boolean; error?: string } {
  const cleanEmail = (email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    return { success: false, error: `Invalid email address "${email}".` };
  }

  const profiles = loadPoolConfig(rootDir);
  const target = profiles.find((p) => p.alias === alias);
  if (!target) {
    return { success: false, error: `Profile "${alias}" not found in account pool.` };
  }

  const duplicate = profiles.find((p) => p.email && p.email.toLowerCase() === cleanEmail && p.alias !== alias);
  if (duplicate) {
    return {
      success: false,
      error: `Email "${cleanEmail}" is already bound to profile "${duplicate.alias}". One account cannot be used in two profile dirs at once.`,
    };
  }

  target.email = cleanEmail;
  savePoolConfig(rootDir, profiles);
  return { success: true };
}

/**
 * Selects an account profile for a task.
 * Respects:
 * 1. Empty pool => undefined (legacy fallback to process HOME)
 * 2. Explicit requested account alias
 * 3. Session affinity (same session_id always routes to same profile)
 * 4. Auto selection: not paused, running count < max_concurrent, prefer highest Cockpit quota & idle
 */
export function selectPoolAccount(
  rootDir: string,
  options?: {
    session_id?: string;
    requestedAccount?: string;
    now?: number;
  }
): { alias: string; home: string; profile: AgyPoolProfile } | undefined {
  const profiles = loadPoolConfig(rootDir);
  if (profiles.length === 0) {
    // Missing/empty pool => exact current behavior (default process HOME)
    return undefined;
  }

  const now = options?.now ?? Date.now();
  const runningMap = getRunningTasksPerProfile(rootDir);

  // 1. Explicit requested account
  const req = options?.requestedAccount?.trim();
  if (req && req !== "auto") {
    const matched = profiles.find((p) => p.alias === req);
    if (matched) {
      return { alias: matched.alias, home: matched.home, profile: matched };
    }
  }

  // 2. Session stickiness (same session_id always reuses same profile)
  if (options?.session_id) {
    const boundAlias = getSessionAccount(rootDir, options.session_id);
    if (boundAlias) {
      const boundProfile = profiles.find((p) => p.alias === boundAlias);
      if (boundProfile) {
        return { alias: boundProfile.alias, home: boundProfile.home, profile: boundProfile };
      }
    }
  }

  // 3. Auto selection
  // Filter eligible profiles
  const eligible = profiles.filter((p) => {
    if (!p.enabled) return false;
    if (isProfilePaused(p, now)) return false;
    const runningCount = (runningMap.get(p.alias) || []).length;
    if (runningCount >= (p.max_concurrent || 1)) return false;
    return true;
  });

  if (eligible.length === 0) {
    // All busy or paused; return undefined or first enabled for queueing
    return undefined;
  }

  // Invariant check: skip accounts whose email is currently running on another profile
  const busyEmails = new Set<string>();
  for (const [busyAlias, taskIds] of runningMap.entries()) {
    if (taskIds.length > 0) {
      const bp = profiles.find((p) => p.alias === busyAlias);
      if (bp?.email) busyEmails.add(bp.email.toLowerCase());
    }
  }

  const conflictFree = eligible.filter((p) => {
    if (p.email && busyEmails.has(p.email.toLowerCase())) {
      const myRunning = (runningMap.get(p.alias) || []).length;
      return myRunning === 0; // only skip if conflict with another profile
    }
    return true;
  });

  const poolCandidates = conflictFree.length > 0 ? conflictFree : eligible;

  // Retrieve Cockpit quotas for sorting by remaining quota
  let cockpitMap = new Map<string, number>();
  try {
    const cockpitAccounts = listAccountsFromCockpitStorage("antigravity");
    for (const ca of cockpitAccounts) {
      if (ca.email) {
        cockpitMap.set(ca.email.toLowerCase(), ca.remainingFractionSummary ?? 1.0);
      }
    }
  } catch {}

  // Sort candidates:
  // 1. Cockpit quota remaining (higher is better)
  // 2. Running count (lower is better)
  // 3. Tasks today (lower is better)
  poolCandidates.sort((a, b) => {
    const qA = a.email ? (cockpitMap.get(a.email.toLowerCase()) ?? 1.0) : 1.0;
    const qB = b.email ? (cockpitMap.get(b.email.toLowerCase()) ?? 1.0) : 1.0;
    if (qB !== qA) return qB - qA;

    const runA = (runningMap.get(a.alias) || []).length;
    const runB = (runningMap.get(b.alias) || []).length;
    if (runA !== runB) return runA - runB;

    const tA = a.tasks_today || 0;
    const tB = b.tasks_today || 0;
    return tA - tB;
  });

  const chosen = poolCandidates[0];
  return { alias: chosen.alias, home: chosen.home, profile: chosen };
}

/**
 * Records task start under profile, updates task count and session binding.
 */
export function recordTaskStartUnderProfile(
  rootDir: string,
  alias: string,
  taskId: string,
  sessionId?: string
): void {
  const profiles = loadPoolConfig(rootDir);
  const p = profiles.find((item) => item.alias === alias);
  if (p) {
    const today = new Date().toISOString().slice(0, 10);
    if (p.last_task_date !== today) {
      p.last_task_date = today;
      p.tasks_today = 1;
    } else {
      p.tasks_today = (p.tasks_today || 0) + 1;
    }
    savePoolConfig(rootDir, profiles);
  }

  // Bind session to this profile for affinity
  if (sessionId) {
    recordSessionAccount(rootDir, sessionId, alias);
  }
  recordSessionAccount(rootDir, taskId, alias);
}

/**
 * Handles quota exhaustion for a profile: sets paused_until.
 */
export function handlePoolQuotaPaused(
  rootDir: string,
  alias: string,
  resetTime?: string | number
): void {
  const profiles = loadPoolConfig(rootDir);
  const p = profiles.find((item) => item.alias === alias);
  if (!p) return;

  let untilStr: string;
  if (resetTime) {
    const d = new Date(resetTime);
    if (!isNaN(d.getTime())) {
      untilStr = d.toISOString();
    } else {
      untilStr = String(resetTime);
    }
  } else {
    // Default 5-hour window
    untilStr = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  }

  p.paused_until = untilStr;
  savePoolConfig(rootDir, profiles);
}

/**
 * Returns compact status lines for pool_status tool and UI.
 */
export function queryPoolStatus(rootDir: string = resolveBridgeRoot()): PoolStatusLine[] {
  const profiles = loadPoolConfig(rootDir);
  const runningMap = getRunningTasksPerProfile(rootDir);

  let cockpitMap = new Map<string, number>();
  try {
    const cockpitAccounts = listAccountsFromCockpitStorage("antigravity");
    for (const ca of cockpitAccounts) {
      if (ca.email) {
        cockpitMap.set(ca.email.toLowerCase(), ca.remainingFractionSummary ?? 1.0);
      }
    }
  } catch {}

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  return profiles.map((p) => {
    const running = runningMap.get(p.alias) || [];
    const busyTask = running.length > 0 ? running.join(",") : "idle";
    const remFrac = p.email && cockpitMap.has(p.email.toLowerCase())
      ? (cockpitMap.get(p.email.toLowerCase()) ?? 1.0).toFixed(2)
      : "unknown";

    const tasksToday = p.last_task_date === today ? (p.tasks_today || 0) : 0;
    const isPaused = isProfilePaused(p, now);

    return {
      alias: p.alias,
      email: p.email || "(unbound)",
      enabled: p.enabled && !isPaused,
      busy_task_id: busyTask,
      paused_until: p.paused_until && isPaused ? p.paused_until : "none",
      tasks_today: tasksToday,
      cockpit_remaining: remFrac,
    };
  });
}
