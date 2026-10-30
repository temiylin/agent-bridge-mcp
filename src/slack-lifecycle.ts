import fs from "node:fs";
import path from "node:path";
import { resolveBridgeRoot } from "./config.js";
import { loadProjectsConfig } from "./project-router.js";
import { readStatus } from "./status.js";
import { postSlackMessage, updateSlackMessage, resolveSlackBotToken } from "./slack-service.js";
import { BridgeLogger } from "./logger.js";

export interface LifecycleSlackNotificationOptions {
  rootDir?: string;
  taskId: string;
  event: "started" | "completed" | "failed" | "timeout" | "cancelled" | "stuck" | "needs-decision";
  projectId?: string;
  projectName?: string;
  agent?: string;
  model?: string;
  durationSeconds?: number;
  resultSummary?: string;
  errorDetails?: string;
  exitCode?: number;
  changedFiles?: string[];
  testResults?: { passed: number; failed: number };
  prUrl?: string;
  compactSummary?: string;
  logger?: BridgeLogger;
}

export function formatCompactSummary(options: {
  status: string;
  changedFiles?: string[];
  testResults?: { passed: number; failed: number };
  prUrl?: string;
  summaryText?: string;
}): string {
  const parts: string[] = [`Status: ${options.status}`];
  if (options.changedFiles && options.changedFiles.length > 0) {
    parts.push(`Changed: ${options.changedFiles.length} file(s) [${options.changedFiles.slice(0, 3).join(", ")}${options.changedFiles.length > 3 ? "..." : ""}]`);
  }
  if (options.testResults) {
    parts.push(`Tests: ${options.testResults.passed} passed, ${options.testResults.failed} failed`);
  }
  if (options.prUrl) {
    parts.push(`PR: ${options.prUrl}`);
  }
  if (options.summaryText) {
    parts.push(`Summary: ${options.summaryText}`);
  }
  return parts.join(" | ");
}

/**
 * Handles unified Slack notification with threading (S1) and notification levels (S5).
 */
export async function dispatchLifecycleSlack(
  options: LifecycleSlackNotificationOptions
): Promise<{ rootTs?: string }> {
  const rootDir = options.rootDir || resolveBridgeRoot();
  const logger = options.logger;
  const config = loadProjectsConfig(rootDir);

  let targetProject = options.projectId ? config.projects[options.projectId] : undefined;
  if (!targetProject && options.projectName) {
    targetProject = Object.values(config.projects).find(
      (p) => p.name.toLowerCase() === options.projectName?.toLowerCase()
    );
  }

  const channel = targetProject?.slack_channel || config.default_channel;
  if (!channel) {
    return {};
  }

  const botToken = resolveSlackBotToken(rootDir);

  // Status icons
  const iconMap: Record<string, string> = {
    started: "⏳",
    completed: "✅",
    failed: "❌",
    timeout: "⏰",
    cancelled: "🚫",
    stuck: "⚠️",
    "needs-decision": "❓",
  };
  const icon = iconMap[options.event] || "ℹ️";

  // Check existing status for root message ts (S1)
  const taskStatus = readStatus(rootDir, options.taskId);
  let rootTs = taskStatus?.slackMessageTs;

  // Root message text
  const rootText = `${icon} [${options.projectName || targetProject?.name || "agent-bridge"}] Task ${options.taskId} (${options.event})`;

  // S1 & S5 handling:
  if (!rootTs) {
    // Initial root message for this task
    const postRes = await postSlackMessage(
      rootDir,
      {
        channel,
        text: rootText,
        project: targetProject?.id,
      },
      logger
    );
    rootTs = postRes.ts;
    return { rootTs };
  }

  // If root message already exists:
  // 1. Update root status emoji/text (S1)
  if (botToken && rootTs) {
    await updateSlackMessage(rootDir, channel, rootTs, rootText, undefined, logger);
  }

  // 2. Thread lifecycle update under root (S1)
  // S5 rules:
  // - success (completed) => edit only (or compact thread note)
  // - failure / stuck / needs-decision => @mention configured user
  const needsAttention = options.event === "failed" || options.event === "timeout" || options.event === "stuck" || options.event === "needs-decision";

  let mentionPart = "";
  if (needsAttention && targetProject?.slack_user_id) {
    mentionPart = `<@${targetProject.slack_user_id}> `;
  }

  let threadBody = `${mentionPart}${icon} Task ${options.taskId} ${options.event}.`;
  if (options.compactSummary) {
    threadBody += `\n${options.compactSummary}`;
  } else if (options.resultSummary) {
    threadBody += `\n${options.resultSummary}`;
  }
  if (options.errorDetails && needsAttention) {
    const errorSnippet = options.errorDetails.split("\n").slice(-10).join("\n");
    threadBody += `\n\`\`\`\n${errorSnippet}\n\`\`\``;
  }

  // Post under thread
  await postSlackMessage(
    rootDir,
    {
      channel,
      text: threadBody,
      threadTs: rootTs,
      project: targetProject?.id,
    },
    logger
  );

  return { rootTs };
}
