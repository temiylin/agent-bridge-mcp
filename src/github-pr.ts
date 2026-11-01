import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { isBlockedCredentialPath } from "./local-fs.js";
import { resolveProject, getProjectRepoPath } from "./project-router.js";
import { attachPrToTask } from "./status.js";

function resolveGhPath(): string | null {
  const isWin = process.platform === "win32";
  const lookup = isWin ? "where" : "which";
  const res = spawnSync(lookup, ["gh"], { encoding: "utf8", windowsHide: true });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim().split(/\r?\n/)[0];
  }
  // Common paths fallback
  const common = isWin
    ? ["C:\\Program Files\\GitHub CLI\\gh.exe"]
    : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  for (const p of common) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runGhCommand(
  args: string[],
  cwd: string,
  timeoutMs: number = 45000
): { stdout: string; stderr: string; exitCode: number } {
  const ghBin = resolveGhPath();
  if (!ghBin) {
    return {
      stdout: "",
      stderr: "GitHub CLI (gh) is not installed on host. Please install it with 'brew install gh' or via https://cli.github.com/.",
      exitCode: 127,
    };
  }

  const proc = spawnSync(ghBin, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    },
  });

  return {
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
    exitCode: proc.status ?? (proc.error ? 1 : 0),
  };
}

function resolveCwd(rootDir: string, repoPath?: string): string {
  if (repoPath && typeof repoPath === "string" && repoPath.trim().length > 0) {
    return path.resolve(repoPath.trim());
  }
  const envRepo = process.env.AGENT_BRIDGE_REPO;
  if (envRepo && typeof envRepo === "string" && envRepo.trim().length > 0) {
    return path.resolve(envRepo.trim());
  }
  return path.resolve(rootDir);
}

