import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { GitLinkItem } from "./redaction.js";

export type NotificationLevel = "info" | "success" | "warning" | "error";
export type NotificationChannel = "desktop" | "sound_only" | "none";

export interface DesktopNotificationOptions {
  title: string;
  message: string;
  subtitle?: string;
  level?: NotificationLevel;
  sound?: boolean | string;
  channel?: NotificationChannel;
}

export interface DesktopNotificationResult {
  success: boolean;
  disabled?: boolean;
  details?: string;
}

/**
 * Builds osascript argument array for macOS desktop notification.
 */
export function buildOsascriptNotifyArgs(
  title: string,
  message: string,
  subtitle: string = "",
  soundName: string = ""
): string[] {
  const scriptLines: string[] = ["on run argv"];
  let displayCmd = "display notification (item 1 of argv) with title (item 2 of argv)";
  if (subtitle && subtitle.trim().length > 0) {
    displayCmd += " subtitle (item 3 of argv)";
  }
  if (soundName && soundName.trim().length > 0) {
    displayCmd += ` sound name (item ${subtitle && subtitle.trim().length > 0 ? "4" : "3"} of argv)`;
  }
  scriptLines.push(displayCmd);
  scriptLines.push("end run");

  const args: string[] = [];
  for (const line of scriptLines) {
    args.push("-e", line);
  }
  args.push(message);
  args.push(title);
  if (subtitle && subtitle.trim().length > 0) {
    args.push(subtitle.trim());
  }
  if (soundName && soundName.trim().length > 0) {
    args.push(soundName.trim());
  }

  return args;
}

/**
 * Sends a native desktop notification across platforms.
 */
export function sendDesktopNotification(options: DesktopNotificationOptions): DesktopNotificationResult {
  if (process.env.AGENT_BRIDGE_NOTIFY === "0") {
    return { success: false, disabled: true };
  }

  const { title, message, subtitle = "", sound = true, channel = "desktop" } = options;
  if (channel === "none") {
    return { success: true };
  }

  if (process.platform === "darwin") {
    let soundName = "";
    if (typeof sound === "string" && sound.trim()) {
      soundName = sound.trim();
    } else if (sound) {
      soundName = "Hero";
    }

    const args = buildOsascriptNotifyArgs(title, message, subtitle, soundName);
    const child = spawn("osascript", args, { shell: false });
    child.on("error", () => {});
    return { success: true };
  }

  // Windows / Linux fallback: silent or no-op
  return { success: true };
}

export interface LifecycleNotificationParams {
  taskId: string;
  event: "started" | "completed" | "failed" | "timeout" | "cancelled";
  projectName?: string;
  repo?: string;
  slackChannel?: string;
  slackWebhookEnv?: string;
  agent?: string;
  model?: string;
  promptSummary?: string;
  durationSeconds?: number;
  resultSummary?: string;
  errorDetails?: string;
  exitCode?: number;
  logFilePath?: string;
  gitLinks?: GitLinkItem[];
  updateTs?: string;
  desktop?: boolean;
}

export interface LifecycleNotificationResult {
  slackTs?: string;
}

/**
 * Posts task lifecycle notification to Slack webhook or API if configured.
 */
export async function dispatchTaskLifecycleNotification(
  params: LifecycleNotificationParams,
  logger?: (level: "INFO" | "WARN" | "ERROR", msg: string) => void
): Promise<LifecycleNotificationResult> {
  const { taskId, event, projectName, slackWebhookEnv } = params;

  // Resolve webhook URL from slackWebhookEnv
  let webhookUrl: string | undefined;
  if (slackWebhookEnv && process.env[slackWebhookEnv]) {
    webhookUrl = process.env[slackWebhookEnv];
  } else if (process.env.SLACK_WEBHOOK_URL) {
    webhookUrl = process.env.SLACK_WEBHOOK_URL;
  }

  if (!webhookUrl || !webhookUrl.trim()) {
    return {};
  }

  const statusEmoji = event === "completed" ? "✅" : event === "failed" ? "❌" : event === "started" ? "🚀" : "⚠️";
  const payload = {
    text: `${statusEmoji} [${projectName || "agent-bridge"}] Task ${taskId} ${event}`,
    attachments: [
      {
        color: event === "completed" ? "#36a64f" : event === "failed" ? "#d9534f" : "#439FE0",
        fields: [
          { title: "Task ID", value: taskId, short: true },
          { title: "Event", value: event, short: true },
          ...(params.agent ? [{ title: "Agent", value: params.agent, short: true }] : []),
          ...(params.durationSeconds !== undefined ? [{ title: "Duration", value: `${params.durationSeconds}s`, short: true }] : []),
        ],
      },
    ],
  };

  try {
    const postData = JSON.stringify(payload);
    const parsedUrl = new URL(webhookUrl);
    const transport = parsedUrl.protocol === "https:" ? https : http;

    await new Promise<void>((resolve, reject) => {
      const req = transport.request(
        parsedUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", (err) => reject(err));
      req.write(postData);
      req.end();
    });
  } catch (err: any) {
    logger?.("WARN", `Failed to dispatch Slack notification: ${err?.message || String(err)}`);
  }

  return {};
}
