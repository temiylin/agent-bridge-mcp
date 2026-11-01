import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { restartService } from "./service-manager.js";
import { verifyPr } from "./pr-verifier.js";
import { mergeAndDeploy } from "./deployer.js";
import { listProjectTasks } from "./project-tasks.js";
import { postSlackMessage, resolveSlackBotToken } from "./slack-service.js";
import { listAccountsFromCockpitStorage, switchAgentAccount } from "./account-manager.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

export function registerBridgeRound2Tools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // Tool A: restart_service(project, name)
  server.tool(
    "restart_service",
    "Restart a configured service for a project: kills existing listener on port, spawns command, and verifies health via HTTP status.",
    {
      project: z.string().describe("Project ID configured in projects.json (e.g. 'my-app')"),
      name: z.string().describe("Service name configured under project services (e.g. 'web', 'api')"),
    },
    async ({ project, name }) => {
      audit(rootDir, { tool: "restart_service" });
      try {
        const result = await restartService(rootDir, project, name, logger);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: !result.success,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error restarting service: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // Tool C: verify_pr(project, pr)
  server.tool(
    "verify_pr",
    "Run configured test commands on a pull request branch, returning structured pass/fail counts, failing cases, and log tail.",
    {
      project: z.string().describe("Project ID configured in projects.json"),
      pr_number: z.union([z.number(), z.string()]).optional().describe("Pull request number (e.g. 12)"),
      pr: z.union([z.number(), z.string()]).optional().describe("Alias of pr_number"),
    },
    async ({ project, pr_number, pr: prAlias }) => {
      audit(rootDir, { tool: "verify_pr" });
      const pr = pr_number ?? prAlias;
      if (pr === undefined || String(pr).trim() === "") {
        return { isError: true, content: [{ type: "text", text: "Error: pr_number (or pr) is required." }] };
      }
      try {
        const result = await verifyPr(rootDir, project, pr, logger);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: !result.success,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error verifying PR: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // Tool E: merge_and_deploy
  server.tool(
    "merge_and_deploy",
    "Merge pull request, fast-forward target checkout, and restart services according to changed-path rules.",
    {
      project: z.string().describe("Project ID configured in projects.json"),
      pr_number: z.union([z.number(), z.string()]).optional().describe("Pull request number (e.g. 12)"),
      pr: z.union([z.number(), z.string()]).optional().describe("Alias of pr_number"),
      method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method (default: 'merge')"),
    },
    async ({ project, pr_number, pr: prAlias, method }) => {
      audit(rootDir, { tool: "merge_and_deploy" });
      const pr = pr_number ?? prAlias;
      if (pr === undefined || String(pr).trim() === "") {
        return { isError: true, content: [{ type: "text", text: "Error: pr_number (or pr) is required." }] };
      }
      try {
        const result = await mergeAndDeploy(rootDir, project, pr, { method, logger });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: !result.success,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error in merge_and_deploy: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // Tool F: list_project_tasks(project)
  server.tool(
    "list_project_tasks",
    "List currently running tasks for a project, including elapsed seconds and last output line.",
    {
      project: z.string().describe("Project ID configured in projects.json"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ project }) => {
      audit(rootDir, { tool: "list_project_tasks" });
      try {
        const tasks = listProjectTasks(rootDir, project, logger);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(tasks, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing project tasks: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // Slack Tool S2: slack_post(project, text, thread_of_task?)
  server.tool(
    "slack_post",
    "Post a message to Slack channel configured for the project (using primary bot token xoxb or webhook fallback).",
    {
      project: z.string().optional().describe("Project ID to resolve target channel from projects.json"),
      channel: z.string().optional().describe("Optional explicit Slack channel ID (overrides project channel)"),
      text: z.string().describe("Message text to post to Slack"),
      thread_of_task: z.string().optional().describe("Optional task ID to thread this message under its root task thread"),
    },
    async ({ project, channel, text, thread_of_task }) => {
      audit(rootDir, { tool: "slack_post" });
      try {
        let threadTs: string | undefined;
        if (thread_of_task) {
          const { readStatus } = await import("./status.js");
          const st = readStatus(rootDir, thread_of_task);
          if (st?.slackMessageTs) {
            threadTs = st.slackMessageTs;
          }
        }

        const res = await postSlackMessage(
          rootDir,
          {
            project,
            channel,
            text,
            threadTs,
          },
          logger
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
          isError: !res.ok,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to post Slack message: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // Tool G: list_agent_accounts(provider)
  server.tool(
    "list_agent_accounts",
    "List local agent accounts for a provider (e.g. 'antigravity', 'codex') with remaining quota and reset times. NEVER exposes tokens.",
    {
      provider: z.string().describe("Provider name (e.g. 'antigravity', 'codex')"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ provider }) => {
      audit(rootDir, { tool: "list_agent_accounts" });
      try {
        const accounts = listAccountsFromCockpitStorage(provider);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(accounts, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing agent accounts: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // Tool G: switch_agent_account(provider, email|"auto")
  server.tool(
    "switch_agent_account",
    "Switch active agent account via local Cockpit Tools WebSocket. Awaits account_switched or switch_error.",
    {
      provider: z.string().describe("Provider name (e.g. 'antigravity', 'codex')"),
      account: z.string().describe("Account email, account ID, or 'auto' to pick account with most remaining quota"),
      runtime_target: z.string().optional().describe("Optional runtime target (e.g. 'antigravity', not the IDE target)"),
    },
    async ({ provider, account, runtime_target }) => {
      audit(rootDir, { tool: "switch_agent_account" });
      try {
        const res = await switchAgentAccount({
          provider,
          targetEmailOrAccount: account,
          runtimeTarget: runtime_target || "antigravity",
          logger,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
          isError: !res.success,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error switching agent account: ${err?.message || String(err)}` }],
        };
      }
    }
  );
}
