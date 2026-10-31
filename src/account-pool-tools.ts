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
  syncProfileAuthFromCockpit,
  detectProfileLoginStatus,
  loadPoolConfig,
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
          return `${s.alias} [${s.email}] ${s.enabled ? "ACTIVE" : "PAUSED"} | login: ${s.login_label}${s.login_reason ? "(" + s.login_reason + ")" : ""} | busy: ${s.busy_task_id} | paused_until: ${s.paused_until} | today: ${s.tasks_today} | cockpit_remaining: ${s.cockpit_remaining}`;
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
    "Initialize an isolated agy profile from a Cockpit account email (preferred) or an explicit alias. Alias/HOME are auto-derived from the email local-part when omitted. Rejects duplicate email bindings and alias/HOME collisions. Automatically syncs Cockpit login into the profile HOME so the profile is usable immediately; pool_sync_auth remains available to retry.",
    {
      email: z
        .string()
        .optional()
        .describe("Cockpit account email to bind. Preferred: when set without alias, alias and HOME are auto-generated from the email local-part."),
      alias: z
        .string()
        .optional()
        .describe("Optional explicit profile alias (alphanumeric, hyphens, underscores only). If omitted, derived from email. Rejected if it already exists."),
      cockpit_account_id: z
        .string()
        .optional()
        .describe("Optional Cockpit account id to record alongside the email binding."),
    },
    async ({ alias, email, cockpit_account_id }) => {
      audit(rootDir, { tool: "pool_init_profile" });
      try {
        if (!alias && !email) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Error: Provide email (preferred) or alias to initialize a profile.",
              },
            ],
          };
        }
        const res = initPoolProfile(rootDir, { alias, email, cockpit_account_id });
        if (!res.success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: ${res.error}` }],
          };
        }

        const createdAlias = res.profile?.alias || alias || "(unknown)";

        let authSyncText = "";
        try {
          const syncRes = await syncProfileAuthFromCockpit(rootDir, createdAlias, {
            logger,
            accountId: cockpit_account_id || res.profile?.cockpit_account_id,
          });
          const refreshed =
            loadPoolConfig(rootDir).find((p) => p.alias === createdAlias) || res.profile!;
          const login = detectProfileLoginStatus(refreshed);
          if (syncRes.success) {
            authSyncText = `Login status: ${login.label} (Cockpit auth synced into profile HOME).`;
          } else {
            authSyncText = [
              `Login status: ${login.label}${login.reason ? " — " + login.reason : ""}`,
              `Cockpit auth sync failed: ${syncRes.error || "unknown error"}`,
              "Retry with pool_sync_auth, or as a last resort run:",
              `  ${res.loginCommand}`,
            ].join("\n");
          }
        } catch (syncErr: any) {
          authSyncText = [
            `Cockpit auth sync threw: ${syncErr?.message || String(syncErr)}`,
            "Retry with pool_sync_auth, or as a last resort run:",
            `  ${res.loginCommand}`,
          ].join("\n");
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `Profile "${createdAlias}" initialized successfully at "${res.profile?.home}".`,
                res.profile?.email ? `Bound email: ${res.profile.email}` : "",
                authSyncText,
              ]
                .filter((line) => line !== undefined && line !== "")
                .join("\n"),
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

  server.tool(
    "pool_sync_auth",
    "Sync an already-logged-in Cockpit antigravity account into an agy pool profile HOME (via cockpit WS switch_account + copy of jetski/oauth files). Makes the profile usable without terminal login.",
    {
      alias: z.string().describe("Profile alias to sync auth into"),
      cockpit_account_id: z
        .string()
        .optional()
        .describe("Optional cockpit account id; defaults to the profile binding"),
    },
    async ({ alias, cockpit_account_id }) => {
      audit(rootDir, { tool: "pool_sync_auth" });
      try {
        const res = await syncProfileAuthFromCockpit(rootDir, alias, {
          logger,
          accountId: cockpit_account_id,
        });
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
              text: `Profile "${alias}" auth synced from Cockpit. Login status: ${res.login_label || "已登录"}.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error syncing auth: ${err?.message || String(err)}` }],
        };
      }
    }
  );

}
