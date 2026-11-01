import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveBridgeRoot } from "./config.js";
import { resolveSafePath } from "./validator.js";

export type QueueItemStatus = "queued" | "ready" | "dispatched" | "cancelled";
export type QueueMode = "auto" | "notify";

export interface QueueItem {
  id: string;
  session_id: string;
  after_task_id?: string;
  prompt: string;
  position: number;
  status: QueueItemStatus;
  mode: QueueMode;
  created_at: string;
  options?: {
    title?: string;
    agent?: string;
    model?: string;
    reasoning_effort?: string;
    continue_session?: boolean;
    requirement_id?: string;
    [key: string]: any;
  };
  dispatched_at?: string;
  dispatched_task_id?: string;
}

export interface SessionQueueState {
  session_id: string;
  paused: boolean;
  pause_reason?: string;
  items: QueueItem[];
}

export interface QueueCompactItem {
  id: string;
  session_id: string;
  position: number;
  status: QueueItemStatus;
  mode: QueueMode;
  prompt_preview: string;
  project_id?: string;
  plan_id?: string;
  step_id?: string;
  pr_url?: string;
  previous_task_id?: string;
}

export function isValidQueueId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function isValidSessionQueueId(sessionId: unknown): sessionId is string {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  return /^[a-zA-Z0-9_.:/-]+$/.test(sessionId);
}

export function generateQueueId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  return `q_${ts}_${rand}`;
}

