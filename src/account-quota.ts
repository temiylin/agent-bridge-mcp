
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { listAccountsFromCockpitStorage, loadCockpitServerInfo } from "./account-manager.js";

/** Compact quota window. remaining_pct is 0-100. reset_at is ISO-8601 UTC. */
export interface QuotaWindow {
  remaining_pct: number;
  reset_at?: string;
  model?: string;
}

export interface AgentAccountQuota {
  agent: string;
  account?: string;
  plan?: string;
  /** Present only when the account has a 5-hour window. */
  five_hour?: QuotaWindow;
  weekly?: QuotaWindow;
  limited?: boolean;
  source: string;
  error?: string;
}

const FIVE_HOUR_MS = 5 * 3600 * 1000;
const CACHE_TTL_MS = Number(process.env.AGENT_BRIDGE_QUOTA_CACHE_MS || 60_000);
const cache = new Map<string, { at: number; value: AgentAccountQuota }>();

function toIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function pct(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

function cockpitDir(): string {
  return process.env.AGENT_BRIDGE_COCKPIT_DIR || path.join(os.homedir(), ".antigravity_cockpit");
}

/** Cockpit server.json exists and its pid is alive (cheap; no WS round-trip). */
export function cockpitRunning(): boolean {
  try {
    const info = loadCockpitServerInfo(process.env.COCKPIT_CONFIG_PATH || path.join(cockpitDir(), "server.json"));
    if (!info.pid) return true;
    process.kill(Number(info.pid), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify agy per-model quota entries into 5h vs weekly windows by time-to-reset.
 * Exported for tests.
 */
export function summarizeAgyQuotas(
  quotas: Record<string, { remainingFraction: number; resetTime?: string | number }>,
  model?: string,
  now: number = Date.now()
): Pick<AgentAccountQuota, "five_hour" | "weekly" | "limited"> {
  let five: QuotaWindow | undefined;
  let weekly: QuotaWindow | undefined;
  const consider = (name: string, q: { remainingFraction: number; resetTime?: string | number }) => {
    const resetIso = toIso(q.resetTime);
    if (!resetIso) return;
    const delta = new Date(resetIso).getTime() - now;
    if (delta < 0) return; // stale entry, window already reset
    const w: QuotaWindow = { remaining_pct: pct(q.remainingFraction), reset_at: resetIso, model: name };
    if (delta <= FIVE_HOUR_MS + 10 * 60 * 1000) {
      if (!five || w.remaining_pct < five.remaining_pct) five = w;
    } else if (!weekly || w.remaining_pct < weekly.remaining_pct) weekly = w;
  };
  if (model && quotas[model]) {
    consider(model, quotas[model]);
  } else {
    for (const [name, q] of Object.entries(quotas)) {
      if (/^(chat_|tab_)/.test(name)) continue;
      consider(name, q);
    }
  }
  const out: Pick<AgentAccountQuota, "five_hour" | "weekly" | "limited"> = {};
  if (five) out.five_hour = five;
  if (weekly) out.weekly = weekly;
  const vals = [five, weekly].filter(Boolean) as QuotaWindow[];
  if (vals.length) out.limited = vals.some(v => v.remaining_pct <= 0);
  return out;
}

export function getAgyAccountQuota(model?: string, dir: string = cockpitDir()): AgentAccountQuota {
  const running = cockpitRunning();
  const source = running ? "cockpit-tools (running) local quota cache" : "cockpit-tools local quota cache (cockpit not running; may be stale)";
  try {
    const accounts = listAccountsFromCockpitStorage("antigravity", dir);
    const current = accounts.find(a => a.current);
    if (!current) return { agent: "agy", source, error: "no current agy account in cockpit" };
    return { agent: "agy", account: current.email, ...summarizeAgyQuotas(current.quotas, model), source };
  } catch (err: any) {
    return { agent: "agy", source, error: err?.message || String(err) };
  }
}

/** Convert codex app-server account/rateLimits/read result into compact windows. Exported for tests. */
export function summarizeCodexRateLimits(result: any): Pick<AgentAccountQuota, "five_hour" | "weekly" | "limited" | "plan"> {
  const rl = result?.rateLimits || result?.rateLimitsByLimitId?.codex || {};
  const out: Pick<AgentAccountQuota, "five_hour" | "weekly" | "limited" | "plan"> = {};
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const win: QuotaWindow = { remaining_pct: Math.max(0, Math.min(100, Math.round(100 - w.usedPercent))), reset_at: toIso(w.resetsAt) };
    const mins = Number(w.windowDurationMins) || 0;
    if (mins > 0 && mins <= 360) out.five_hour = win;
    else out.weekly = win;
  }
  if (rl.planType) out.plan = String(rl.planType);
  if (rl.rateLimitReachedType || result?.ordinaryUsageAllowed === false) out.limited = true;
  else if (out.five_hour || out.weekly) out.limited = [out.five_hour, out.weekly].some(w => w && w.remaining_pct <= 0);
  return out;
}

function resolveCommand(command: string): string {
  if (path.isAbsolute(command)) return command;
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8", timeout: 2000 });
    const p = (r.stdout || "").split(/\r?\n/)[0].trim();
    if (r.status === 0 && p) return p;
  } catch {}
  return command;
}

/** Ask the codex CLI's own app-server (no inference) for the signed-in account and rate limits. */
export function queryCodexAccount(command: string, timeoutMs = 8000, env?: NodeJS.ProcessEnv): Promise<{ account?: any; rateLimits?: any } | null> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(resolveCommand(command), ["app-server", "--stdio"], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: env || process.env });
    } catch {
      return resolve(null);
    }
    const got: { account?: any; rateLimits?: any } = {};
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      if (child.exitCode === null) child.kill();
      resolve(got.account || got.rateLimits ? got : null);
    };
    const timer = setTimeout(finish, timeoutMs);
    const send = (o: any) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
    child.stderr.resume();
    child.on("error", finish);
    child.on("exit", finish);
    child.stdin.on("error", finish);
    createInterface({ input: child.stdout }).on("line", line => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) {
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "account/read", params: {} });
        send({ id: 3, method: "account/rateLimits/read" });
      } else if (m.id === 2) {
        got.account = m.result || null;
        if (got.rateLimits !== undefined) finish();
      } else if (m.id === 3) {
        got.rateLimits = m.result || null;
        if (got.account !== undefined) finish();
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent_bridge_quota", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
  });
}