export function registerGitHubPrTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // 1. pr_list
  server.tool(
    "pr_list",
    "List pull requests for a GitHub repository (supports private repositories using host credentials).",
    {
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'owner/repo'). If omitted, uses local Git remote."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
      state: z.enum(["open", "closed", "merged", "all"]).optional().describe("PR state filter: 'open' (default), 'closed', 'merged', or 'all'."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of PRs to return (default: 15, max: 50)."),
    },
    async ({ repo, repo_path, state = "open", limit = 15 }) => {
      audit(rootDir, { tool: "pr_list" });
      const cwd = resolveCwd(rootDir, repo_path);

      const args = [
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        String(Math.min(50, limit)),
        "--json",
        "number,title,state,author,headRefName,baseRefName,updatedAt,url",
      ];
      if (repo && repo.trim()) {
        args.push("--repo", repo.trim());
      }

      const res = runGhCommand(args, cwd);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `GitHub CLI error (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      let parsed: any[] = [];
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        parsed = [];
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                repo: repo || "local remote",
                state,
                count: parsed.length,
                pull_requests: parsed,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 2. pr_view
  server.tool(
    "pr_view",
    "View detailed information, body description, and discussion comments (including Codex P0/P1/P2 reviews) for a Pull Request.",
    {
      pr_number: z.union([z.number(), z.string()]).optional().describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      pr: z.union([z.number(), z.string()]).optional().describe("Alias of pr_number"),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'owner/repo')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
      include_comments: z.boolean().optional().describe("Whether to include discussion comments and review findings (default: true)."),
    },
    async ({ pr_number: prNumberArg, pr: prAlias, repo, repo_path, include_comments = true }) => {
      audit(rootDir, { tool: "pr_view" });
      const pr_number = prNumberArg ?? prAlias;
      if (pr_number === undefined || String(pr_number).trim() === "") {
        return { isError: true, content: [{ type: "text", text: "Error: pr_number (or pr) is required." }] };
      }
      const cwd = resolveCwd(rootDir, repo_path);

      const jsonFields = [
        "number",
        "title",
        "body",
        "state",
        "author",
        "baseRefName",
        "headRefName",
        "url",
        "createdAt",
        "updatedAt",
        "labels",
        "reviewDecision",
        "latestReviews",
        "additions",
        "deletions",
        "changedFiles",
      ];
      if (include_comments) {
        jsonFields.push("comments");
      }

      const args = ["pr", "view", String(pr_number).trim(), "--json", jsonFields.join(",")];
      if (repo && repo.trim()) {
        args.push("--repo", repo.trim());
      }

      const res = runGhCommand(args, cwd);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `GitHub CLI error (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      try {
        const prData = JSON.parse(res.stdout);
        // Format comments nicely
        if (Array.isArray(prData.comments)) {
          prData.comments = prData.comments.map((c: any) => ({
            author: c.author?.login || "unknown",
            createdAt: c.createdAt,
            body: c.body,
          }));
        }

        return {
          content: [{ type: "text", text: JSON.stringify(prData, null, 2) }],
        };
      } catch {
        return { content: [{ type: "text", text: res.stdout }] };
      }
    }
  );

  // 3. pr_diff
  server.tool(
    "pr_diff",
    "Get the unified code diff for a Pull Request to perform in-depth code review directly in chat.",
    {
      pr_number: z.union([z.number(), z.string()]).optional().describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      pr: z.union([z.number(), z.string()]).optional().describe("Alias of pr_number"),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'owner/repo')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
      max_bytes: z.number().int().min(500).max(128000).optional().describe("Maximum bytes to return (default: 48000)."),
    },
    async ({ pr_number: prNumberArg, pr: prAlias, repo, repo_path, max_bytes = 48000 }) => {
      audit(rootDir, { tool: "pr_diff" });
      const pr_number = prNumberArg ?? prAlias;
      if (pr_number === undefined || String(pr_number).trim() === "") {
        return { isError: true, content: [{ type: "text", text: "Error: pr_number (or pr) is required." }] };
      }
      const cwd = resolveCwd(rootDir, repo_path);

      const args = ["pr", "diff", String(pr_number).trim()];
      if (repo && repo.trim()) {
        args.push("--repo", repo.trim());
      }

      const res = runGhCommand(args, cwd);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `GitHub CLI error (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      let diff = res.stdout;
      const isTruncated = diff.length > max_bytes;
      if (isTruncated) {
        diff = diff.slice(0, max_bytes) + `\n\n... [Diff truncated: exceeded max_bytes=${max_bytes}]`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                pr_number,
                repo: repo || "local remote",
                truncated: isTruncated,
                diff: diff || "(empty diff)",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 4. pr_checks
  server.tool(
    "pr_checks",
    "Inspect CI / GitHub Actions status and check suites for a Pull Request.",
    {
      pr_number: z.union([z.number(), z.string()]).optional().describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      pr: z.union([z.number(), z.string()]).optional().describe("Alias of pr_number"),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'owner/repo')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
    },
    async ({ pr_number: prNumberArg, pr: prAlias, repo, repo_path }) => {
      audit(rootDir, { tool: "pr_checks" });
      const pr_number = prNumberArg ?? prAlias;
      if (pr_number === undefined || String(pr_number).trim() === "") {
        return { isError: true, content: [{ type: "text", text: "Error: pr_number (or pr) is required." }] };
      }
      const cwd = resolveCwd(rootDir, repo_path);

      const args = [
        "pr",
        "checks",
        String(pr_number).trim(),
        "--json",
        "name,state,bucket,description,link,workflow",
      ];
      if (repo && repo.trim()) {
        args.push("--repo", repo.trim());
      }

      const res = runGhCommand(args, cwd);
      // exit code 8 means checks pending, which is valid
      if (res.exitCode !== 0 && res.exitCode !== 8) {
        return {
          isError: true,
          content: [{ type: "text", text: `GitHub CLI error (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      let checks: any[] = [];
      try {
        checks = JSON.parse(res.stdout);
      } catch {
        checks = [];
      }

      const passCount = checks.filter((c) => c.bucket === "pass").length;
      const failCount = checks.filter((c) => c.bucket === "fail").length;
      const pendingCount = checks.filter((c) => c.bucket === "pending").length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                pr_number,
                total_checks: checks.length,
                all_passed: failCount === 0 && pendingCount === 0 && checks.length > 0,
                summary: `${passCount} passed, ${failCount} failed, ${pendingCount} pending`,
                checks,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 5. pr_create
  server.tool(
    "pr_create",
    "Push local branch (if needed) and create a Pull Request on GitHub with a title and Markdown description.",
    {
      project_id: z.string().optional().describe("Optional project ID to resolve repo_path, default_base_branch, and GitHub repo slug."),
      title: z.string().describe("Pull request title"),
      body: z.string().optional().describe("Pull request body description in Markdown"),
      base: z.string().optional().describe("Target base branch, e.g. 'develop' or 'main' (defaults to project default_base_branch)"),
      head: z.string().optional().describe("Head branch containing commits (defaults to current branch)"),
      draft: z.boolean().optional().describe("Whether to create the PR as a draft. Default: false."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'owner/repo')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
      task_id: z.string().optional().describe("Optional task ID to automatically attach this newly created PR to."),
    },
    async ({ project_id, title, body = "", base, head, draft, repo, repo_path, task_id }) => {
      audit(rootDir, { tool: "pr_create", ...(task_id ? { taskId: task_id.trim() } : {}) });
      const projRes = resolveProject(rootDir, { projectId: project_id, projectDir: repo_path, repo });
      const proj = projRes.project;
      const cwd = resolveCwd(rootDir, repo_path || getProjectRepoPath(proj));
      const effectiveBase = (base && base.trim()) || proj?.default_base_branch;
      const effectiveRepo = (repo && repo.trim()) || proj?.repo;

      const args = ["pr", "create", "--title", title.trim(), "--body", body.trim()];
      if (effectiveBase) {
        args.push("--base", effectiveBase);
      }
      if (head && head.trim()) {
        args.push("--head", head.trim());
      }
      if (draft) {
        args.push("--draft");
      }
      if (effectiveRepo) {
        args.push("--repo", effectiveRepo);
      }

      const res = runGhCommand(args, cwd, 60000);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create PR (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      const prUrl = res.stdout.trim();
      let attachedToTask = false;
      if (task_id && task_id.trim()) {
        try {
          attachPrToTask(rootDir, task_id.trim(), prUrl);
          attachedToTask = true;
          logger.info(`pr_create: automatically attached PR ${prUrl} to task ${task_id.trim()}`);
        } catch (err: any) {
          logger.warn(`pr_create: failed to auto-attach PR ${prUrl} to task ${task_id.trim()}: ${err?.message || String(err)}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                title: title.trim(),
                url: prUrl,
                ...(task_id ? { task_id: task_id.trim(), attached_to_task: attachedToTask } : {}),
                message: `✅ Pull Request created successfully: ${prUrl}${attachedToTask && task_id ? ` (attached to task ${task_id.trim()})` : ""}`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 5b. attach_pr_to_task
  server.tool(
    "attach_pr_to_task",
    "Attach or append a GitHub Pull Request URL to an existing task and its execution plan step (if any). Updates task status and marks review stage.",
    {
      task_id: z.string().describe("Task ID to attach the PR to"),
      pr_url: z.string().describe("GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)"),
      plan_id: z.string().optional().describe("Optional plan ID if task is not already tagged"),
      step_id: z.string().optional().describe("Optional step ID within the plan"),
    },
    async ({ task_id, pr_url, plan_id, step_id }) => {
      audit(rootDir, { tool: "attach_pr_to_task", taskId: task_id.trim() });
      try {
        const cleanTaskId = task_id.trim();
        const cleanPrUrl = pr_url.trim();
        const res = attachPrToTask(rootDir, cleanTaskId, cleanPrUrl, { planId: plan_id, stepId: step_id });
        logger.info(`attach_pr_to_task: attached PR ${cleanPrUrl} to task ${cleanTaskId} (planUpdated=${res.planUpdated})`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  task_id: cleanTaskId,
                  pr_url: cleanPrUrl,
                  pr_urls: res.status.pr_urls || [cleanPrUrl],
                  stage: res.status.stage,
                  plan_updated: res.planUpdated || false,
                  message: `✅ PR ${cleanPrUrl} successfully attached to task ${cleanTaskId}${res.planUpdated ? " and execution plan step" : ""}.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`attach_pr_to_task error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error attaching PR to task: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // 6. pr_review
  server.tool(
    "pr_review",
    "Submit code review comments, approvals, or changes requested directly to a GitHub Pull Request.",
    {
      pr_number: z.union([z.number(), z.string()]).optional().describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      pr: z.union([z.number(), z.string()]).optional().describe("Alias of pr_number"),
      action: z.enum(["comment", "approve", "request-changes"]).describe("Review action: 'comment', 'approve', or 'request-changes'."),
      body: z.string().describe("Review comment body in Markdown."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'owner/repo')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
    },
    async ({ pr_number: prNumberArg, pr: prAlias, action, body, repo, repo_path }) => {
      audit(rootDir, { tool: "pr_review" });
      const pr_number = prNumberArg ?? prAlias;
      if (pr_number === undefined || String(pr_number).trim() === "") {
        return { isError: true, content: [{ type: "text", text: "Error: pr_number (or pr) is required." }] };
      }
      const cwd = resolveCwd(rootDir, repo_path);

      const args = ["pr", "review", String(pr_number).trim(), "--body", body.trim()];
      if (action === "approve") {
        args.push("--approve");
      } else if (action === "request-changes") {
        args.push("--request-changes");
      } else {
        args.push("--comment");
      }
      if (repo && repo.trim()) {
        args.push("--repo", repo.trim());
      }

      const res = runGhCommand(args, cwd, 45000);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to submit PR review (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                pr_number,
                action,
                message: `✅ Review [${action}] submitted successfully to PR #${pr_number}.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 7. pr_merge
  server.tool(
    "pr_merge",
    "Merge a Pull Request on GitHub using merge, squash, or rebase.",
    {
      pr_number: z.union([z.number(), z.string()]).optional().describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      pr: z.union([z.number(), z.string()]).optional().describe("Alias of pr_number"),
      method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method: 'merge' (default), 'squash', or 'rebase'."),
      delete_branch: z.boolean().optional().describe("Whether to delete head branch after merge. Default: false."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'owner/repo')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
    },
    async ({ pr_number: prNumberArg, pr: prAlias, method = "merge", delete_branch = false, repo, repo_path }) => {
      audit(rootDir, { tool: "pr_merge" });
      const pr_number = prNumberArg ?? prAlias;
      if (pr_number === undefined || String(pr_number).trim() === "") {
        return { isError: true, content: [{ type: "text", text: "Error: pr_number (or pr) is required." }] };
      }
      const cwd = resolveCwd(rootDir, repo_path);

      const args = ["pr", "merge", String(pr_number).trim()];
      if (method === "squash") {
        args.push("--squash");
      } else if (method === "rebase") {
        args.push("--rebase");
      } else {
        args.push("--merge");
      }
      if (delete_branch) {
        args.push("--delete-branch");
      }
      if (repo && repo.trim()) {
        args.push("--repo", repo.trim());
      }

      const res = runGhCommand(args, cwd, 60000);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to merge PR (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                pr_number,
                method,
                message: `✅ PR #${pr_number} merged successfully using ${method}.`,
                output: res.stdout || res.stderr,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
