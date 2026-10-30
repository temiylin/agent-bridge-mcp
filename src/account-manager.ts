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
  current: boolean;
  disabled: boolean;
  provider: string;
  quotas: Record<string, ModelQuotaInfo>;
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
  const accountsDir = path.join(cockpitDir, "accounts");
  const results: AgentAccountSummary[] = [];

  // Determine current active account for this provider
  let currentAccountId = "";
  try {
    const currentFile = path.join(cockpitDir, "antigravity_runtime_current_accounts.json");
    if (fs.existsSync(currentFile)) {
      const parsed = JSON.parse(fs.readFileSync(currentFile, "utf8"));
      currentAccountId = parsed?.currentAccounts?.antigravity_ide || parsed?.currentAccounts?.[normProvider] || "";
    }
  } catch {}

  if (!fs.existsSync(accountsDir)) {
    return results;
  }

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
        results.push({
          accountId,
          email: parsed.email || `${accountId}@local`,
          current: accountId === currentAccountId,
          disabled: parsed.disabled === true,
          provider: normProvider,
          quotas: parsed.quotas || {
            default: { remainingFraction: 1.0 },
          },
        });
      }
    } catch {}
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
        const qA = a.quotas?.default?.remainingFraction ?? 0;
        const qB = b.quotas?.default?.remainingFraction ?? 0;
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
