import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import {
  ProjectDefinition,
  ServiceConfig,
  VerifyPrConfig,
  MergeDeployConfig,
  loadProjectsConfig,
  withProjectsConfigLock,
  validateGitRepoPath,
  validateCallbackHeadersEnvRefs,
  sanitizeProjectForClient,
  findActiveTasksForProject,
  getProjectRepoPath,
  normalizeProjectDefinition,
} from "./project-router.js";

export interface ProjectUpsertInput {
  id?: string;
  project_id?: string;
  name?: string;
  repo_path?: string;
  paths?: string[];
  repo?: string;
  default_base_branch?: string;
  push_remote?: string;
  forbidden_remotes?: string[];
  worktree_root?: string;
  symlink_dirs?: string[];
  default_agent?: string;
  default_model?: string;
  default_account?: string;
  default_timeout_seconds?: number;
  slack_channel?: string;
  slack_webhook_env?: string;
  slack_user_id?: string;
  callback_url?: string;
  callback_headers?: Record<string, string>;
  allowed_env?: string[];
  description?: string;
  services?: Record<string, ServiceConfig>;
  verify_pr?: VerifyPrConfig;
  merge_deploy?: MergeDeployConfig;
}

export function isValidProjectId(id: string): boolean {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id.trim());
}

/**
 * Adds a new project to projects.json after validating repo_path and callback_headers.
 */
