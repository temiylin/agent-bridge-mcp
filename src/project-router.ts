import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveBridgeRoot } from "./config.js";

export interface ServiceConfig {
  name: string;
  command: string;
  port: number;
  health_url: string;
  cwd?: string;
  env?: Record<string, string>;
  changed_paths?: string[];
  health_timeout_seconds?: number;
}

export interface VerifyPrConfig {
  test_commands?: string[];
  timeout_seconds?: number;
}

export interface MergeDeployConfig {
  checkout_path?: string;
  target_branch?: string;
  services?: string[];
}

export interface ProjectDefinition {
  id: string;
  name: string;
  repo?: string;
  slack_channel?: string;
  slack_webhook_env?: string;
  slack_user_id?: string;
  callback_url?: string;
  callback_headers?: Record<string, string>;
  worktree_root?: string;
  symlink_dirs?: string[];
  paths?: string[];
  description?: string;
  services?: Record<string, ServiceConfig>;
  verify_pr?: VerifyPrConfig;
  merge_deploy?: MergeDeployConfig;
}

export interface ProjectsConfig {
  version: string;
  default_channel?: string;
  projects: Record<string, ProjectDefinition>;
}

export interface ProjectResolution {
  matched: boolean;
  project?: ProjectDefinition;
  channelId?: string;
  reason: string;
  conflict?: boolean;
}

let cachedConfig: { mtimeMs: number; config: ProjectsConfig; filePath: string } | null = null;

export function getProjectsFilePath(rootDir: string = resolveBridgeRoot()): string {
  return path.join(rootDir, "projects.json");
}

export function getDefaultProjectsConfig(): ProjectsConfig {
  return {
    version: "1.0.0",
    default_channel: "",
    projects: {},
  };
}

/**
 * Normalizes a filesystem path, resolving symlinks when possible and standardizing separators.
 */
