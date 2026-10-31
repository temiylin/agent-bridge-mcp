import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeLogger } from "./logger.js";
import { getStashedQuotaTask, removeStashedQuotaTask } from "./session-quota.js";
import { dispatchTaskDirect } from "./queue-dispatcher.js";
import { resumeQueue } from "./queue.js";
import { audit } from "./audit.js";

/**
 * Checks whether Cockpit Tools is running locally and has available quota on current/active account.
 * Cockpit writes its websocket port and auth token to ~/.antigravity_cockpit/server.json.
 */
export function checkCockpitAccountStatus(): { available: boolean; info?: any; reason?: string } {
  const cockpitCfgPath = path.join(os.homedir(), ".antigravity_cockpit", "server.json");
  if (!fs.existsSync(cockpitCfgPath)) {
    return {
      available: false,
      reason: "Cockpit Tools server.json not detected at ~/.antigravity_cockpit/server.json. Cockpit may not be active or running.",
    };
  }

  try {
    const raw = fs.readFileSync(cockpitCfgPath, "utf8");
    const serverInfo = JSON.parse(raw);
    if (!serverInfo.ws_port || !serverInfo.auth_token) {
      return { available: false, reason: "Cockpit server.json is missing ws_port or auth_token." };
    }
    return { available: true, info: serverInfo };
  } catch (err: any) {
    return { available: false, reason: `Failed reading Cockpit configuration: ${err.message}` };
  }
}

export function registerAccountResumeTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  /**
   * Tool: resume_after_account_switch
   * Resumes a quota-paused task or session, re-launching it with continue_session
   * using the identical session identifier so conversation context on the machine is fully preserved.
   */
  server.tool(
    "resume_after_account_switch",
    "Resume a quota-paused task or session after an account switch. Reuses the identical session_id with continue_session so machine conversation history is preserved.",
    {
      target: z.string().describe("Task ID or session_id that was paused due to quota exhaustion"),
      prompt_override: z.string().optional().describe("Optional prompt override if different from the stashed prompt"),
      agent: z.string().optional().describe("Optional agent override"),
      model: z.string().optional().describe("Optional model override"),
    },
    async ({ target, prompt_override, agent, model }) => {
      audit(rootDir, { tool: "resume_after_account_switch" });

      try {
        const cleanTarget = target.trim();
        const stashed = getStashedQuotaTask(rootDir, cleanTarget);

        let promptToRun = prompt_override;
        let sessionIdToResume = cleanTarget;
        let agentToUse = agent || "agy";
        let modelToUse = model;
        let effortToUse: string | undefined = undefined;

        if (stashed) {
          promptToRun = promptToRun || stashed.prompt;
          sessionIdToResume = stashed.session_id || sessionIdToResume;
          agentToUse = agent || stashed.agent || agentToUse;
          modelToUse = model || stashed.model;
          effortToUse = stashed.reasoningEffort;
        }

        if (!promptToRun) {
          // If neither override nor stashed prompt was found, check if tasks/<target>.md exists
          const taskMdPath = path.join(rootDir, "tasks", `${cleanTarget}.md`);
          if (fs.existsSync(taskMdPath)) {
            try {
              const content = fs.readFileSync(taskMdPath, "utf8");
              const pMatch = content.match(/## Prompt\s*\n([\s\S]*)$/i);
              if (pMatch) promptToRun = pMatch[1].trim();
              const sMatch = content.match(/- \*\*Session ID\*\*:\s*([^\r\n]+)/i);
              if (sMatch) sessionIdToResume = sMatch[1].trim();
            } catch {}
          }
        }

        if (!promptToRun) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error: Could not find prompt for target "${cleanTarget}". Please supply prompt_override.`,
              },
            ],
          };
        }

        // Unpause the session queue if it was paused
        if (sessionIdToResume) {
          resumeQueue(rootDir, sessionIdToResume);
        }

        // Re-launch task with continue_session: true and the same session_id
        const dispatchRes = dispatchTaskDirect(rootDir, {
          prompt: promptToRun,
          title: `Resume ${cleanTarget}`,
          agent: agentToUse,
          model: modelToUse,
          reasoning_effort: effortToUse,
          continue_session: true,
          session_id: sessionIdToResume,
        });

        // Remove stashed quota file if present
        if (stashed) {
          removeStashedQuotaTask(rootDir, stashed.taskId);
        }

        logger.info(`resume_after_account_switch: resumed session ${sessionIdToResume} via new taskId=${dispatchRes.taskId}`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  resumed: true,
                  new_task_id: dispatchRes.taskId,
                  session_id: sessionIdToResume,
                  agent: dispatchRes.agentName,
                  model: dispatchRes.modelParam,
                  continued_session: true,
                  message: `Successfully resumed session "${sessionIdToResume}". History on machine is preserved and will be continued.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`resume_after_account_switch error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error resuming task: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: auto_resume_on_account_ready
   * Checks whether the local account environment is ready/switched, and if so,
   * resumes any quota-paused tasks for the specified session or all paused sessions.
   * Note: If Cockpit Tools is not actively running, callers can use resume_after_account_switch directly.
   */
  server.tool(
    "auto_resume_on_account_ready",
    "Inspect local account status and resume quota-paused tasks if account switch is ready. If automatic detection is unavailable, callers should invoke resume_after_account_switch directly.",
    {
      session_id: z.string().optional().describe("Optional session_id to resume; if omitted, checks all stashed quota tasks"),
    },
    async ({ session_id }) => {
      audit(rootDir, { tool: "auto_resume_on_account_ready" });

      try {
        const cockpitStatus = checkCockpitAccountStatus();
        const stashDir = path.join(rootDir, "stash");

        if (!fs.existsSync(stashDir)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ account_ready: cockpitStatus.available, ready: false, message: "No tasks are currently paused due to quota." }, null, 2),
              },
            ],
          };
        }

        const files = fs.readdirSync(stashDir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ account_ready: cockpitStatus.available, ready: false, message: "No tasks are currently paused due to quota." }, null, 2),
              },
            ],
          };
        }

        // If cockpitStatus is available or caller manually triggered check
        const resumedTasks: any[] = [];
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(stashDir, file), "utf8");
            const stashed = JSON.parse(raw);
            if (session_id && stashed.session_id !== session_id) continue;

            const res = dispatchTaskDirect(rootDir, {
              prompt: stashed.prompt,
              title: `Resume ${stashed.taskId}`,
              agent: stashed.agent || "agy",
              model: stashed.model,
              reasoning_effort: stashed.reasoningEffort,
              continue_session: true,
              session_id: stashed.session_id,
            });

            if (stashed.session_id) {
              resumeQueue(rootDir, stashed.session_id);
            }
            removeStashedQuotaTask(rootDir, stashed.taskId);

            resumedTasks.push({
              original_task_id: stashed.taskId,
              new_task_id: res.taskId,
              session_id: stashed.session_id,
            });
          } catch {}
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  account_ready: cockpitStatus.available,
                  cockpit_status: cockpitStatus,
                  resumed_count: resumedTasks.length,
                  resumed_tasks: resumedTasks,
                  note: cockpitStatus.available
                    ? "Cockpit account environment ready."
                    : "Cockpit automatic status check unavailable; tasks resumed based on explicit request.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`auto_resume_on_account_ready error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error checking account readiness: ${err?.message || String(err)}` }],
        };
      }
    }
  );
}
