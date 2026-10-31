import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeLogger } from "./logger.js";
import { audit } from "./audit.js";
import {
  queryPoolStatus,
  initPoolProfile,
  pausePoolProfile,
  resumePoolProfile,
  bindProfileEmail,
} from "./account-pool.js";

export function registerAccountPoolTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  /**
   * Tool: pool_status
   * Compact lines: alias, email, enabled, busy taskId, paused_until, tasks today, cockpit remainingFraction summary
   */
  server.tool(
    "pool_status",
    "Show compact status summary of all agy account pool profiles, in-flight tasks, and remaining Cockpit quota.",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      audit(rootDir, { tool: "pool_status" });
      try {
        const statuses = queryPoolStatus(rootDir);
        if (statuses.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No account profiles in pool. Operating in default single-account mode.",
              },
            ],
          };
        }

        // Format compact lines
        // e.g. alias | email | enabled | busy: <tid> | paused_until: <time> | tasks: <N> | quota: <rem>
        const lines = statuses.map((s) => {
          return `${s.alias} [${s.email}] ${s.enabled ? "ACTIVE" : "PAUSED"} | busy: ${s.busy_task_id} | paused_until: ${s.paused_until} | today: ${s.tasks_today} | cockpit_remaining: ${s.cockpit_remaining}`;
        });

        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error reading pool status: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: pool_init_profile
   * Initialize a new profile directory with safe symlinks and copy of non-secret settings.
   */
  server.tool(
    "pool_init_profile",
    "Initialize an isolated profile directory for an agy account, set up safe configuration symlinks, and output the interactive login command.",
    {
      alias: z.string().describe("Unique identifier for this profile (alphanumeric, hyphens, underscores only; no emails)"),
      email: z.string().optional().describe("Optional email address bound to this profile to map Cockpit quota and prevent concurrent duplicate usage"),
    },
    async ({ alias, email }) => {
      audit(rootDir, { tool: "pool_init_profile" });
      try {
        const res = initPoolProfile(rootDir, { alias, email });
        if (!res.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: ${res.error}` }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `Profile "${alias}" initialized successfully at "${res.profile?.home}".`,
                "",
                "Login instructions:",
                "Run this command in a terminal to authenticate this profile with agy:",
                `  ${res.loginCommand}`,
                "",
                "Once logged in, tasks assigned to this profile will run concurrently with an independent session.",
              ].join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error initializing profile: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: pool_pause
   * Pauses an account profile.
   */
  server.tool(
    "pool_pause",
    "Pause an account profile from receiving automated tasks, with optional duration or until timestamp.",
    {
      alias: z.string().describe("Profile alias to pause"),
      until: z.string().optional().describe("Optional ISO timestamp string or seconds duration until which profile remains paused"),
    },
    async ({ alias, until }) => {
      audit(rootDir, { tool: "pool_pause" });
      try {
        const res = pausePoolProfile(rootDir, alias, until);
        if (!res.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: ${res.error}` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Profile "${alias}" is now paused.${until ? ` (paused_until: ${until})` : ""}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error pausing profile: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: pool_resume
   * Resumes a paused account profile.
   */
  server.tool(
    "pool_resume",
    "Resume a paused account profile so it can receive automated tasks again.",
    {
      alias: z.string().describe("Profile alias to resume"),
    },
    async ({ alias }) => {
      audit(rootDir, { tool: "pool_resume" });
      try {
        const res = resumePoolProfile(rootDir, alias);
        if (!res.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: ${res.error}` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Profile "${alias}" has been resumed.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error resuming profile: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: pool_bind_email
   * Binds an email address to an existing profile.
   */
  server.tool(
    "pool_bind_email",
    "Bind or update the Cockpit account email for an existing pool profile to enable quota tracking and avoid duplicate usage.",
    {
      alias: z.string().describe("Profile alias"),
      email: z.string().describe("Cockpit account email address to bind to this profile"),
    },
    async ({ alias, email }) => {
      audit(rootDir, { tool: "pool_bind_email" });
      try {
        const res = bindProfileEmail(rootDir, alias, email);
        if (!res.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: ${res.error}` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Profile "${alias}" is now bound to email "${email}".`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error binding email: ${err?.message || String(err)}` }],
        };
      }
    }
  );
}
