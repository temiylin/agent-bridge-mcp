import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveBridgeRoot } from "./config.js";
import { readStatus, ACTIVE_STATES } from "./status.js";
import { reconcileTaskStatus } from "./task-reconcile.js";
import { listAllSessionQueues } from "./queue.js";

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
  /** Git remote to fast-forward from (default "origin"). */
  remote?: string;
  services?: string[];
}

export interface ProjectDefinition {
  id: string;
  name: string;
  /** Primary local git repository path (compatible with legacy `paths[0]`). */
  repo_path?: string;
  /** Legacy / multi-path list; `paths[0]` is always kept in sync with `repo_path` when set. */
  paths?: string[];
  /** GitHub slug (`owner/repo`). */
  repo?: string;
  /** Default base branch for worktrees and PRs (e.g. "develop"). */
  default_base_branch?: string;
  /** Default git remote name for pushing (e.g. "github"). */
  push_remote?: string;
  /**
   * Forbidden remote URL patterns/hosts/substrings (matched against `git remote get-url`, e.g. ["gitee.com"]).
   * Push attempts whose resolved remote URL matches any entry are blocked by Bridge tools.
   */
  forbidden_remotes?: string[];
  /** Worktree root directory for this project. */
  worktree_root?: string;
  symlink_dirs?: string[];
  /** Default execution agent (e.g. "agy-sdk", "codex", "agy"). */
  default_agent?: string;
  /** Default model for tasks in this project. */
  default_model?: string;
  /** Default account or pool alias for tasks in this project. */
  default_account?: string;
  /** Default hard timeout in seconds for tasks in this project. */
  default_timeout_seconds?: number;
  slack_channel?: string;
  slack_webhook_env?: string;
  slack_user_id?: string;
  callback_url?: string;
  /**
   * Callback HTTP headers where values reference environment variable names (e.g. "$VISION_HUB_TOKEN" or "VISION_HUB_TOKEN").
   * Never stores raw secret values when edited from the dashboard.
   */
  callback_headers?: Record<string, string>;
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
 * Returns the primary repository path for a project (`repo_path` or `paths[0]`).
 */
export function getProjectRepoPath(proj?: ProjectDefinition | null): string | undefined {
  if (!proj) return undefined;
  if (proj.repo_path && proj.repo_path.trim()) return proj.repo_path.trim();
  if (Array.isArray(proj.paths) && proj.paths.length > 0 && proj.paths[0].trim()) {
    return proj.paths[0].trim();
  }
  return undefined;
}

/**
 * Validates that a filesystem path exists, is a directory, and is a valid Git repository.
 */
export function validateGitRepoPath(repoPath: string): {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
} {
  if (!repoPath || typeof repoPath !== "string" || !repoPath.trim()) {
    return { valid: false, error: "Repository path must be a non-empty string." };
  }
  const resolved = path.resolve(repoPath.trim());
  if (!fs.existsSync(resolved)) {
    return { valid: false, error: `Repository path does not exist: "${resolved}"` };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { valid: false, error: `Repository path is not a directory: "${resolved}"` };
    }
  } catch (err: any) {
    return { valid: false, error: `Cannot access repository path "${resolved}": ${err?.message || String(err)}` };
  }

  // Fast check for .git directory/file or git rev-parse
  const dotGit = path.join(resolved, ".git");
  if (fs.existsSync(dotGit)) {
    return { valid: true, resolvedPath: normalizeRealpath(resolved) };
  }

  const proc = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: resolved,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (proc.status === 0 && proc.stdout.trim() === "true") {
    return { valid: true, resolvedPath: normalizeRealpath(resolved) };
  }

  return {
    valid: false,
    error: `Directory "${resolved}" is not a valid Git repository (git rev-parse failed).`,
  };
}

/**
 * Normalizes a Git remote URL for comparison:
 * e.g. "git@gitee.com:org/repo.git" -> "gitee.com/org/repo"
 *      "https://github.com/org/repo.git/" -> "github.com/org/repo"
 */
