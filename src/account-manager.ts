import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveBridgeRoot } from "./config.js";
import { BridgeLogger } from "./logger.js";

export interface CockpitServerInfo {
  ws_port: number;
  auth_token: string;
  version?: string;
  pid?: number;
}

export interface ModelQuotaInfo {
  remainingFraction: number; // 0.0 to 1.0
  resetTime?: string | number;
}

export interface AgentAccountSummary {
  accountId: string;
  email: string;
  name?: string;
  current: boolean;
  disabled: boolean;
  provider: string;
  quotas: Record<string, ModelQuotaInfo>;
  remainingFractionSummary?: number; // 0.0 to 1.0
  resetTime?: string | number;
  lastUsed?: number;
}

export function resolveCockpitConfigPath(customPath?: string): string {
  if (customPath && customPath.trim()) {
    return path.resolve(customPath.trim());
  }
  if (process.env.COCKPIT_CONFIG_PATH && process.env.COCKPIT_CONFIG_PATH.trim()) {
    return path.resolve(process.env.COCKPIT_CONFIG_PATH.trim());
  }
  return path.join(os.homedir(), ".antigravity_cockpit", "server.json");
}

export function loadCockpitServerInfo(customPath?: string): CockpitServerInfo {
  const cfgPath = resolveCockpitConfigPath(customPath);
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Cockpit server.json not found at "${cfgPath}". Cockpit Tools may not be running.`);
  }

  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.ws_port || !parsed.auth_token) {
      throw new Error(`Invalid server.json format at "${cfgPath}": missing ws_port or auth_token.`);
    }
    return {
      ws_port: Number(parsed.ws_port),
      auth_token: String(parsed.auth_token),
      version: parsed.version,
      pid: parsed.pid,
    };
  } catch (err: any) {
    throw new Error(`Failed to read Cockpit server config: ${err?.message || String(err)}`);
  }
}

/**
 * Connects to cockpit-tools local WebSocket and waits for event.ready.
 */
export function connectCockpitWs(
  serverInfo: CockpitServerInfo,
  timeoutMs: number = 5000
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const WS = (globalThis as any).WebSocket;
    if (!WS) {
      return reject(new Error("WebSocket is not supported in this runtime environment"));
    }

    const wsUrl = `ws://127.0.0.1:${serverInfo.ws_port}`;
    let socket: any;
    let timer: NodeJS.Timeout | null = null;

    try {
      socket = new WS(wsUrl);
    } catch (e: any) {
      return reject(new Error(`Failed to create WebSocket connection to Cockpit at ${wsUrl}: ${e?.message || String(e)}`));
    }

    timer = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error(`Cockpit WebSocket connection timed out after ${timeoutMs}ms at ${wsUrl}`));
    }, timeoutMs);

    socket.onmessage = (event: any) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "event.ready") {
          if (timer) clearTimeout(timer);
          resolve(socket);
        }
      } catch {}
    };

    socket.onerror = (err: any) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Cockpit WebSocket error: ${err?.message || "connection error"}`));
    };

    socket.onclose = () => {
      if (timer) clearTimeout(timer);
    };
  });
}

/**
 * Reads local account files stored by cockpit under ~/.antigravity_cockpit/
 * NEVER returns credentials, auth tokens, or session tokens.
 */
export function listAccountsFromCockpitStorage(
  provider: string = "antigravity",
  cockpitDir: string = path.join(os.homedir(), ".antigravity_cockpit")
): AgentAccountSummary[] {
  const normProvider = (provider || "antigravity").toLowerCase().trim();
  const results: AgentAccountSummary[] = [];

  // 1. Preload quota cache from ~/.antigravity_cockpit/cache/quota_api_v1_desktop/authorized/
  const quotaByEmail = new Map<
    string,
    {
      updatedAt: number;
      quotas: Record<string, ModelQuotaInfo>;
      remainingFractionSummary: number;
      resetTime?: string;
    }
  >();

  const quotaDir = path.join(cockpitDir, "cache", "quota_api_v1_desktop", "authorized");
  if (fs.existsSync(quotaDir)) {
    try {
      const qFiles = fs.readdirSync(quotaDir);
      for (const qFile of qFiles) {
        if (!qFile.endsWith(".json") || qFile.endsWith(".bak")) continue;
        const qPath = path.join(quotaDir, qFile);
        try {
          const raw = fs.readFileSync(qPath, "utf8");
          const parsed = JSON.parse(raw);
          if (!parsed.email) continue;
          const emailKey = String(parsed.email).toLowerCase().trim();
          const updatedAt = Number(parsed.updatedAt) || 0;
          const existing = quotaByEmail.get(emailKey);
          if (!existing || updatedAt > existing.updatedAt) {
            const quotas: Record<string, ModelQuotaInfo> = {};
            let minFraction = 1.0;
            let earliestReset: string | undefined = undefined;

            if (parsed.payload?.models && typeof parsed.payload.models === "object") {
              for (const [mName, mVal] of Object.entries(parsed.payload.models as Record<string, any>)) {
                if (mVal && mVal.quotaInfo) {
                  const frac =
                    typeof mVal.quotaInfo.remainingFraction === "number"
                      ? mVal.quotaInfo.remainingFraction
                      : 1.0;
                  const rTime = mVal.quotaInfo.resetTime ? String(mVal.quotaInfo.resetTime) : undefined;
                  quotas[mName] = {
                    remainingFraction: frac,
                    ...(rTime ? { resetTime: rTime } : {}),
                  };
                  if (frac < minFraction) {
                    minFraction = frac;
                    earliestReset = rTime;
                  }
                }
              }
            }

            quotaByEmail.set(emailKey, {
              updatedAt,
              quotas: Object.keys(quotas).length > 0 ? quotas : { default: { remainingFraction: 1.0 } },
              remainingFractionSummary: Math.round(minFraction * 100) / 100,
              resetTime: earliestReset,
            });
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Read accounts list from cockpit JSON files (accounts.json or <provider>_accounts.json)
  let accountsJsonFile = "";
  if (normProvider === "antigravity") {
    accountsJsonFile = path.join(cockpitDir, "accounts.json");
  } else {
    accountsJsonFile = path.join(cockpitDir, `${normProvider}_accounts.json`);
    if (!fs.existsSync(accountsJsonFile) && normProvider === "codex") {
      accountsJsonFile = path.join(cockpitDir, "accounts.json");
    }
  }

  let accountsLoadedFromFile = false;

  if (fs.existsSync(accountsJsonFile)) {
    try {
      const raw = fs.readFileSync(accountsJsonFile, "utf8");
      const parsed = JSON.parse(raw);
      const currentAccountId = parsed.current_account_id || "";
      const rawAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];

      for (const acc of rawAccounts) {
        const accountId = String(acc.id || acc.accountId || "");
        if (!accountId) continue;
        const email = String(acc.email || `${accountId}@local`);
        const emailKey = email.toLowerCase().trim();
        const quotaInfo = quotaByEmail.get(emailKey);

        results.push({
          accountId,
          email,
          name: acc.name ? String(acc.name) : undefined,
          current: accountId === currentAccountId,
          disabled: acc.disabled === true,
          provider: normProvider,
          quotas: quotaInfo?.quotas || {
            default: { remainingFraction: 1.0 },
          },
          remainingFractionSummary: quotaInfo ? quotaInfo.remainingFractionSummary : 1.0,
          resetTime: quotaInfo?.resetTime,
          lastUsed: acc.last_used ? Number(acc.last_used) : undefined,
        });
      }
      accountsLoadedFromFile = true;
    } catch {}
  }

  // 3. Fallback to accounts/ directory if accounts.json was not found
  if (!accountsLoadedFromFile) {
    const accountsDir = path.join(cockpitDir, "accounts");
    let currentAccountId = "";
    try {
      const currentFile = path.join(cockpitDir, "antigravity_runtime_current_accounts.json");
      if (fs.existsSync(currentFile)) {
        const parsed = JSON.parse(fs.readFileSync(currentFile, "utf8"));
        currentAccountId = parsed?.currentAccounts?.antigravity_ide || parsed?.currentAccounts?.[normProvider] || "";
      }
    } catch {}

    if (fs.existsSync(accountsDir)) {
      try {
        const files = fs.readdirSync(accountsDir);
        for (const file of files) {
          if (!file.endsWith(".json") || file.endsWith(".bak")) continue;
          const filePath = path.join(accountsDir, file);
          try {
            const content = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(content);
            const kind = (parsed.kind || "").toLowerCase();
            if (kind === normProvider || file.startsWith(`${normProvider}_`)) {
              const accountId = file.replace(/\.json$/, "");
              const email = parsed.email || `${accountId}@local`;
              const emailKey = email.toLowerCase().trim();
              const quotaInfo = quotaByEmail.get(emailKey);
              results.push({
                accountId,
                email,
                name: parsed.name ? String(parsed.name) : undefined,
                current: accountId === currentAccountId,
                disabled: parsed.disabled === true,
                provider: normProvider,
                quotas: quotaInfo?.quotas || parsed.quotas || {
                  default: { remainingFraction: 1.0 },
                },
                remainingFractionSummary: quotaInfo ? quotaInfo.remainingFractionSummary : 1.0,
                resetTime: quotaInfo?.resetTime,
                lastUsed: parsed.last_used ? Number(parsed.last_used) : undefined,
              });
            }
          } catch {}
        }
      } catch {}
    }
  }

  return results;
}

/**
 * Sends request.switch_account via WebSocket and awaits event.account_switched or event.switch_error.
 */
export async function switchAgentAccount(
  options: {
    provider: string;
    targetEmailOrAccount: string;
    runtimeTarget?: string;
    cockpitConfigPath?: string;
    timeoutMs?: number;
    logger?: BridgeLogger;
  }
): Promise<{ success: boolean; accountId?: string; email?: string; error?: string }> {
  const timeoutMs = options.timeoutMs || 10000;
  const runtimeTarget = options.runtimeTarget || "antigravity";

  let serverInfo: CockpitServerInfo;
  try {
    serverInfo = loadCockpitServerInfo(options.cockpitConfigPath);
  } catch (err: any) {
    return { success: false, error: `Cockpit is not running: ${err.message}` };
  }

  // Resolve target account ID if "auto" or email was given
  let targetAccountId = options.targetEmailOrAccount;
  if (targetAccountId === "auto" || !targetAccountId.includes("_")) {
    const accounts = listAccountsFromCockpitStorage(options.provider);
    if (accounts.length === 0) {
      return { success: false, error: `No accounts found for provider "${options.provider}"` };
    }
    if (targetAccountId === "auto") {
      // Pick account with highest remaining quota
      accounts.sort((a, b) => {
        const qA = a.remainingFractionSummary ?? a.quotas?.default?.remainingFraction ?? 0;
        const qB = b.remainingFractionSummary ?? b.quotas?.default?.remainingFraction ?? 0;
        return qB - qA;
      });
      targetAccountId = accounts[0].accountId;
    } else {
      const match = accounts.find((a) => a.email.toLowerCase() === targetAccountId.toLowerCase() || a.accountId === targetAccountId);
      if (match) {
        targetAccountId = match.accountId;
      }
    }
  }

  let ws: any;
  try {
    ws = await connectCockpitWs(serverInfo, 5000);
  } catch (err: any) {
    return { success: false, error: `Failed to connect to Cockpit WebSocket: ${err.message}` };
  }

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ success: false, error: `Account switch timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    ws.onmessage = (event: any) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "event.account_switched") {
          if (timer) clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({
            success: true,
            accountId: msg.payload?.account_id,
            email: msg.payload?.email,
          });
        } else if (msg.type === "event.switch_error") {
          if (timer) clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({
            success: false,
            error: msg.payload?.message || "Cockpit account switch failed",
          });
        }
      } catch {}
    };

    const reqPayload = {
      type: "request.switch_account",
      payload: {
        auth_token: serverInfo.auth_token,
        account_id: targetAccountId,
        runtime_target: runtimeTarget,
        launch_on_switch: false,
      },
    };

    options.logger?.info(`switchAgentAccount: Dispatching switch_account to Cockpit for ${targetAccountId} (runtime: ${runtimeTarget})`);
    ws.send(JSON.stringify(reqPayload));
  });
}
