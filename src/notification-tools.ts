import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendDesktopNotification, NotificationLevel, NotificationChannel } from "./notifier.js";
import { BridgeLogger } from "./logger.js";

/**
 * Registers local notification tools for the MCP server.
 */
export function registerNotificationTools(server: McpServer, rootDir: string, logger: BridgeLogger): void {
  server.tool(
    "notify_device",
    "Send an immediate local desktop notification and/or sound alert to the host machine running agent-bridge.",
    {
      title: z.string().describe("Notification title"),
      message: z.string().describe("Notification message body"),
      subtitle: z.string().optional().describe("Optional notification subtitle"),
      level: z.enum(["info", "success", "warning", "error"]).optional().describe("Notification level (info, success, warning, error)"),
      sound: z.union([z.boolean(), z.string()]).optional().describe("Whether to play a sound or specify sound name"),
      channel: z.enum(["desktop", "sound_only", "none"]).optional().describe("Notification channel"),
    },
    async ({ title, message, subtitle, level, sound, channel }) => {
      try {
        const result = sendDesktopNotification({
          title,
          message,
          subtitle,
          level: (level as NotificationLevel) || "info",
          sound: sound !== undefined ? sound : true,
          channel: (channel as NotificationChannel) || "desktop",
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`notify_device failed: ${err?.message || String(err)}`);
        return {
          content: [
            {
              type: "text",
              text: `Failed to send notification: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
