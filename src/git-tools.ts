import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { isBlockedCredentialPath } from "./local-fs.js";
import {
  resolveProject,
  getProjectRepoPath,
  checkForbiddenRemotePush,
  ProjectDefinition,
} from "./project-router.js";

function resolveRepoAndProject(
  rootDir: string,
  repoPath?: string,
  projectId?: string
): { cwd: string; project?: ProjectDefinition } {
  const projRes = resolveProject(rootDir, { projectId, projectDir: repoPath });
  const projRepoPath = getProjectRepoPath(projRes.project);
  if (repoPath && typeof repoPath === "string" && repoPath.trim().length > 0) {
    return { cwd: path.resolve(repoPath.trim()), project: projRes.project };
  }
  if (projRepoPath) {
    return { cwd: path.resolve(projRepoPath), project: projRes.project };
  }
  return { cwd: resolveRepoDir(rootDir, repoPath), project: projRes.project };
}

function resolveRepoDir(rootDir: string, repoPath?: string): string {
  if (repoPath && typeof repoPath === "string" && repoPath.trim().length > 0) {
    return path.resolve(repoPath.trim());
  }
  const envRepo = process.env.AGENT_BRIDGE_REPO;
  if (envRepo && typeof envRepo === "string" && envRepo.trim().length > 0) {
    return path.resolve(envRepo.trim());
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, ".git"))) {
    return cwd;
  }
  try {
    const gitCheck = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 2000,
    });
    if (gitCheck.status === 0 && gitCheck.stdout.trim().length > 0) {
      return gitCheck.stdout.trim();
    }
  } catch {}
  return path.resolve(rootDir);
}

function runGitCommand(
  args: string[],
  cwd: string,
  timeoutMs: number = 30000
): { stdout: string; stderr: string; exitCode: number } {
  const proc = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });

  return {
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
    exitCode: proc.status ?? (proc.error ? 1 : 0),
  };
}