export function normalizeGitRemoteUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let s = rawUrl.trim().toLowerCase();
  // Strip protocol (https://, http://, ssh://, git://)
  s = s.replace(/^[a-z0-9+.-]+:\/\//, "");
  // Strip user@ prefix (e.g. git@)
  s = s.replace(/^[^@/]+@/, "");
  // Convert SCP-style host:path (git@gitee.com:org/repo) to host/path
  s = s.replace(/^([^/:]+):/, "$1/");
  // Strip trailing slashes and .git suffix
  s = s.replace(/\/+$/, "").replace(/\.git$/, "");
  return s;
}

/**
 * Resolves the push URL of a remote in `repoDir` via `git remote get-url --push <remote>`.
 * If `remoteOrUrl` is already a URL, returns it directly.
 */
export function getGitRemotePushUrl(repoDir: string, remoteOrUrl: string): string {
  const trimmed = (remoteOrUrl || "").trim();
  if (!trimmed) return "";
  if (
    trimmed.includes("://") ||
    trimmed.startsWith("git@") ||
    trimmed.includes("/")
  ) {
    return trimmed;
  }
  try {
    const pushRes = spawnSync("git", ["remote", "get-url", "--push", trimmed], {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (pushRes.status === 0 && pushRes.stdout.trim()) {
      return pushRes.stdout.trim().split(/\r?\n/)[0].trim();
    }
    const fetchRes = spawnSync("git", ["remote", "get-url", trimmed], {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (fetchRes.status === 0 && fetchRes.stdout.trim()) {
      return fetchRes.stdout.trim().split(/\r?\n/)[0].trim();
    }
  } catch {}
  return "";
}

/**
 * Checks whether pushing to `remoteNameOrUrl` in `repoDir` is forbidden by the project's `forbidden_remotes`.
 * Matching is strictly URL-based (comparing resolved remote URL against forbidden URL/domain/path patterns),
 * with a fallback if the user configured a domain/URL substring like "gitee.com" or full URL.
 * Does NOT modify any git config or hooks in the user's repository.
 */
export function checkForbiddenRemotePush(
  repoDir: string,
  remoteNameOrUrl: string,
  project?: ProjectDefinition
): {
  forbidden: boolean;
  remoteName: string;
  resolvedUrl: string;
  matchedRule?: string;
  reason?: string;
} {
  const remoteName = (remoteNameOrUrl || "origin").trim();
  const resolvedUrl = getGitRemotePushUrl(repoDir, remoteName);
  const forbiddenList = project?.forbidden_remotes || [];
  if (forbiddenList.length === 0) {
    return { forbidden: false, remoteName, resolvedUrl };
  }

  const normActualUrl = normalizeGitRemoteUrl(resolvedUrl);

  for (const rawRule of forbiddenList) {
    const rule = (rawRule || "").trim();
    if (!rule) continue;
    const normRule = normalizeGitRemoteUrl(rule);
    if (!normRule) continue;

    // Match against the resolved remote URL (host, host/org/repo, or substring)
    if (normActualUrl) {
      const actualHost = normActualUrl.split("/")[0];
      if (
        normActualUrl === normRule ||
        actualHost === normRule ||
        actualHost.endsWith(`.${normRule}`) ||
        normActualUrl.startsWith(`${normRule}/`) ||
        normActualUrl.includes(normRule)
      ) {
        return {
          forbidden: true,
          remoteName,
          resolvedUrl,
          matchedRule: rule,
          reason: `Push to remote "${remoteName}" (URL: ${resolvedUrl}) is forbidden by project "${project?.id}" rule "${rule}".${
            project?.push_remote ? ` Allowed push_remote is "${project.push_remote}".` : ""
          }`,
        };
      }
    }

    // If rule itself is a remote name in this repo, resolve THAT remote's URL and compare URLs!
    const ruleResolvedUrl = getGitRemotePushUrl(repoDir, rule);
    if (ruleResolvedUrl && normActualUrl) {
      const normRuleResolved = normalizeGitRemoteUrl(ruleResolvedUrl);
      if (normRuleResolved && normActualUrl === normRuleResolved) {
        return {
          forbidden: true,
          remoteName,
          resolvedUrl,
          matchedRule: rule,
          reason: `Push to remote "${remoteName}" (URL: ${resolvedUrl}) matches forbidden remote URL "${ruleResolvedUrl}" (rule "${rule}") in project "${project?.id}".`,
        };
      }
    }
  }

  return { forbidden: false, remoteName, resolvedUrl };
}

/**
 * Validates that callback_headers only reference environment variable names (e.g. "$TOKEN_ENV" or "TOKEN_ENV"),
 * not raw secret literals.
 */
export function validateCallbackHeadersEnvRefs(
  headers?: Record<string, string>
): { valid: boolean; sanitized?: Record<string, string>; error?: string } {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return { valid: true, sanitized: undefined };
  }
  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    const val = String(rawVal ?? "").trim();
    if (!val) continue;

    // Allow "$ENV_VAR_NAME", "${ENV_VAR_NAME}", or bare "ENV_VAR_NAME" (uppercase/digits/underscores)
    const unwrapped = val.startsWith("${") && val.endsWith("}")
      ? val.slice(2, -1).trim()
      : val.startsWith("$")
        ? val.slice(1).trim()
        : val;

    if (!/^[A-Za-z_][A-Za-z0-9_]{1,127}$/.test(unwrapped)) {
      return {
        valid: false,
        error: `Callback header "${key}" must reference an environment variable name (e.g. "$MY_SECRET_ENV" or "MY_SECRET_ENV"), not a raw secret value.`,
      };
    }
    // Store normalized as "$ENV_VAR_NAME" so resolveCallbackHeaders always reads from process.env
    sanitized[key] = val.startsWith("$") ? val : `$${unwrapped}`;
  }
  return { valid: true, sanitized: Object.keys(sanitized).length > 0 ? sanitized : undefined };
}

/**
 * Normalizes a raw project object into a clean ProjectDefinition while preserving legacy `paths[0]` compatibility.
 */
export function normalizeProjectDefinition(idKey: string, p: any): ProjectDefinition {
  const id = typeof p?.id === "string" && p.id.trim() ? p.id.trim() : idKey.trim();
  const rawPaths = Array.isArray(p?.paths)
    ? p.paths.map((x: any) => String(x).trim()).filter(Boolean)
    : [];
  const rawRepoPath = typeof p?.repo_path === "string" && p.repo_path.trim() ? p.repo_path.trim() : undefined;
  const primaryPath = rawRepoPath || rawPaths[0];
  const mergedPaths = primaryPath
    ? [primaryPath, ...rawPaths.filter((x: string) => x !== primaryPath)]
    : rawPaths;

  const defaultTimeout =
    typeof p?.default_timeout_seconds === "number" && Number.isFinite(p.default_timeout_seconds) && p.default_timeout_seconds > 0
      ? Math.floor(p.default_timeout_seconds)
      : undefined;

  return {
    id,
    name: typeof p?.name === "string" && p.name.trim() ? p.name.trim() : id,
    ...(primaryPath ? { repo_path: primaryPath } : {}),
    paths: mergedPaths,
    repo: typeof p?.repo === "string" && p.repo.trim() ? p.repo.trim() : undefined,
    default_base_branch:
      typeof p?.default_base_branch === "string" && p.default_base_branch.trim()
        ? p.default_base_branch.trim()
        : undefined,
    push_remote:
      typeof p?.push_remote === "string" && p.push_remote.trim() ? p.push_remote.trim() : undefined,
    forbidden_remotes: Array.isArray(p?.forbidden_remotes)
      ? p.forbidden_remotes.map((x: any) => String(x).trim()).filter(Boolean)
      : undefined,
    worktree_root:
      typeof p?.worktree_root === "string" && p.worktree_root.trim() ? p.worktree_root.trim() : undefined,
    symlink_dirs: Array.isArray(p?.symlink_dirs)
      ? p.symlink_dirs.map((x: any) => String(x).trim()).filter(Boolean)
      : undefined,
    default_agent:
      typeof p?.default_agent === "string" && p.default_agent.trim() ? p.default_agent.trim() : undefined,
    default_model:
      typeof p?.default_model === "string" && p.default_model.trim() ? p.default_model.trim() : undefined,
    default_account:
      typeof p?.default_account === "string" && p.default_account.trim() ? p.default_account.trim() : undefined,
    ...(defaultTimeout ? { default_timeout_seconds: defaultTimeout } : {}),
    slack_channel:
      typeof p?.slack_channel === "string" && p.slack_channel.trim() ? p.slack_channel.trim() : undefined,
    slack_webhook_env:
      typeof p?.slack_webhook_env === "string" && p.slack_webhook_env.trim()
        ? p.slack_webhook_env.trim()
        : undefined,
    slack_user_id:
      typeof p?.slack_user_id === "string" && p.slack_user_id.trim() ? p.slack_user_id.trim() : undefined,
    callback_url:
      typeof p?.callback_url === "string" && p.callback_url.trim() ? p.callback_url.trim() : undefined,
    callback_headers:
      p?.callback_headers && typeof p.callback_headers === "object" && !Array.isArray(p.callback_headers)
        ? p.callback_headers
        : undefined,
    description:
      typeof p?.description === "string" && p.description.trim() ? p.description.trim() : undefined,
    services:
      p?.services && typeof p.services === "object" && !Array.isArray(p.services) ? p.services : undefined,
    verify_pr:
      p?.verify_pr && typeof p.verify_pr === "object" && !Array.isArray(p.verify_pr) ? p.verify_pr : undefined,
    merge_deploy:
      p?.merge_deploy && typeof p.merge_deploy === "object" && !Array.isArray(p.merge_deploy)
        ? p.merge_deploy
        : undefined,
  };
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
        const def = normalizeProjectDefinition(key, val);
        config.projects[def.id] = def;
      }
    }

    cachedConfig = { mtimeMs: stat.mtimeMs, config, filePath };
    return config;
  } catch {
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

  const normalizedProjects: Record<string, ProjectDefinition> = {};
  for (const [k, v] of Object.entries(config.projects || {})) {
    if (!v || typeof v !== "object") continue;
    const norm = normalizeProjectDefinition(k, v);
    normalizedProjects[norm.id] = norm;
  }

  const payload: ProjectsConfig = {
    version: config.version || "1.0.0",
    default_channel: (config.default_channel || "").trim(),
    projects: normalizedProjects,
  };

  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  cachedConfig = null;
}

