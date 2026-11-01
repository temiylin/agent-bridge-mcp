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
   * Callback HTTP headers where values reference whitelisted environment variable names
   * (must match `^AGENT_BRIDGE_CB_[A-Z0-9_]+$` or be listed in `allowed_env`),
   * optionally with a scheme prefix such as `"Bearer $AGENT_BRIDGE_CB_TOKEN"`.
   * Never stores raw secret values.
   */
  callback_headers?: Record<string, string>;
  /**
   * Optional explicit whitelist of environment variable names allowed in `callback_headers` for this project.
   * Built-in sensitive system/credential env vars (e.g. HOME, PATH, GITHUB_TOKEN) are always forbidden.
   */
  allowed_env?: string[];
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
 * Parses a Git remote URL or rule into `{ host, path }` (lowercased, port stripped, trailing `.git` stripped).
 * Correctly handles:
 * - `https://github.com/org/repo.git` -> `{ host: "github.com", path: "org/repo" }`
 * - `ssh://git@gitlab.example.com:2222/org/repo.git` -> `{ host: "gitlab.example.com", path: "org/repo" }`
 * - `git@gitee.com:org/repo.git` -> `{ host: "gitee.com", path: "org/repo" }`
 * - `gitee.com` -> `{ host: "gitee.com", path: "" }`
 * - `gitee.com/org` -> `{ host: "gitee.com", path: "org" }`
 */
export function parseGitRemoteUrlParts(rawUrl: string): { host: string; path: string; normalized: string } {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { host: "", path: "", normalized: "" };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { host: "", path: "", normalized: "" };
  }

  let host = "";
  let urlPath = "";

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      host = (parsed.hostname || "").toLowerCase();
      urlPath = decodeURIComponent(parsed.pathname || "");
    } catch {
      // Fallback if URL constructor fails
      let rest = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
      rest = rest.replace(/^[^@/]+@/, "");
      const slashIdx = rest.indexOf("/");
      const hostPort = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
      host = hostPort.replace(/:\d+$/, "").toLowerCase();
      urlPath = slashIdx >= 0 ? rest.slice(slashIdx + 1) : "";
    }
  } else {
    let rest = trimmed.replace(/^[^@/]+@/, "");
    const colonIdx = rest.indexOf(":");
    const slashIdx = rest.indexOf("/");
    if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
      const hostPart = rest.slice(0, colonIdx);
      const afterColon = rest.slice(colonIdx + 1);
      // Handle accidental host:port/path without scheme vs SCP host:path
      if (/^\d+\//.test(afterColon)) {
        host = hostPart.toLowerCase();
        urlPath = afterColon.replace(/^\d+\//, "");
      } else {
        host = hostPart.toLowerCase();
        urlPath = afterColon;
      }
    } else if (slashIdx > 0) {
      host = rest.slice(0, slashIdx).replace(/:\d+$/, "").toLowerCase();
      urlPath = rest.slice(slashIdx + 1);
    } else {
      host = rest.replace(/:\d+$/, "").toLowerCase();
      urlPath = "";
    }
  }

  urlPath = urlPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

  const normalized = urlPath ? `${host}/${urlPath}` : host;
  return { host, path: urlPath, normalized };
}

/**
 * Normalizes a Git remote URL for comparison:
 * e.g. "git@gitee.com:org/repo.git" -> "gitee.com/org/repo"
 *      "ssh://git@gitee.com:2222/org/repo.git" -> "gitee.com/org/repo"
 *      "https://github.com/org/repo.git/" -> "github.com/org/repo"
 */