export function registerGitTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // 1. git_diff
  server.tool(
    "git_diff",
    "Inspect local Git code differences, unstaged/staged changes, revision ranges, or file statistics (--stat).",
    {
      repo_path: z.string().optional().describe("Path to local Git repository. Defaults to active project workspace."),
      target: z.enum(["working", "staged", "range"]).optional().describe("Diff target: 'working' (default, working tree vs HEAD), 'staged' (index vs HEAD), or 'range' (between two commits/branches)."),
      range: z.string().optional().describe("Revision range when target is 'range', e.g. 'github/develop...feature-branch' or 'HEAD~1'."),
      stat: z.boolean().optional().describe("If true, shows --stat summary of changed files and lines added/deleted instead of full patch."),
      file_path: z.string().optional().describe("Optional specific file or folder path to limit the diff."),
      max_bytes: z.number().int().min(500).max(128000).optional().describe("Maximum bytes to return (default: 48000)."),
    },
    async ({ repo_path, target = "working", range, stat, file_path: fileFilter, max_bytes = 48000 }) => {
      audit(rootDir, { tool: "git_diff" });
      const cwd = resolveRepoDir(rootDir, repo_path);

      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { isError: true, content: [{ type: "text", text: `Error: Repository directory "${cwd}" does not exist.` }] };
      }
      if (isBlockedCredentialPath(cwd)) {
        return { isError: true, content: [{ type: "text", text: "Access denied by credential protection policy." }] };
      }

      const args = ["diff"];
      if (stat) {
        args.push("--stat");
      }
      if (target === "staged") {
        args.push("--staged");
      } else if (target === "range" && range) {
        args.push(range.trim());
      }

      if (fileFilter && fileFilter.trim()) {
        args.push("--", fileFilter.trim());
      }

      const res = runGitCommand(args, cwd);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Git diff failed (code ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      let output = res.stdout;
      const isTruncated = output.length > max_bytes;
      if (isTruncated) {
        output = output.slice(0, max_bytes) + `\n\n... [Output truncated: exceeded max_bytes=${max_bytes}]`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                repo_path: cwd,
                target,
                stat: Boolean(stat),
                truncated: isTruncated,
                diff: output || "(no changes detected)",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 2. git_check_fast_forward
  server.tool(
    "git_check_fast_forward",
    "Verify whether a commit, branch, or pull request can be fast-forward merged into a base branch without creating a merge commit.",
    {
      repo_path: z.string().optional().describe("Path to local Git repository. Defaults to active project workspace."),
      base: z.string().describe("Base branch or ref, e.g. 'github/develop' or 'origin/main'."),
      head: z.string().describe("Head branch or commit SHA to test, e.g. 'feature/login' or '7c394bf'."),
    },
    async ({ repo_path, base, head }) => {
      audit(rootDir, { tool: "git_check_fast_forward" });
      const cwd = resolveRepoDir(rootDir, repo_path);

      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { isError: true, content: [{ type: "text", text: `Error: Repository directory "${cwd}" does not exist.` }] };
      }

      // Check: git merge-base --is-ancestor <base> <head>
      // Exit code 0 means <base> is an ancestor of <head> (Fast-forward possible)
      // Exit code 1 means <base> is NOT an ancestor (Fast-forward NOT possible)
      const res = runGitCommand(["merge-base", "--is-ancestor", base.trim(), head.trim()], cwd);

      const canFastForward = res.exitCode === 0;

      // Also get log summary of incoming commits if fast-forwardable
      let incomingCommits: string[] = [];
      if (canFastForward) {
        const logRes = runGitCommand(["log", "--oneline", `${base.trim()}..${head.trim()}`, "-n", "15"], cwd);
        if (logRes.exitCode === 0 && logRes.stdout.trim()) {
          incomingCommits = logRes.stdout.trim().split(/\r?\n/);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                repo_path: cwd,
                base: base.trim(),
                head: head.trim(),
                can_fast_forward: canFastForward,
                message: canFastForward
                  ? `✅ Can fast-forward: "${base}" is an ancestor of "${head}".`
                  : `⚠️ Cannot fast-forward: "${head}" has diverged from "${base}". Merging would require a merge commit or rebase.`,
                incoming_commits_count: incomingCommits.length,
                incoming_commits: incomingCommits,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 3. git_log
  server.tool(
    "git_log",
    "Query Git commit history with revision range, author, date, and commit messages.",
    {
      repo_path: z.string().optional().describe("Path to local Git repository. Defaults to active project workspace."),
      range: z.string().optional().describe("Revision range (e.g. 'github/develop..feature-branch' or 'HEAD~5..HEAD')."),
      max_count: z.number().int().min(1).max(50).optional().describe("Maximum number of commits to return (default: 10, max: 50)."),
      file_path: z.string().optional().describe("Optional file or directory path to inspect history for."),
    },
    async ({ repo_path, range, max_count = 10, file_path: fileFilter }) => {
      audit(rootDir, { tool: "git_log" });
      const cwd = resolveRepoDir(rootDir, repo_path);

      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { isError: true, content: [{ type: "text", text: `Error: Repository directory "${cwd}" does not exist.` }] };
      }

      const formatString = "%H%x00%an%x00%ae%x00%ad%x00%s";
      const args = ["log", `--pretty=format:${formatString}`, `-n`, String(Math.min(50, max_count))];

      if (range && range.trim()) {
        args.push(range.trim());
      }
      if (fileFilter && fileFilter.trim()) {
        args.push("--", fileFilter.trim());
      }

      const res = runGitCommand(args, cwd);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Git log failed (code ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      const lines = res.stdout.split(/\r?\n/).filter(Boolean);
      const commits = lines.map((line) => {
        const [hash, author, email, date, subject] = line.split("\0");
        return {
          hash: hash?.slice(0, 10),
          full_hash: hash,
          author,
          email,
          date,
          subject,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                repo_path: cwd,
                count: commits.length,
                commits,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 4. git_fetch
  server.tool(
    "git_fetch",
    "Fetch latest branches, tags, and commits from a remote Git repository (e.g. 'github' or 'origin').",
    {
      repo_path: z.string().optional().describe("Path to local Git repository. Defaults to active project workspace."),
      remote: z.string().optional().describe("Remote name to fetch from (e.g. 'github', 'origin', or '--all'). Default: 'origin'."),
      prune: z.boolean().optional().describe("If true, removes obsolete remote-tracking branches. Default: false."),
    },
    async ({ repo_path, remote = "origin", prune }) => {
      audit(rootDir, { tool: "git_fetch" });
      const cwd = resolveRepoDir(rootDir, repo_path);

      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { isError: true, content: [{ type: "text", text: `Error: Repository directory "${cwd}" does not exist.` }] };
      }

      const args = ["fetch", remote.trim()];
      if (prune) {
        args.push("--prune");
      }

      const res = runGitCommand(args, cwd, 45000);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Git fetch failed (code ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                repo_path: cwd,
                remote: remote.trim(),
                message: `Successfully fetched from remote "${remote.trim()}".`,
                output: res.stderr || res.stdout || "(up to date)",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 5. git_push
  server.tool(
    "git_push",
    "Push local commits or refspecs to a remote repository (e.g. 'github <sha>:refs/heads/develop' or 'origin develop'). Enforces project push_remote default and URL-based forbidden_remotes protection.",
    {
      project_id: z.string().optional().describe("Optional project ID to resolve repo_path, default push_remote, and forbidden_remotes rules."),
      repo_path: z.string().optional().describe("Path to local Git repository. Defaults to project repo_path or active workspace."),
      remote: z.string().optional().describe("Target remote name, e.g. 'github' or 'origin'. Defaults to project push_remote or 'origin'."),
      refspec: z.string().describe("Refspec or branch to push, e.g. 'develop', 'main', or '<sha>:refs/heads/develop'."),
      force: z.boolean().optional().describe("Whether to force push. Default: false. Caution: Use sparingly!"),
    },
    async ({ project_id, repo_path, remote, refspec, force }) => {
      audit(rootDir, { tool: "git_push" });
      const { cwd, project } = resolveRepoAndProject(rootDir, repo_path, project_id);

      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { isError: true, content: [{ type: "text", text: `Error: Repository directory "${cwd}" does not exist.` }] };
      }

      // Resolve project by cwd if not already matched by project_id
      const activeProject = project || resolveProject(rootDir, { projectDir: cwd }).project;
      const effectiveRemote = (remote && remote.trim()) || activeProject?.push_remote || "origin";
      const cleanRefspec = (refspec || "").trim();

      if (!cleanRefspec || cleanRefspec.startsWith("-")) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Invalid refspec "${refspec}". Refspec cannot be empty or start with "-" (flags such as "--force" are not allowed in refspec).`,
            },
          ],
        };
      }
      if (effectiveRemote.startsWith("-")) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Invalid remote "${effectiveRemote}". Remote name cannot start with "-".`,
            },
          ],
        };
      }

      // URL-based forbidden_remotes check (does NOT modify user git config)
      const forbiddenCheck = checkForbiddenRemotePush(cwd, effectiveRemote, activeProject);
      if (forbiddenCheck.forbidden) {
        logger.warn(`git_push blocked for repo="${cwd}", remote="${effectiveRemote}": ${forbiddenCheck.reason}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: ${forbiddenCheck.reason}`,
            },
          ],
        };
      }

      const args = ["push", effectiveRemote, cleanRefspec];
      if (force) {
        args.push("--force-with-lease");
      }

      const res = runGitCommand(args, cwd, 60000);
      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Git push failed (code ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                ...(activeProject?.id ? { project_id: activeProject.id } : {}),
                repo_path: cwd,
                remote: effectiveRemote,
                remote_url: forbiddenCheck.resolvedUrl || undefined,
                refspec: refspec.trim(),
                message: `Successfully pushed "${refspec.trim()}" to "${effectiveRemote}".`,
                output: res.stderr || res.stdout,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 6. git_branches
  server.tool(
    "git_branches",
    "List local and remote Git branches, current checked out branch, and tracking upstreams in a repository workspace.",
    {
      project_id: z.string().optional().describe("Optional project identifier to locate the workspace repository"),
      repo_path: z.string().optional().describe("Local git repository path. Defaults to project workspace or current repo"),
      include_remote: z.boolean().optional().describe("Whether to include remote branches. Default: true"),
    },
    async ({ project_id, repo_path, include_remote = true }) => {
      audit(rootDir, { tool: "git_branches", projectId: project_id });
      const { cwd, project: activeProject } = resolveRepoAndProject(rootDir, repo_path, project_id);
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Path "${cwd}" is not a Git repository.` }],
        };
      }

      // Query current branch
      const curRes = runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], cwd, 5000);
      const currentBranch = curRes.exitCode === 0 ? curRes.stdout.trim() : "HEAD";

      // Query branches with upstream and current indicator
      const branchFormat = "%(refname:short)|%(upstream:short)|%(HEAD)";
      const branchArgs = ["branch", "--format", branchFormat];
      if (include_remote) {
        branchArgs.push("-a");
      }

      const branchRes = runGitCommand(branchArgs, cwd, 10000);
      const lines = branchRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

      const localBranches: { name: string; upstream?: string; is_current: boolean }[] = [];
      const remoteBranches: string[] = [];

      for (const line of lines) {
        const [refname, upstream, headFlag] = line.split("|");
        if (!refname) continue;
        const isCurrent = headFlag === "*";
        if (refname.startsWith("origin/") || refname.startsWith("upstream/") || refname.includes("/")) {
          if (!remoteBranches.includes(refname)) {
            remoteBranches.push(refname);
          }
        } else {
          localBranches.push({
            name: refname,
            upstream: upstream || undefined,
            is_current: isCurrent,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                project_id: activeProject?.id,
                repo_path: cwd,
                current_branch: currentBranch,
                local_branches: localBranches,
                ...(include_remote ? { remote_branches: remoteBranches } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 7. git_create_branch
  server.tool(
    "git_create_branch",
    "Safely create a new Git branch from a base branch (or HEAD) and optionally check it out.",
    {
      branch: z.string().describe("New branch name (e.g. 'feat/auth-v2', 'fix/issue-89')"),
      base_branch: z.string().optional().describe("Base branch or commit to branch off from (defaults to project default_base_branch or HEAD)"),
      checkout: z.boolean().optional().describe("Whether to immediately checkout the new branch. Default: true"),
      project_id: z.string().optional().describe("Optional project identifier to locate the workspace repository"),
      repo_path: z.string().optional().describe("Local git repository path. Defaults to project workspace or current repo"),
    },
    async ({ branch, base_branch, checkout = true, project_id, repo_path }) => {
      audit(rootDir, { tool: "git_create_branch", projectId: project_id });
      const cleanBranch = branch.trim();
      if (!cleanBranch || cleanBranch.includes("..") || /[\s~^:?*\[\\]/.test(cleanBranch)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Invalid branch name "${cleanBranch}".` }],
        };
      }

      const { cwd, project: activeProject } = resolveRepoAndProject(rootDir, repo_path, project_id);
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Path "${cwd}" is not a Git repository.` }],
        };
      }

      const effectiveBase = (base_branch && base_branch.trim()) || activeProject?.default_base_branch || "HEAD";

      // Verify base branch / commit exists
      const revCheck = runGitCommand(["rev-parse", "--verify", effectiveBase], cwd, 5000);
      if (revCheck.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Base branch "${effectiveBase}" does not exist in "${cwd}".` }],
        };
      }

      // Check if branch already exists
      const existCheck = runGitCommand(["rev-parse", "--verify", cleanBranch], cwd, 5000);
      if (existCheck.exitCode === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Branch "${cleanBranch}" already exists in "${cwd}".` }],
        };
      }

      let res;
      if (checkout) {
        res = runGitCommand(["checkout", "-b", cleanBranch, effectiveBase], cwd, 15000);
      } else {
        res = runGitCommand(["branch", cleanBranch, effectiveBase], cwd, 10000);
      }

      if (res.exitCode !== 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create branch "${cleanBranch}" (exit ${res.exitCode}):\n${res.stderr || res.stdout}` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                project_id: activeProject?.id,
                repo_path: cwd,
                branch: cleanBranch,
                base_branch: effectiveBase,
                checked_out: checkout,
                message: `✅ Branch "${cleanBranch}" created successfully from "${effectiveBase}"${checkout ? " and checked out" : ""}.`,
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
