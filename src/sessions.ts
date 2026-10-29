import fs from "node:fs";
import path from "node:path";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionMap {
  [aliasOrTaskId: string]: string;
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
  if (map[trimmed]) {
    return map[trimmed];
  }

  // Not yet mapped (e.g. first turn of a newly named session alias)
  return undefined;
}

/**
 * Atomically records or updates a session mapping in sessions.json.
 */
export function recordSession(rootDir: string, key: string, underlyingSessionId: string): void {
  if (!key || !underlyingSessionId) return;
  const sessionsPath = path.join(rootDir, "sessions.json");
  const tmpPath = path.join(rootDir, "sessions.json.tmp");

  const map = loadSessions(rootDir);
  map[key.trim()] = underlyingSessionId.trim();

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