export function normalizeGitRemoteUrl(rawUrl: string): string {
  return parseGitRemoteUrlParts(rawUrl).normalized;
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
 * Checks whether a parsed actual remote URL (`actual`) matches a parsed forbidden rule (`ruleParts`).
 * Strictly allows ONLY:
 * 1. Host exact match (`actual.host === ruleParts.host`) or subdomain match (`actual.host.endsWith("." + ruleParts.host)`)
 * 2. When `ruleParts.path` is non-empty, `actual.path` must also match `ruleParts.path` exactly or as a `/`-delimited prefix (`actual.path.startsWith(ruleParts.path + "/")`).
 * Never uses loose substring `.includes()` matching (so `github.com/org/gitee-sync` or `github.com.evil` will NOT false-match).
 */
function matchesParsedRemoteRule(
  actual: { host: string; path: string },
  ruleParts: { host: string; path: string }
): boolean {
  if (!actual.host || !ruleParts.host) return false;
  const hostMatches =
    actual.host === ruleParts.host || actual.host.endsWith(`.${ruleParts.host}`);
  if (!hostMatches) return false;

  if (!ruleParts.path) {
    return true;
  }
  if (!actual.path) {
    return false;
  }
  return (
    actual.path === ruleParts.path || actual.path.startsWith(`${ruleParts.path}/`)
  );
}

/**
 * Checks whether pushing to `remoteNameOrUrl` in `repoDir` is forbidden by the project's `forbidden_remotes`.
 * Matching is strictly URL-based (host exact/subdomain match, or host + path-prefix match; no loose substring match).
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

  const actualParts = parseGitRemoteUrlParts(resolvedUrl);

  for (const rawRule of forbiddenList) {
    const rule = (rawRule || "").trim();
    if (!rule) continue;

    // If rule is a configured remote name in this repo (without '.' or '/'), resolve that remote's URL first
    let ruleParts = parseGitRemoteUrlParts(rule);
    if (!rule.includes(".") && !rule.includes("/") && !rule.includes(":")) {
      const namedRemoteUrl = getGitRemotePushUrl(repoDir, rule);
      if (namedRemoteUrl) {
        ruleParts = parseGitRemoteUrlParts(namedRemoteUrl);
      } else {
        continue;
      }
    }

    if (actualParts.host && matchesParsedRemoteRule(actualParts, ruleParts)) {
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

  return { forbidden: false, remoteName, resolvedUrl };
}

export const CALLBACK_ENV_PREFIX_REGEX = /^AGENT_BRIDGE_CB_[A-Z0-9_]+$/;

export const FORBIDDEN_CALLBACK_ENV_NAMES = new Set<string>([
  "HOME",
  "USERPROFILE",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "SSH_AUTH_SOCK",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "DEVICE_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_WEBHOOK_URL",
  "NPM_TOKEN",
  "NODE_OPTIONS",
]);

export function isAllowedCallbackEnvVarName(
  envName: string,
  allowedEnv?: string[]
): { allowed: boolean; reason?: string } {
  const trimmed = (envName || "").trim();
  if (!/^[A-Z_][A-Z0-9_]{1,127}$/.test(trimmed)) {
    return {
      allowed: false,
      reason: `Environment variable name "${envName}" must be uppercase letters, digits, and underscores.`,
    };
  }
  if (FORBIDDEN_CALLBACK_ENV_NAMES.has(trimmed)) {
    return {
      allowed: false,
      reason: `Environment variable "${trimmed}" is a protected system/credential variable and cannot be referenced in callback_headers.`,
    };
  }
  if (CALLBACK_ENV_PREFIX_REGEX.test(trimmed)) {
    return { allowed: true };
  }
  if (Array.isArray(allowedEnv) && allowedEnv.map((x) => String(x).trim()).includes(trimmed)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Environment variable "${trimmed}" is not whitelisted. Variable names must match ^AGENT_BRIDGE_CB_[A-Z0-9_]+$ or be explicitly listed in project allowed_env.`,
  };
}

/**
 * Validates that callback_headers only reference whitelisted environment variable names:
 * - Supports `"$VAR"`, `"${VAR}"`, bare `"VAR"`, or scheme-prefixed `"Bearer $VAR"` / `"Token ${VAR}"`.
 * - Every referenced variable must match `^AGENT_BRIDGE_CB_[A-Z0-9_]+$` or be in `allowedEnv` (and never in `FORBIDDEN_CALLBACK_ENV_NAMES`).
 * - Raw secret literals without `$VAR` reference are strictly rejected.
 */
export function validateCallbackHeadersEnvRefs(
  headers?: Record<string, string>,
  allowedEnv?: string[]
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

    // Case 1: Bare variable name without '$' (e.g. "AGENT_BRIDGE_CB_TOKEN")
    if (!val.includes("$")) {
      if (!/^[A-Z_][A-Z0-9_]{1,127}$/.test(val)) {
        return {
          valid: false,
          error: `Callback header "${key}" must reference a whitelisted environment variable (e.g. "$AGENT_BRIDGE_CB_TOKEN" or "Bearer $AGENT_BRIDGE_CB_TOKEN"), not a raw literal.`,
        };
      }
      const check = isAllowedCallbackEnvVarName(val, allowedEnv);
      if (!check.allowed) {
        return { valid: false, error: `Callback header "${key}": ${check.reason}` };
      }
      sanitized[key] = `$${val}`;
      continue;
    }

    // Case 2: Contains "$VAR" or "${VAR}" (e.g. "$AGENT_BRIDGE_CB_TOKEN" or "Bearer $AGENT_BRIDGE_CB_TOKEN")
    // Allow only optional scheme prefix like "Bearer " or "Token " or "Basic " followed by a single $VAR / ${VAR}, or exact "$VAR" / "${VAR}"
    const templateMatch = val.match(/^(?:([A-Za-z0-9._-]+)\s+)?\$(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))$/);
    if (!templateMatch) {
      return {
        valid: false,
        error: `Callback header "${key}" has invalid format "${val}". Expected "$AGENT_BRIDGE_CB_XXX" or "Bearer $AGENT_BRIDGE_CB_XXX".`,
      };
    }

    const prefix = templateMatch[1];
    const envName = templateMatch[2] || templateMatch[3];
    const check = isAllowedCallbackEnvVarName(envName, allowedEnv);
    if (!check.allowed) {
      return { valid: false, error: `Callback header "${key}": ${check.reason}` };
    }

    sanitized[key] = prefix ? `${prefix} $${envName}` : `$${envName}`;
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
    allowed_env: Array.isArray(p?.allowed_env)
      ? p.allowed_env.map((x: any) => String(x).trim()).filter(Boolean)
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
 * Strictly reads and parses projects.json without swallowing syntax/schema errors.
 * Throws if projects.json exists and cannot be parsed as a valid ProjectsConfig object.
 */
export function loadProjectsConfigStrict(rootDir: string = resolveBridgeRoot()): ProjectsConfig {
  const filePath = getProjectsFilePath(rootDir);
  if (!fs.existsSync(filePath)) {
    const defaults = getDefaultProjectsConfig();
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Failed to parse projects.json at "${filePath}": ${err?.message || String(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid projects.json at "${filePath}": root must be a JSON object.`);
  }
  if (parsed.projects !== undefined && (!parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects))) {
    throw new Error(`Invalid projects.json at "${filePath}": "projects" field must be a JSON object.`);
  }

  const config: ProjectsConfig = {
    version: typeof parsed.version === "string" ? parsed.version : "1.0.0",
    default_channel: typeof parsed.default_channel === "string" ? parsed.default_channel.trim() : "",
    projects: {},
  };

  if (parsed.projects) {
    for (const [key, val] of Object.entries(parsed.projects)) {
      if (!val || typeof val !== "object" || Array.isArray(val)) {
        throw new Error(`Invalid project entry "${key}" in projects.json: must be an object.`);
      }
      const def = normalizeProjectDefinition(key, val);
      config.projects[def.id] = def;
    }
  }

  return config;
}

/**
 * Loads projects.json from rootDir with hot-reloading cache.
 */
export function loadProjectsConfig(rootDir: string = resolveBridgeRoot()): ProjectsConfig {
  const filePath = getProjectsFilePath(rootDir);

  try {
    if (!fs.existsSync(filePath)) {
      return loadProjectsConfigStrict(rootDir);
    }

    const stat = fs.statSync(filePath);
    if (cachedConfig && cachedConfig.filePath === filePath && cachedConfig.mtimeMs === stat.mtimeMs) {
      return cachedConfig.config;
    }

    const config = loadProjectsConfigStrict(rootDir);
    cachedConfig = { mtimeMs: stat.mtimeMs, config, filePath };
    return config;
  } catch {
    return getDefaultProjectsConfig();
  }
}

function writeProjectsConfigUnchecked(rootDir: string, config: ProjectsConfig): void {
  const filePath = getProjectsFilePath(rootDir);
  const bakPath = `${filePath}.bak`;
  const tempPath = path.join(rootDir, `.projects.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);

  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, bakPath);
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
 * Acquires an exclusive file lock (`projects.json.lock` via `O_CREAT | O_EXCL`) with retries,
 * re-reads and strictly validates `projects.json` inside the lock, runs `mutator(config)`,
 * backs up `projects.json` to `projects.json.bak`, and atomically writes the updated config.
 * If `projects.json` is corrupt/unparseable, refuses to overwrite and leaves the original file untouched.
 */
export function withProjectsConfigLock<T>(
  rootDir: string,
  mutator: (config: ProjectsConfig) => { save: boolean; result: T }
): T {
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  const lockPath = path.join(rootDir, "projects.json.lock");
  const maxAttempts = 50;
  const retryDelayMs = 40;
  const staleLockMs = 15000;
  let lockFd: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(lockFd, `${process.pid}:${Date.now()}\n`);
      break;
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > staleLockMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
        if (attempt === maxAttempts) {
          throw new Error(`Timed out waiting for projects.json lock at "${lockPath}"`);
        }
        // Synchronous short sleep using Atomics.wait
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, retryDelayMs);
        continue;
      }
      throw err;
    }
  }

  try {
    const config = loadProjectsConfigStrict(rootDir);
    const { save, result } = mutator(config);
    if (save) {
      writeProjectsConfigUnchecked(rootDir, config);
    }
    return result;
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
    }
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  }
}

/**
 * Saves projects.json atomically (with lock, strict validation of existing file, and .bak backup).
 */
export function saveProjectsConfig(rootDir: string, config: ProjectsConfig): void {
  withProjectsConfigLock(rootDir, () => ({ save: true, result: undefined }));
  writeProjectsConfigUnchecked(rootDir, config);
}

/**
 * Returns a sanitized view of a ProjectDefinition for API / UI responses:
 * callback_headers values are strictly exposed only as environment variable reference names (e.g. "$ENV_NAME" or "Bearer $ENV_NAME"),
 * never resolving or leaking actual secret values from process.env.
 */
export function sanitizeProjectForClient(proj: ProjectDefinition): ProjectDefinition {
  const clone: ProjectDefinition = { ...proj };
  if (clone.callback_headers && typeof clone.callback_headers === "object") {
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(clone.callback_headers)) {
      const raw = String(v ?? "").trim();
      if (!raw) continue;
      const templateMatch = raw.match(/^(?:([A-Za-z0-9._-]+)\s+)?\$?(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))$/);
      if (templateMatch) {
        const prefix = templateMatch[1];
        const envName = templateMatch[2] || templateMatch[3];
        safeHeaders[k] = prefix ? `${prefix} $${envName}` : `$${envName}`;
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