export function normalizeRealpath(targetPath: string): string {
  if (!targetPath || typeof targetPath !== "string") return "";
  try {
    const resolved = path.resolve(targetPath);
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
    return resolved;
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * Safe directory boundary match. Prevents /code/my-project matching /code/my-project-backup.
 */
export function isPathInsideOrEqual(candidateChild: string, configuredParent: string): boolean {
  const normChild = normalizeRealpath(candidateChild);
  const normParent = normalizeRealpath(configuredParent);

  if (!normChild || !normParent) return false;
  if (normChild === normParent) return true;

  const parentWithSep = normParent.endsWith(path.sep) ? normParent : normParent + path.sep;
  return normChild.startsWith(parentWithSep);
}

/**
 * Loads projects.json from rootDir with hot-reloading cache.
 */
export function loadProjectsConfig(rootDir: string = resolveBridgeRoot()): ProjectsConfig {
  const filePath = getProjectsFilePath(rootDir);

  try {
    if (!fs.existsSync(filePath)) {
      const defaults = getDefaultProjectsConfig();
      if (!fs.existsSync(rootDir)) {
        fs.mkdirSync(rootDir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf8");
      return defaults;
    }

    const stat = fs.statSync(filePath);
    if (cachedConfig && cachedConfig.filePath === filePath && cachedConfig.mtimeMs === stat.mtimeMs) {
      return cachedConfig.config;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);

    const config: ProjectsConfig = {
      version: typeof parsed.version === "string" ? parsed.version : "1.0.0",
      default_channel: typeof parsed.default_channel === "string" ? parsed.default_channel.trim() : "",
      projects: {},
    };

    if (parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)) {
      for (const [key, val] of Object.entries(parsed.projects)) {
        if (!val || typeof val !== "object") continue;
        const p = val as any;
        const id = (typeof p.id === "string" && p.id.trim()) ? p.id.trim() : key.trim();
        config.projects[id] = {
          id,
          name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : id,
          repo: typeof p.repo === "string" ? p.repo.trim() : undefined,
          slack_channel: typeof p.slack_channel === "string" ? p.slack_channel.trim() : undefined,
          slack_webhook_env: typeof p.slack_webhook_env === "string" ? p.slack_webhook_env.trim() : undefined,
          slack_user_id: typeof p.slack_user_id === "string" ? p.slack_user_id.trim() : undefined,
          callback_url: typeof p.callback_url === "string" ? p.callback_url.trim() : undefined,
          callback_headers: p.callback_headers && typeof p.callback_headers === "object" && !Array.isArray(p.callback_headers)
            ? p.callback_headers
            : undefined,
          worktree_root: typeof p.worktree_root === "string" ? p.worktree_root.trim() : undefined,
          symlink_dirs: Array.isArray(p.symlink_dirs)
            ? p.symlink_dirs.map((x: any) => String(x).trim()).filter(Boolean)
            : undefined,
          paths: Array.isArray(p.paths)
            ? p.paths.map((x: any) => String(x).trim()).filter(Boolean)
            : [],
          description: typeof p.description === "string" ? p.description.trim() : undefined,
          services: p.services && typeof p.services === "object" && !Array.isArray(p.services) ? p.services : undefined,
          verify_pr: p.verify_pr && typeof p.verify_pr === "object" && !Array.isArray(p.verify_pr) ? p.verify_pr : undefined,
          merge_deploy: p.merge_deploy && typeof p.merge_deploy === "object" && !Array.isArray(p.merge_deploy) ? p.merge_deploy : undefined,
        };
      }
    }

    cachedConfig = { mtimeMs: stat.mtimeMs, config, filePath };
    return config;
  } catch (err) {
    return getDefaultProjectsConfig();
  }
}

/**
 * Saves projects.json atomically.
 */
export function saveProjectsConfig(rootDir: string, config: ProjectsConfig): void {
  const filePath = getProjectsFilePath(rootDir);
  const tempPath = path.join(rootDir, `.projects.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);

  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  const payload: ProjectsConfig = {
    version: config.version || "1.0.0",
    default_channel: (config.default_channel || "").trim(),
    projects: config.projects || {},
  };

  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  cachedConfig = null;
}

/**
 * Resolves a project and its target Slack channel ID using strict boundary matching.
 * Never guesses or falls back to an unrelated business channel.
 */
export function resolveProject(
  rootDir: string,
  query: { projectId?: string; projectDir?: string; repo?: string }
): ProjectResolution {
  const config = loadProjectsConfig(rootDir);
  const projects = Object.values(config.projects);

  let projectById: ProjectDefinition | undefined;
  if (query.projectId && query.projectId.trim()) {
    const targetId = query.projectId.trim().toLowerCase();
    projectById = projects.find((p) => p.id.toLowerCase() === targetId);
  }

  let projectByDir: ProjectDefinition | undefined;
  let longestMatchLen = -1;

  if (query.projectDir && query.projectDir.trim()) {
    const targetDir = query.projectDir.trim();
    for (const p of projects) {
      if (!p.paths) continue;
      for (const confPath of p.paths) {
        if (isPathInsideOrEqual(targetDir, confPath)) {
          const normLen = normalizeRealpath(confPath).length;
          if (normLen > longestMatchLen) {
            longestMatchLen = normLen;
            projectByDir = p;
          }
        }
      }
    }
  }

  // 1. Conflict Check: if both specified but resolve to different projects, flag conflict
  if (projectById && projectByDir && projectById.id !== projectByDir.id) {
    return {
      matched: false,
      reason: `Routing conflict: projectId "${projectById.id}" does not match projectDir belonging to "${projectByDir.id}"`,
      conflict: true,
      channelId: config.default_channel || undefined,
    };
  }

  // 2. Explicit projectId match
  if (projectById) {
    return {
      matched: true,
      project: projectById,
      channelId: projectById.slack_channel || config.default_channel || undefined,
      reason: `Matched explicitly by projectId "${projectById.id}"`,
    };
  }

  // 3. Directory / Worktree match
  if (projectByDir) {
    return {
      matched: true,
      project: projectByDir,
      channelId: projectByDir.slack_channel || config.default_channel || undefined,
      reason: `Matched by project working directory (${query.projectDir})`,
    };
  }

  // 4. Repo slug match
  if (query.repo && query.repo.trim()) {
    const targetRepo = query.repo.trim().toLowerCase();
    const projectByRepo = projects.find((p) => p.repo && p.repo.toLowerCase() === targetRepo);
    if (projectByRepo) {
      return {
        matched: true,
        project: projectByRepo,
        channelId: projectByRepo.slack_channel || config.default_channel || undefined,
        reason: `Matched by repo "${projectByRepo.repo}"`,
      };
    }
  }

  // 5. Unmatched
  return {
    matched: false,
    channelId: config.default_channel || undefined,
    reason: query.projectId
      ? `Unknown projectId "${query.projectId}" (not configured in projects.json)`
      : `Unrecognized project directory or repo (no match in projects.json)`,
  };
}
