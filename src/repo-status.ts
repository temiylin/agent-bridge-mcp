import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { getReadOnlyGitStatus } from "./project-inspection.js";

const MAX_OUTPUT_LENGTH = 8000;
const TRUNCATION_NOTICE = "\n\n[Output truncated: exceeded 8000 characters limit]";

function runGit(args: string[], cwd: string) {
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const env = {
    ...gitEnv,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  return spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd,
    shell: false,
    timeout: 5000,
    maxBuffer: 256 * 1024,
    encoding: "utf8",
    env,
  });
}

export function registerRepoStatusTool(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  server.tool(
    "repo_status",
    "Get read-only Git repository status summary, current branch, refs, and recent commits.",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      audit(rootDir, { tool: "repo_status" });

      const repoPath = process.env.AGENT_BRIDGE_REPO;
      if (!repoPath) {
        logger.warn("repo_status rejected: AGENT_BRIDGE_REPO environment variable is not set");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Error: AGENT_BRIDGE_REPO environment variable is not set.",
            },
          ],
        };
      }

      if (!path.isAbsolute(repoPath)) {
        logger.warn(`repo_status rejected: AGENT_BRIDGE_REPO is not absolute: "${repoPath}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: AGENT_BRIDGE_REPO must be an absolute path: "${repoPath}"`,
            },
          ],
        };
      }

      if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
        logger.warn(`repo_status rejected: AGENT_BRIDGE_REPO is not an existing directory: "${repoPath}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: AGENT_BRIDGE_REPO path does not exist or is not a directory: "${repoPath}"`,
            },
          ],
        };
      }

      const gitDir = path.join(repoPath, ".git");
      if (!fs.existsSync(gitDir)) {
        logger.warn(`repo_status rejected: no .git found in "${repoPath}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: AGENT_BRIDGE_REPO is not a git repository (missing .git directory): "${repoPath}"`,
            },
          ],
        };
      }

      try {
        // b. ["--no-pager", "rev-parse", "--abbrev-ref", "HEAD"]
        const branchRes = runGit(["--no-pager", "rev-parse", "--abbrev-ref", "HEAD"], repoPath);
        const currentBranch =
          branchRes.status === 0 && typeof branchRes.stdout === "string"
            ? branchRes.stdout.trim()
            : "unknown";

        // a. ["--no-pager", "status", "--short", "--branch"]
        const statusRes = await getReadOnlyGitStatus(repoPath, Date.now() + 10000, MAX_OUTPUT_LENGTH);
        const statusSummary = statusRes.status === "ok"
          ? `${statusRes.text || "(clean)"}${statusRes.note ? `\n${statusRes.note}` : ""}`
          : `Git status unavailable (${statusRes.status})`;

        // c. ["--no-pager", "rev-parse", "develop", "main", "origin/develop", "origin/main"]
        const targetRefs = ["develop", "main", "origin/develop", "origin/main"] as const;
        const refMap: Record<string, string> = {
          develop: "missing",
          main: "missing",
          "origin/develop": "missing",
          "origin/main": "missing",
        };

        const batchRes = runGit(
          ["--no-pager", "rev-parse", "develop", "main", "origin/develop", "origin/main"],
          repoPath
        );

        if (batchRes.status === 0 && typeof batchRes.stdout === "string") {
          const lines = batchRes.stdout.trim().split("\n");
          if (lines.length === targetRefs.length) {
            targetRefs.forEach((ref, idx) => {
              refMap[ref] = lines[idx]?.trim() || "missing";
            });
          }
        } else {
          // If any single ref does not exist, resolve individually and mark missing without failing
          for (const ref of targetRefs) {
            const singleRes = runGit(["--no-pager", "rev-parse", ref], repoPath);
            if (singleRes.status === 0 && typeof singleRes.stdout === "string" && singleRes.stdout.trim()) {
              refMap[ref] = singleRes.stdout.trim();
            } else {
              refMap[ref] = "missing";
            }
          }
        }

        // d. ["--no-pager", "log", "--oneline", "-n", "10"]
        const logRes = runGit(["--no-pager", "log", "--oneline", "-n", "10"], repoPath);
        const recentCommits =
          logRes.status === 0 && typeof logRes.stdout === "string"
            ? logRes.stdout.trim()
            : logRes.stderr
            ? logRes.stderr.trim()
            : "(no commits)";

        const sections = [
          `Branch: ${currentBranch}`,
          "",
          "Status Summary:",
          statusSummary || "(clean)",
          "",
          "Refs:",
          `  develop: ${refMap["develop"]}`,
          `  main: ${refMap["main"]}`,
          `  origin/develop: ${refMap["origin/develop"]}`,
          `  origin/main: ${refMap["origin/main"]}`,
          "",
          "Recent Commits:",
          recentCommits || "(no commits)",
        ];

        let outputText = sections.join("\n");
        if (outputText.length > MAX_OUTPUT_LENGTH) {
          outputText =
            outputText.slice(0, MAX_OUTPUT_LENGTH - TRUNCATION_NOTICE.length) +
            TRUNCATION_NOTICE;
        }

        return {
          content: [
            {
              type: "text",
              text: outputText,
            },
          ],
        };
      } catch (err: any) {
        logger.error(`repo_status error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error executing repo_status: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );
}
