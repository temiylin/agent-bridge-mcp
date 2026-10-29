import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { isBlockedCredentialPath } from "./local-fs.js";

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
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'temiylin/vision_hub'). If omitted, uses local Git remote."),
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
      pr_number: z.union([z.number(), z.string()]).describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'temiylin/vision_hub')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
      include_comments: z.boolean().optional().describe("Whether to include discussion comments and review findings (default: true)."),
    },
    async ({ pr_number, repo, repo_path, include_comments = true }) => {
      audit(rootDir, { tool: "pr_view" });
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
      pr_number: z.union([z.number(), z.string()]).describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'temiylin/vision_hub')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
      max_bytes: z.number().int().min(500).max(128000).optional().describe("Maximum bytes to return (default: 48000)."),
    },
    async ({ pr_number, repo, repo_path, max_bytes = 48000 }) => {
      audit(rootDir, { tool: "pr_diff" });
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
      pr_number: z.union([z.number(), z.string()]).describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'temiylin/vision_hub')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
    },
    async ({ pr_number, repo, repo_path }) => {
      audit(rootDir, { tool: "pr_checks" });
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
      title: z.string().describe("Pull request title"),
      body: z.string().optional().describe("Pull request body description in Markdown"),
      base: z.string().optional().describe("Target base branch, e.g. 'develop' or 'main' (defaults to default branch)"),
      head: z.string().optional().describe("Head branch containing commits (defaults to current branch)"),
      draft: z.boolean().optional().describe("Whether to create the PR as a draft. Default: false."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'temiylin/vision_hub')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
    },
    async ({ title, body = "", base, head, draft, repo, repo_path }) => {
      audit(rootDir, { tool: "pr_create" });
      const cwd = resolveCwd(rootDir, repo_path);

      const args = ["pr", "create", "--title", title.trim(), "--body", body.trim()];
      if (base && base.trim()) {
        args.push("--base", base.trim());
      }
      if (head && head.trim()) {
        args.push("--head", head.trim());
      }
      if (draft) {
        args.push("--draft");
      }
      if (repo && repo.trim()) {
        args.push("--repo", repo.trim());
      }

      const res = runGhCommand(args, cwd, 60000);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create PR (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      const prUrl = res.stdout.trim();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                title: title.trim(),
                url: prUrl,
                message: `✅ Pull Request created successfully: ${prUrl}`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 6. pr_review
  server.tool(
    "pr_review",
    "Submit code review comments, approvals, or changes requested directly to a GitHub Pull Request.",
    {
      pr_number: z.union([z.number(), z.string()]).describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      action: z.enum(["comment", "approve", "request-changes"]).describe("Review action: 'comment', 'approve', or 'request-changes'."),
      body: z.string().describe("Review comment body in Markdown."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'temiylin/vision_hub')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
    },
    async ({ pr_number, action, body, repo, repo_path }) => {
      audit(rootDir, { tool: "pr_review" });
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
      pr_number: z.union([z.number(), z.string()]).describe("Pull Request number (e.g. 60), branch name, or PR URL."),
      method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method: 'merge' (default), 'squash', or 'rebase'."),
      delete_branch: z.boolean().optional().describe("Whether to delete head branch after merge. Default: false."),
      repo: z.string().optional().describe("GitHub repository in 'owner/repo' format (e.g. 'temiylin/vision_hub')."),
      repo_path: z.string().optional().describe("Path to local repository workspace. Defaults to project workspace."),
    },
    async ({ pr_number, method = "merge", delete_branch = false, repo, repo_path }) => {
      audit(rootDir, { tool: "pr_merge" });
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