export function addProject(
  rootDir: string,
  input: ProjectUpsertInput
): { success: boolean; project?: ProjectDefinition; error?: string } {
  const id = (input.project_id || input.id || "").trim();
  if (!isValidProjectId(id)) {
    return {
      success: false,
      error: `Invalid project id "${input.project_id || input.id || ""}". Must be 1-64 characters containing only letters, numbers, hyphens (-), or underscores (_).`,
    };
  }

  const candidateRepoPath =
    (input.repo_path && input.repo_path.trim()) ||
    (Array.isArray(input.paths) && input.paths.length > 0 ? input.paths[0]?.trim() : "");

  if (!candidateRepoPath) {
    return {
      success: false,
      error: `repo_path (or paths[0]) is required when registering a project.`,
    };
  }

  const pathValidation = validateGitRepoPath(candidateRepoPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    return {
      success: false,
      error: pathValidation.error || `Invalid git repository path: "${candidateRepoPath}"`,
    };
  }

  let sanitizedHeaders = input.callback_headers;
  if (input.callback_headers !== undefined) {
    const hdrCheck = validateCallbackHeadersEnvRefs(input.callback_headers, input.allowed_env);
    if (!hdrCheck.valid) {
      return { success: false, error: hdrCheck.error };
    }
    sanitizedHeaders = hdrCheck.sanitized;
  }

  try {
    return withProjectsConfigLock<{ success: boolean; project?: ProjectDefinition; error?: string }>(rootDir, (config) => {
      const existingKey = Object.keys(config.projects).find((k) => k.toLowerCase() === id.toLowerCase());
      if (existingKey) {
        return {
          save: false,
          result: {
            success: false,
            error: `Project "${existingKey}" already exists. Use update_project to modify it.`,
          },
        };
      }

      const normalized = normalizeProjectDefinition(id, {
        ...input,
        id,
        name: input.name?.trim() || id,
        repo_path: pathValidation.resolvedPath,
        paths: [
          pathValidation.resolvedPath,
          ...(Array.isArray(input.paths) ? input.paths.slice(1) : []),
        ],
        callback_headers: sanitizedHeaders,
      });

      config.projects[id] = normalized;
      return {
        save: true,
        result: {
          success: true,
          project: sanitizeProjectForClient(normalized),
        },
      };
    });
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Updates an existing project in projects.json.
 */
export function updateProject(
  rootDir: string,
  input: Partial<ProjectUpsertInput> & { id?: string; project_id?: string }
): { success: boolean; project?: ProjectDefinition; error?: string } {
  const id = (input.project_id || input.id || "").trim();
  if (!id) {
    return { success: false, error: "Project id is required." };
  }

  try {
    return withProjectsConfigLock<{ success: boolean; project?: ProjectDefinition; error?: string }>(rootDir, (config) => {
      const existingKey = Object.keys(config.projects).find((k) => k.toLowerCase() === id.toLowerCase());
      if (!existingKey) {
        return {
          save: false,
          result: {
            success: false,
            error: `Project "${id}" does not exist in projects.json.`,
          },
        };
      }

      const current = config.projects[existingKey];
      let resolvedRepoPath = getProjectRepoPath(current);

      const nextRepoCandidate =
        input.repo_path !== undefined
          ? input.repo_path.trim()
          : Array.isArray(input.paths) && input.paths.length > 0
            ? input.paths[0].trim()
            : undefined;

      if (nextRepoCandidate !== undefined) {
        if (!nextRepoCandidate) {
          return { save: false, result: { success: false, error: "repo_path cannot be empty." } };
        }
        const pathValidation = validateGitRepoPath(nextRepoCandidate);
        if (!pathValidation.valid || !pathValidation.resolvedPath) {
          return {
            save: false,
            result: {
              success: false,
              error: pathValidation.error || `Invalid git repository path: "${nextRepoCandidate}"`,
            },
          };
        }
        resolvedRepoPath = pathValidation.resolvedPath;
      }

      const effectiveAllowedEnv = input.allowed_env !== undefined ? input.allowed_env : current.allowed_env;
      let nextHeaders = current.callback_headers;
      if (input.callback_headers !== undefined) {
        const hdrCheck = validateCallbackHeadersEnvRefs(input.callback_headers, effectiveAllowedEnv);
        if (!hdrCheck.valid) {
          return { save: false, result: { success: false, error: hdrCheck.error } };
        }
        nextHeaders = hdrCheck.sanitized;
      }

      const mergedRaw = {
        ...current,
        ...input,
        id: current.id,
        name: input.name !== undefined ? (input.name.trim() || current.name) : current.name,
        repo_path: resolvedRepoPath,
        paths: resolvedRepoPath
          ? [
              resolvedRepoPath,
              ...(Array.isArray(input.paths)
                ? input.paths.slice(1)
                : (current.paths || []).filter((p) => p !== resolvedRepoPath)),
            ]
          : current.paths,
        callback_headers: nextHeaders,
        allowed_env: effectiveAllowedEnv,
      };

      const normalized = normalizeProjectDefinition(current.id, mergedRaw);
      config.projects[current.id] = normalized;

      return {
        save: true,
        result: {
          success: true,
          project: sanitizeProjectForClient(normalized),
        },
      };
    });
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Removes a project from projects.json after verifying no tasks are currently running or queued for it.
 */
export function removeProject(
  rootDir: string,
  projectId: string
): { success: boolean; removed?: ProjectDefinition; error?: string } {
  const id = (projectId || "").trim();
  if (!id) {
    return { success: false, error: "Project id is required." };
  }

  try {
    return withProjectsConfigLock<{ success: boolean; removed?: ProjectDefinition; error?: string }>(rootDir, (config) => {
      const existingKey = Object.keys(config.projects).find((k) => k.toLowerCase() === id.toLowerCase());
      if (!existingKey) {
        return {
          save: false,
          result: {
            success: false,
            error: `Project "${id}" not found in projects.json.`,
          },
        };
      }

      const { activeTaskIds, queuedItemIds } = findActiveTasksForProject(rootDir, existingKey);
      if (activeTaskIds.length > 0 || queuedItemIds.length > 0) {
        const parts: string[] = [];
        if (activeTaskIds.length > 0) parts.push(`active/queued tasks: [${activeTaskIds.join(", ")}]`);
        if (queuedItemIds.length > 0) parts.push(`session queue items: [${queuedItemIds.join(", ")}]`);
        return {
          save: false,
          result: {
            success: false,
            error: `Cannot remove project "${existingKey}" while it has running or queued tasks (${parts.join("; ")}). Cancel or finish them first.`,
          },
        };
      }

      const removed = sanitizeProjectForClient(config.projects[existingKey]);
      delete config.projects[existingKey];

      return {
        save: true,
        result: {
          success: true,
          removed,
        },
      };
    });
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

const serviceSchema = z.object({
  name: z.string(),
  command: z.string(),
  port: z.number().int(),
  health_url: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  changed_paths: z.array(z.string()).optional(),
  health_timeout_seconds: z.number().int().optional(),
});

const verifyPrSchema = z.object({
  test_commands: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().optional(),
});

const mergeDeploySchema = z.object({
  checkout_path: z.string().optional(),
  target_branch: z.string().optional(),
  remote: z.string().optional(),
  services: z.array(z.string()).optional(),
});

export function registerProjectTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // 1. add_project
  server.tool(
    "add_project",
    "Register a new project in projects.json with Git repository validation, default branch/remote rules, execution defaults, test/restart config, and env-referenced callback settings.",
    {
      id: z.string().describe("Unique project ID (e.g. 'vision_hub')"),
      name: z.string().optional().describe("Human-readable project name"),
      repo_path: z.string().describe("Absolute path to local main Git repository (validated to exist and be a Git repo)"),
      repo: z.string().optional().describe("Optional GitHub repository slug (e.g. 'owner/repo')"),
      default_base_branch: z.string().optional().describe("Default base branch for worktrees and PRs (e.g. 'develop')"),
      push_remote: z.string().optional().describe("Default Git remote name for pushing (e.g. 'github')"),
      forbidden_remotes: z
        .array(z.string())
        .optional()
        .describe("Forbidden remote URL patterns/domains (matched by URL, e.g. ['gitee.com'])"),
      worktree_root: z.string().optional().describe("Directory where task git worktrees for this project should be created"),
      symlink_dirs: z.array(z.string()).optional().describe("Directories to symlink into worktrees (e.g. ['node_modules'])"),
      default_agent: z.string().optional().describe("Default execution agent (e.g. 'agy-sdk', 'codex', 'agy')"),
      default_model: z.string().optional().describe("Default model for tasks in this project"),
      default_account: z.string().optional().describe("Default account or pool alias for tasks in this project"),
      default_timeout_seconds: z.number().int().positive().optional().describe("Default hard timeout in seconds"),
      slack_channel: z.string().optional().describe("Slack channel ID for notifications"),
      slack_webhook_env: z.string().optional().describe("Environment variable name storing Slack webhook URL"),
      callback_url: z.string().optional().describe("Default completion callback URL"),
      callback_headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Callback HTTP headers referencing whitelisted environment variables (e.g. {'Authorization': 'Bearer $AGENT_BRIDGE_CB_TOKEN'})"),
      allowed_env: z
        .array(z.string())
        .optional()
        .describe("Optional explicit whitelist of environment variable names allowed in callback_headers for this project"),
      description: z.string().optional().describe("Optional project description"),
      verify_pr: verifyPrSchema.optional().describe("PR verification test commands and timeout"),
      merge_deploy: mergeDeploySchema.optional().describe("Merge & deploy target branch, remote, and services to restart"),
      services: z.record(z.string(), serviceSchema).optional().describe("Service definitions (port, command, health_url)"),
    },
    async (args) => {
      audit(rootDir, { tool: "add_project" });
      const res = addProject(rootDir, args as ProjectUpsertInput);
      if (!res.success) {
        logger.warn(`add_project failed for id="${args.id}": ${res.error}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error adding project: ${res.error}` }],
        };
      }
      logger.info(`add_project: registered project "${res.project?.id}" at ${res.project?.repo_path}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, project: res.project }, null, 2),
          },
        ],
      };
    }
  );

  // 2. list_projects
  server.tool(
    "list_projects",
    "List all registered projects in projects.json with their Git settings, execution defaults, test/restart rules, and sanitized callback env references.",
    {
      project_id: z.string().optional().describe("Optional project ID to inspect a single project"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ project_id }) => {
      audit(rootDir, { tool: "list_projects" });
      const config = loadProjectsConfig(rootDir);
      let list = Object.values(config.projects).map((p) => {
        const sanitized = sanitizeProjectForClient(p);
        const repoPath = getProjectRepoPath(p);
        const pathCheck = repoPath ? validateGitRepoPath(repoPath) : { valid: false, error: "No repo_path configured" };
        return {
          ...sanitized,
          repo_path: repoPath,
          path_valid: pathCheck.valid,
          ...(pathCheck.error ? { path_error: pathCheck.error } : {}),
        };
      });

      if (project_id && project_id.trim()) {
        const target = project_id.trim().toLowerCase();
        list = list.filter((p) => p.id.toLowerCase() === target);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: list.length,
                default_channel: config.default_channel || undefined,
                projects: list,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 3. update_project
  server.tool(
    "update_project",
    "Update an existing project's configuration in projects.json. Validates repo_path if changed and enforces env-var references for callback_headers.",
    {
      id: z.string().describe("Project ID to update"),
      name: z.string().optional().describe("Updated project name"),
      repo_path: z.string().optional().describe("Updated local Git repository path (validated to exist and be a Git repo)"),
      repo: z.string().optional().describe("Updated GitHub repository slug"),
      default_base_branch: z.string().optional().describe("Updated default base branch (e.g. 'develop')"),
      push_remote: z.string().optional().describe("Updated default push remote (e.g. 'github')"),
      forbidden_remotes: z.array(z.string()).optional().describe("Updated forbidden remote URL patterns/domains"),
      worktree_root: z.string().optional().describe("Updated worktree root directory"),
      symlink_dirs: z.array(z.string()).optional().describe("Updated symlink directories"),
      default_agent: z.string().optional().describe("Updated default execution agent"),
      default_model: z.string().optional().describe("Updated default model"),
      default_account: z.string().optional().describe("Updated default account or pool alias"),
      default_timeout_seconds: z.number().int().positive().optional().describe("Updated default hard timeout in seconds"),
      slack_channel: z.string().optional().describe("Updated Slack channel ID"),
      slack_webhook_env: z.string().optional().describe("Updated Slack webhook env var name"),
      callback_url: z.string().optional().describe("Updated default callback URL"),
      callback_headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Updated callback headers referencing whitelisted environment variable names only"),
      allowed_env: z
        .array(z.string())
        .optional()
        .describe("Updated explicit whitelist of environment variable names allowed in callback_headers"),
      description: z.string().optional().describe("Updated description"),
      verify_pr: verifyPrSchema.optional().describe("Updated PR verification config"),
      merge_deploy: mergeDeploySchema.optional().describe("Updated merge & deploy config"),
      services: z.record(z.string(), serviceSchema).optional().describe("Updated services map"),
    },
    async (args) => {
      audit(rootDir, { tool: "update_project" });
      const res = updateProject(rootDir, args as Partial<ProjectUpsertInput> & { id: string });
      if (!res.success) {
        logger.warn(`update_project failed for id="${args.id}": ${res.error}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating project: ${res.error}` }],
        };
      }
      logger.info(`update_project: updated project "${res.project?.id}"`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, project: res.project }, null, 2),
          },
        ],
      };
    }
  );

  // 4. remove_project
  server.tool(
    "remove_project",
    "Remove a project from projects.json. Refuses removal if any tasks for this project are currently running or queued.",
    {
      project_id: z.string().optional().describe("Project ID to remove (primary parameter)"),
      id: z.string().optional().describe("Legacy alias for project_id"),
    },
    async ({ project_id, id }) => {
      audit(rootDir, { tool: "remove_project" });
      const targetId = (project_id || id || "").trim();
      const res = removeProject(rootDir, targetId);
      if (!res.success) {
        logger.warn(`remove_project refused for project_id="${targetId}": ${res.error}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error removing project: ${res.error}` }],
        };
      }
      logger.info(`remove_project: removed project "${targetId}"`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, removed: res.removed }, null, 2),
          },
        ],
      };
    }
  );
}