/**
 * Returns a sanitized view of a ProjectDefinition for API / UI responses:
 * callback_headers values are strictly exposed only as environment variable reference names (e.g. "$ENV_NAME"),
 * never resolving or leaking actual secret values from process.env.
 */
export function sanitizeProjectForClient(proj: ProjectDefinition): ProjectDefinition {
  const clone: ProjectDefinition = { ...proj };
  if (clone.callback_headers && typeof clone.callback_headers === "object") {
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(clone.callback_headers)) {
      const raw = String(v ?? "").trim();
      if (!raw) continue;
      const envName = raw.startsWith("${") && raw.endsWith("}")
        ? raw.slice(2, -1).trim()
        : raw.startsWith("$")
          ? raw.slice(1).trim()
          : raw;
      if (/^[A-Za-z_][A-Za-z0-9_]{1,127}$/.test(envName)) {
        safeHeaders[k] = `$${envName}`;
      } else {
        safeHeaders[k] = "$REDACTED_SECRET";
      }
    }
    clone.callback_headers = safeHeaders;
  }
  return clone;
}

/**
 * Finds any active (running / suspected_stalled / queued / paused_quota) tasks or queued session items
 * belonging to the given project. Used to prevent deleting a project while tasks are running or queued.
 */
export function findActiveTasksForProject(
  rootDir: string,
  projectId: string
): { activeTaskIds: string[]; queuedItemIds: string[] } {
  const targetId = projectId.trim().toLowerCase();
  const config = loadProjectsConfig(rootDir);
  const proj = Object.values(config.projects).find((p) => p.id.toLowerCase() === targetId);
  const targetName = proj?.name?.trim().toLowerCase();

  const statusDir = path.join(rootDir, "status");
  const tasksDir = path.join(rootDir, "tasks");
  const activeTaskIds: string[] = [];

  if (fs.existsSync(statusDir)) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(statusDir);
    } catch {}
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      const taskId = f.replace(/\.json$/, "");
      let st = readStatus(rootDir, taskId);
      if (!st) continue;
      if (ACTIVE_STATES.includes(st.state)) {
        st = reconcileTaskStatus(rootDir, { taskId, ...st });
      }
      if (!["running", "suspected_stalled", "queued", "paused_quota"].includes(st.state)) {
        continue;
      }

      let taskProjId = (st.projectId || "").trim().toLowerCase();
      let taskProjName = (st.projectName || "").trim().toLowerCase();
      if (!taskProjId && !taskProjName) {
        const tf = path.join(tasksDir, `${taskId}.md`);
        if (fs.existsSync(tf)) {
          try {
            const content = fs.readFileSync(tf, "utf8");
            const idM = content.match(/^-[ \t]*\*\*Project ID\*\*:[ \t]*([^\r\n]*)$/im);
            if (idM) taskProjId = idM[1].trim().toLowerCase();
            const nameM = content.match(/^-[ \t]*\*\*Project Name\*\*:[ \t]*([^\r\n]*)$/im);
            if (nameM) taskProjName = nameM[1].trim().toLowerCase();
          } catch {}
        }
      }

      if (
        (taskProjId && taskProjId === targetId) ||
        (targetName && (taskProjName === targetName || taskProjId === targetName))
      ) {
        activeTaskIds.push(taskId);
      }
    }
  }

  // Also check un-dispatched task files in tasks/ that don't have a status file yet
  if (fs.existsSync(tasksDir)) {
    try {
      for (const f of fs.readdirSync(tasksDir)) {
        if (!f.endsWith(".md")) continue;
        const taskId = f.replace(/\.md$/, "");
        if (activeTaskIds.includes(taskId)) continue;
        if (fs.existsSync(path.join(statusDir, `${taskId}.json`))) continue;
        if (fs.existsSync(path.join(rootDir, "results", `${taskId}.md`))) continue;
        const content = fs.readFileSync(path.join(tasksDir, f), "utf8");
        const idM = content.match(/^-[ \t]*\*\*Project ID\*\*:[ \t]*([^\r\n]*)$/im);
        const taskProjId = idM ? idM[1].trim().toLowerCase() : "";
        if (taskProjId === targetId) {
          activeTaskIds.push(taskId);
        }
      }
    } catch {}
  }

  const queuedItemIds: string[] = [];
  try {
    const queues = listAllSessionQueues(rootDir);
    for (const q of queues) {
      for (const item of q.items) {
        if (item.status === "dispatched") continue;
        const optProj = String(
          item.options?.project_id || item.options?.project || item.options?.projectName || ""
        )
          .trim()
          .toLowerCase();
        if (optProj && (optProj === targetId || (targetName && optProj === targetName))) {
          queuedItemIds.push(item.id);
        }
      }
    }
  } catch {}

  return { activeTaskIds, queuedItemIds };
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
      const candidatePaths = [
        ...(p.repo_path ? [p.repo_path] : []),
        ...(Array.isArray(p.paths) ? p.paths : []),
      ];
      for (const confPath of candidatePaths) {
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

/**
 * Builds a concise prompt appendix reminding the agent of the project's Git branch/remote rules
 * without touching the main repository's `.git/config` or hooks.
 */
export function buildProjectGitRulesPromptNote(project?: ProjectDefinition): string {
  if (!project) return "";
  const lines: string[] = [];
  if (project.default_base_branch) {
    lines.push(`- Default base branch: \`${project.default_base_branch}\``);
  }
  if (project.push_remote) {
    lines.push(`- Designated Git push remote: \`${project.push_remote}\``);
  }
  if (project.forbidden_remotes && project.forbidden_remotes.length > 0) {
    lines.push(
      `- FORBIDDEN Git push remotes/URLs (NEVER push to any remote matching these URLs): ${project.forbidden_remotes
        .map((r) => `\`${r}\``)
        .join(", ")}`
    );
  }
  if (lines.length === 0) return "";
  return `\n\n[Project Git Constraints (${project.id})]\n${lines.join("\n")}\n`;
}
