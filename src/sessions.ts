import fs from "node:fs";
import path from "node:path";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionEntryObject {
  sessionId?: string;
  account?: string;
  [key: string]: any;
}

export type SessionEntry = string | SessionEntryObject;

export interface SessionMap {
  [aliasOrTaskId: string]: SessionEntry;
}

/**
 * Loads the sessions.json mapping file safely.
 */
export function loadSessions(rootDir: string): SessionMap {
  const sessionsPath = path.join(rootDir, "sessions.json");
  if (!fs.existsSync(sessionsPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(sessionsPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolves an input session identifier (alias, taskId, or raw UUID) to the
 * underlying engine session UUID.
 */
export function resolveSessionId(rootDir: string, inputSessionId?: string): string | undefined {
  if (!inputSessionId || typeof inputSessionId !== "string") {
    return undefined;
  }
  const trimmed = inputSessionId.trim();
  if (!trimmed) return undefined;

  // If it's already a UUID, return directly
  if (UUID_REGEX.test(trimmed)) {
    return trimmed;
  }

  // Look up in sessions.json
  const map = loadSessions(rootDir);
  const entry = map[trimmed];
  if (entry) {
    if (typeof entry === "string") return entry;
    if (typeof entry === "object" && entry.sessionId) return entry.sessionId;
  }

  // Not yet mapped (e.g. first turn of a newly named session alias)
  return undefined;
}

/**
 * Retrieves the bound account profile alias for a given session or task identifier.
 */
export function getSessionAccount(rootDir: string, inputSessionId?: string): string | undefined {
  if (!inputSessionId || typeof inputSessionId !== "string") {
    return undefined;
  }
  const trimmed = inputSessionId.trim();
  if (!trimmed) return undefined;

  const map = loadSessions(rootDir);
  const entry = map[trimmed];
  if (entry && typeof entry === "object" && entry.account) {
    return entry.account;
  }

  // If inputSessionId is an underlying UUID, scan values
  for (const val of Object.values(map)) {
    if (typeof val === "object" && val.sessionId === trimmed && val.account) {
      return val.account;
    }
  }

  return undefined;
}

/**
 * Records or updates the bound account profile alias for a given session.
 */
export function recordSessionAccount(rootDir: string, sessionOrKey: string, account: string): void {
  if (!sessionOrKey || !account) return;
  const sessionsPath = path.join(rootDir, "sessions.json");
  const tmpPath = path.join(rootDir, "sessions.json.tmp");
  const map = loadSessions(rootDir);
  const trimmed = sessionOrKey.trim();
  const cleanAccount = account.trim();

  const existing = map[trimmed];
  if (typeof existing === "string") {
    map[trimmed] = { sessionId: existing, account: cleanAccount };
  } else if (typeof existing === "object") {
    map[trimmed] = { ...existing, account: cleanAccount };
  } else {
    map[trimmed] = { sessionId: trimmed, account: cleanAccount };
  }

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(map, null, 2), "utf8");
    fs.renameSync(tmpPath, sessionsPath);
  } catch {}
}

/**
 * Atomically records or updates a session mapping in sessions.json.
 */
export function recordSession(
  rootDir: string,
  key: string,
  underlyingSessionId: string,
  account?: string
): void {
  if (!key || !underlyingSessionId) return;
  const sessionsPath = path.join(rootDir, "sessions.json");
  const tmpPath = path.join(rootDir, "sessions.json.tmp");

  const map = loadSessions(rootDir);
  const trimmedKey = key.trim();
  const existing = map[trimmedKey];
  const effectiveAccount = account?.trim() || (typeof existing === "object" ? existing.account : undefined);

  if (effectiveAccount) {
    map[trimmedKey] = {
      sessionId: underlyingSessionId.trim(),
      account: effectiveAccount,
    };
  } else {
    map[trimmedKey] = underlyingSessionId.trim();
  }

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(map, null, 2), "utf8");
    fs.renameSync(tmpPath, sessionsPath);
  } catch {}
}

/**
 * Extracts the engine's internal session ID from execution stdout.
 * Supports OpenAI Codex (e.g. "session id: 01a186a0-...") and AGY conversation IDs.
 */
export function extractSessionIdFromOutput(stdout: string): string | undefined {
  if (!stdout || typeof stdout !== "string") return undefined;

  // 1. OpenAI Codex session id
  const codexMatch = stdout.match(/session\s+id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (codexMatch) {
    return codexMatch[1];
  }

  // 2. Generic conversation/session UUID pattern
  const convMatch = stdout.match(/conversation[:\s_]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (convMatch) {
    return convMatch[1];
  }

  return undefined;
}