export function getQueueDir(rootDir: string = resolveBridgeRoot()): string {
  const dir = path.join(rootDir, "queue");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getSessionQueueFileName(sessionId: string): string {
  // Hash or safe encode session id to avoid path issues
  const safeSession = Buffer.from(sessionId).toString("base64url");
  return `${safeSession}.json`;
}

/**
 * Loads a session queue state from disk.
 */
export function loadSessionQueue(rootDir: string, sessionId: string): SessionQueueState {
  const queueDir = getQueueDir(rootDir);
  const fileName = getSessionQueueFileName(sessionId);
  const filePath = path.join(queueDir, fileName);

  if (!fs.existsSync(filePath)) {
    return {
      session_id: sessionId,
      paused: false,
      items: [],
    };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as SessionQueueState;
    if (data && Array.isArray(data.items)) {
      return data;
    }
  } catch {}

  return {
    session_id: sessionId,
    paused: false,
    items: [],
  };
}

/**
 * Saves a session queue state to disk atomically.
 */
export function saveSessionQueue(rootDir: string, state: SessionQueueState): void {
  const queueDir = getQueueDir(rootDir);
  const fileName = getSessionQueueFileName(state.session_id);
  const targetPath = path.join(queueDir, fileName);
  const tmpPath = path.join(queueDir, `${fileName}.tmp`);

  // Ensure positions are consistent (1-indexed, sequential)
  state.items.forEach((item, idx) => {
    item.position = idx + 1;
  });

  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Lists all session queues from disk.
 */
export function listAllSessionQueues(rootDir: string): SessionQueueState[] {
  const queueDir = getQueueDir(rootDir);
  let files: string[] = [];
  try {
    files = fs.readdirSync(queueDir);
  } catch {
    return [];
  }

  const results: SessionQueueState[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    try {
      const raw = fs.readFileSync(path.join(queueDir, file), "utf8");
      const state = JSON.parse(raw) as SessionQueueState;
      if (state && state.session_id && Array.isArray(state.items)) {
        results.push(state);
      }
    } catch {}
  }
  return results;
}

/**
 * Adds an item to a session's queue.
 */
export function enqueueTask(
  rootDir: string,
  params: {
    session_id: string;
    after_task_id?: string;
    prompt: string;
    options?: QueueItem["options"];
    mode?: QueueMode;
  }
): { id: string; position: number } {
  const sessionId = params.session_id.trim();
  const state = loadSessionQueue(rootDir, sessionId);

  const id = generateQueueId();
  const position = state.items.length + 1;
  const newItem: QueueItem = {
    id,
    session_id: sessionId,
    after_task_id: params.after_task_id,
    prompt: params.prompt,
    position,
    status: "queued",
    mode: params.mode === "notify" ? "notify" : "auto",
    created_at: new Date().toISOString(),
    options: params.options,
  };

  state.items.push(newItem);
  saveSessionQueue(rootDir, state);

  return { id, position };
}

/**
 * Compact preview helper (<=80 chars, normalized whitespace).
 */
export function toPromptPreview(prompt: string, maxLen = 80): string {
  const oneLine = prompt.replace(/\r?\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

/**
 * Lists compact queue items, optionally filtered by session_id.
 */
export function listQueue(
  rootDir: string,
  sessionId?: string,
  filter?: { projectId?: string; planId?: string }
): QueueCompactItem[] {
  let states: SessionQueueState[] = [];
  if (sessionId) {
    states = [loadSessionQueue(rootDir, sessionId.trim())];
  } else {
    states = listAllSessionQueues(rootDir);
  }

  const normProj = filter?.projectId ? filter.projectId.trim().toLowerCase() : undefined;
  const normPlan = filter?.planId ? filter.planId.trim().toLowerCase() : undefined;

  const result: QueueCompactItem[] = [];
  for (const state of states) {
    for (const item of state.items) {
      const itemProj = (item.options?.project_id || item.options?.project || "").toString().trim();
      const itemPlan = (item.options?.plan_id || "").toString().trim();
      const itemStep = (item.options?.step_id || "").toString().trim();
      const itemPrUrl = (item.options?.pr_url || "").toString().trim();
      const itemPrevTaskId = (item.options?.previous_task_id || item.after_task_id || "").toString().trim();

      if (normProj && itemProj.toLowerCase() !== normProj) {
        continue;
      }
      if (normPlan && itemPlan.toLowerCase() !== normPlan) {
        continue;
      }

      result.push({
        id: item.id,
        session_id: item.session_id,
        position: item.position,
        status: item.status,
        mode: item.mode,
        prompt_preview: toPromptPreview(item.prompt, 80),
        project_id: itemProj || undefined,
        plan_id: itemPlan || undefined,
        step_id: itemStep || undefined,
        pr_url: itemPrUrl || undefined,
        previous_task_id: itemPrevTaskId || undefined,
      });
    }
  }

  // Sort by session_id then position
  result.sort((a, b) => {
    if (a.session_id === b.session_id) {
      return a.position - b.position;
    }
    return a.session_id.localeCompare(b.session_id);
  });

  return result;
}

/**
 * Finds which session queue contains the given item ID.
 */
export function findItemInQueues(
  rootDir: string,
  itemId: string
): { state: SessionQueueState; item: QueueItem; index: number } | null {
  const states = listAllSessionQueues(rootDir);
  for (const state of states) {
    const idx = state.items.findIndex((it) => it.id === itemId);
    if (idx !== -1) {
      return { state, item: state.items[idx], index: idx };
    }
  }
  return null;
}

/**
 * Reorders a session queue by a complete list of IDs or moves an item to a target position.
 */
export function reorderQueue(
  rootDir: string,
  sessionId: string,
  orderedIds?: string[],
  moveItem?: { id: string; target_position: number }
): { success: boolean; items: QueueCompactItem[]; error?: string } {
  const state = loadSessionQueue(rootDir, sessionId);
  if (state.items.length === 0) {
    return { success: true, items: [] };
  }

  if (orderedIds && Array.isArray(orderedIds)) {
    // Validate that all orderedIds belong to this queue
    const itemMap = new Map<string, QueueItem>();
    state.items.forEach((item) => itemMap.set(item.id, item));

    const newItems: QueueItem[] = [];
    for (const id of orderedIds) {
      const item = itemMap.get(id);
      if (!item) {
        return { success: false, items: [], error: `Item id "${id}" does not belong to session "${sessionId}"` };
      }
      newItems.push(item);
      itemMap.delete(id);
    }
    // Append any unmentioned items at the end
    for (const remaining of itemMap.values()) {
      newItems.push(remaining);
    }
    state.items = newItems;
  } else if (moveItem) {
    const fromIdx = state.items.findIndex((it) => it.id === moveItem.id);
    if (fromIdx === -1) {
      return { success: false, items: [], error: `Item id "${moveItem.id}" not found in session "${sessionId}"` };
    }
    const [item] = state.items.splice(fromIdx, 1);
    let targetIdx = moveItem.target_position - 1;
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx > state.items.length) targetIdx = state.items.length;
    state.items.splice(targetIdx, 0, item);
  }

  saveSessionQueue(rootDir, state);
  return {
    success: true,
    items: state.items.map((it) => ({
      id: it.id,
      session_id: it.session_id,
      position: it.position,
      status: it.status,
      mode: it.mode,
      prompt_preview: toPromptPreview(it.prompt, 80),
    })),
  };
}

/**
 * Updates a queue item's prompt, options, or mode.
 */
export function updateQueueItem(
  rootDir: string,
  id: string,
  updates: { prompt?: string; mode?: QueueMode; options?: Partial<QueueItem["options"]> }
): QueueItem | null {
  const found = findItemInQueues(rootDir, id);
  if (!found) return null;

  const { state, item } = found;
  if (updates.prompt !== undefined) {
    item.prompt = updates.prompt;
  }
  if (updates.mode !== undefined) {
    item.mode = updates.mode;
  }
  if (updates.options !== undefined) {
    item.options = {
      ...(item.options || {}),
      ...updates.options,
    };
  }

  saveSessionQueue(rootDir, state);
  return item;
}

/**
 * Cancels a queue item and removes or marks cancelled.
 */
export function cancelQueueItem(rootDir: string, id: string): boolean {
  const found = findItemInQueues(rootDir, id);
  if (!found) return false;

  const { state, index } = found;
  // Remove the item from queue
  state.items.splice(index, 1);
  saveSessionQueue(rootDir, state);
  return true;
}

/**
 * Pauses a session's queue.
 */
export function pauseQueue(rootDir: string, sessionId: string, reason?: string): boolean {
  const state = loadSessionQueue(rootDir, sessionId);
  state.paused = true;
  state.pause_reason = reason || "manually paused";
  saveSessionQueue(rootDir, state);
  return true;
}

/**
 * Resumes a session's queue.
 */
export function resumeQueue(rootDir: string, sessionId: string): boolean {
  const state = loadSessionQueue(rootDir, sessionId);
  state.paused = false;
  delete state.pause_reason;
  saveSessionQueue(rootDir, state);
  return true;
}