export async function getCodexAccountQuota(command = "codex"): Promise<AgentAccountQuota> {
  const source = "codex app-server account/rateLimits/read";
  const res = await queryCodexAccount(command);
  if (!res) return { agent: "codex", source, error: "codex app-server did not answer" };
  const acct = res.account?.account;
  const summary = res.rateLimits ? summarizeCodexRateLimits(res.rateLimits) : {};
  return {
    agent: "codex",
    ...(acct?.email ? { account: String(acct.email) } : acct?.type ? { account: String(acct.type) } : {}),
    ...(acct?.planType ? { plan: String(acct.planType) } : {}),
    ...summary,
    source,
  };
}

/** Cached quota lookup for agy/codex; other agents return null. Never throws. */
export async function getAgentAccountQuota(agent: string, opts: { model?: string; command?: string; fresh?: boolean } = {}): Promise<AgentAccountQuota | null> {
  const name = (agent || "").toLowerCase();
  if (name !== "agy" && name !== "codex") return null;
  if (process.env.AGENT_BRIDGE_QUOTA_INFO === "0") return null;
  const key = `${name}|${name === "agy" ? opts.model || "" : ""}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const value = name === "agy" ? getAgyAccountQuota(opts.model) : await getCodexAccountQuota(opts.command || "codex");
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err: any) {
    return { agent: name, source: "error", error: err?.message || String(err) };
  }
}

/** One-line human summary, e.g. "agy a@b.com | 5h 80% (reset 13:22Z) | week 40% (reset 11-06)". */
export function formatQuotaLine(q: AgentAccountQuota | null): string {
  if (!q) return "";
  const parts = [`${q.agent} ${q.account || "(unknown account)"}${q.plan ? ` [${q.plan}]` : ""}`];
  if (q.five_hour) parts.push(`5h ${q.five_hour.remaining_pct}% left${q.five_hour.reset_at ? ` (resets ${q.five_hour.reset_at})` : ""}`);
  if (q.weekly) parts.push(`weekly ${q.weekly.remaining_pct}% left${q.weekly.reset_at ? ` (resets ${q.weekly.reset_at})` : ""}`);
  if (q.limited) parts.push("LIMITED");
  if (q.error) parts.push(`quota unavailable: ${q.error}`);
  return parts.join(" | ");
}

export function _clearQuotaCache(): void { cache.clear(); }
