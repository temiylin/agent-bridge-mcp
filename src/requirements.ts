import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveBridgeRoot } from "./config.js";
import { resolveSafePath } from "./validator.js";

export type RequirementStatus = "draft" | "dispatched" | "merged" | "archived";

export interface RequirementRecord {
  id: string;
  project: string;
  topic?: string;
  session_id?: string;
  title: string;
  raw_text: string;
  tags?: string[];
  status: RequirementStatus;
  created_at: string;
  updated_at?: string;
  dispatched_at?: string;
  task_id?: string;
  merged_into?: string;
  merged_from?: string[];
}

export interface RequirementCompact {
  id: string;
  title: string;
  project: string;
  topic?: string;
  session_id?: string;
  status: RequirementStatus;
  created_at: string;
}

export function isValidRequirementId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function generateRequirementId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  return `req_${ts}_${rand}`;
}

export function getRequirementsDir(rootDir: string = resolveBridgeRoot()): string {
  const dir = path.join(rootDir, "requirements");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Atomically writes a requirement file using .tmp rename.
 */
export function writeRequirement(rootDir: string, req: RequirementRecord): void {
  if (!isValidRequirementId(req.id)) {
    throw new Error(`Invalid requirement id: "${req.id}"`);
  }
  const reqDir = getRequirementsDir(rootDir);
  const targetPath = resolveSafePath(reqDir, rootDir, `${req.id}.json`);
  const tmpPath = resolveSafePath(reqDir, rootDir, `${req.id}.json.tmp`);

  fs.writeFileSync(tmpPath, JSON.stringify(req, null, 2), "utf8");
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Reads a single requirement by ID. Returns null if not found.
 */
export function getRequirement(rootDir: string, id: string): RequirementRecord | null {
  if (!isValidRequirementId(id)) {
    return null;
  }
  const reqDir = getRequirementsDir(rootDir);
  let filePath: string;
  try {
    filePath = resolveSafePath(reqDir, rootDir, `${id}.json`);
  } catch {
    return null;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as RequirementRecord;
  } catch {
    return null;
  }
}

/**
 * Lists compact requirements filtered by project, topic, or status.
 */
export function listRequirements(
  rootDir: string,
  filter?: { project?: string; topic?: string; status?: RequirementStatus }
): RequirementCompact[] {
  const reqDir = getRequirementsDir(rootDir);
  let files: string[] = [];
  try {
    files = fs.readdirSync(reqDir);
  } catch {
    return [];
  }

  const results: RequirementCompact[] = [];

  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    const filePath = path.join(reqDir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const record = JSON.parse(raw) as RequirementRecord;
      if (!record || !record.id || !record.status) continue;

      if (filter?.project && record.project !== filter.project) {
        continue;
      }
      if (filter?.topic) {
        const matchesTopic = record.topic === filter.topic || record.session_id === filter.topic;
        if (!matchesTopic) continue;
      }
      if (filter?.status && record.status !== filter.status) {
        continue;
      }

      results.push({
        id: record.id,
        title: record.title,
        project: record.project,
        topic: record.topic,
        session_id: record.session_id,
        status: record.status,
        created_at: record.created_at,
      });
    } catch {
      // Ignore corrupted or unreadable files
    }
  }

  // Sort by created_at descending (newest first)
  results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return results;
}

/**
 * Deletes a requirement record file. Returns true if removed, false if not found.
 */
export function deleteRequirement(rootDir: string, id: string): boolean {
  if (!isValidRequirementId(id)) return false;
  const reqDir = getRequirementsDir(rootDir);
  let filePath: string;
  try {
    filePath = resolveSafePath(reqDir, rootDir, `${id}.json`);
  } catch {
    return false;
  }

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
