import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveBridgeRoot } from "./config.js";
import { loadProjectsConfig } from "./project-router.js";
import { readStatus } from "./status.js";
import { BridgeLogger } from "./logger.js";

export interface SlackPostOptions {
  project?: string;
  channel?: string;
  text: string;
  threadTs?: string;
  botToken?: string;
}

export interface SlackPostResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export function resolveSlackBotToken(rootDir: string = resolveBridgeRoot()): string | undefined {
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_BOT_TOKEN.trim()) {
    return process.env.SLACK_BOT_TOKEN.trim();
  }
  // Check rootDir/.env
  const envFile = path.join(rootDir, ".env");
  if (fs.existsSync(envFile)) {
    try {
      const content = fs.readFileSync(envFile, "utf8");
      const match = content.match(/^SLACK_BOT_TOKEN=(.+)$/m);
      if (match && match[1].trim()) {
        return match[1].trim();
      }
    } catch {}
  }
  return undefined;
}

/**
 * Call Slack Web API via HTTPS.
 */
export async function callSlackApi(
  method: string,
  token: string,
  payload: Record<string, any>
): Promise<any> {
  const postData = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://slack.com/api/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Authorization": `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed);
          } catch (e) {
            resolve({ ok: false, error: "invalid_json_response", raw: body });
          }
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

/**
 * Posts a message to Slack using Bot Token or Webhook.
 */
export async function postSlackMessage(
  rootDir: string,
  options: SlackPostOptions,
  logger?: BridgeLogger
): Promise<SlackPostResult> {
  const token = options.botToken || resolveSlackBotToken(rootDir);
  const config = loadProjectsConfig(rootDir);

  let targetChannel = options.channel;
  if (!targetChannel && options.project) {
    const proj = config.projects[options.project];
    if (proj?.slack_channel) {
      targetChannel = proj.slack_channel;
    }
  }
  if (!targetChannel) {
    targetChannel = config.default_channel || undefined;
  }

  // If we have a Bot Token (xoxb), use chat.postMessage
  if (token && targetChannel) {
    try {
      const resp = await callSlackApi("chat.postMessage", token, {
        channel: targetChannel,
        text: options.text,
        thread_ts: options.threadTs,
      });
      if (resp.ok) {
        return { ok: true, ts: resp.ts, channel: targetChannel };
      }
      return { ok: false, error: resp.error || "slack_api_error", channel: targetChannel };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // Fallback to Webhook if configured
  let webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (options.project) {
    const proj = config.projects[options.project];
    if (proj?.slack_webhook_env && process.env[proj.slack_webhook_env]) {
      webhookUrl = process.env[proj.slack_webhook_env];
    }
  }

  if (webhookUrl) {
    try {
      const postData = JSON.stringify({ text: options.text });
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
        req.on("error", reject);
        req.write(postData);
        req.end();
      });
      return { ok: true, channel: targetChannel };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  return { ok: false, error: "Neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL available or no channel resolved" };
}

/**
 * Updates an existing Slack message (e.g. for S1 root emoji or S5 success edit).
 */
export async function updateSlackMessage(
  rootDir: string,
  channel: string,
  ts: string,
  text: string,
  blocks?: any[],
  logger?: BridgeLogger
): Promise<boolean> {
  const token = resolveSlackBotToken(rootDir);
  if (!token) return false;

  try {
    const resp = await callSlackApi("chat.update", token, {
      channel,
      ts,
      text,
      ...(blocks ? { blocks } : {}),
    });
    return resp.ok === true;
  } catch (err: any) {
    logger?.warn(`updateSlackMessage error: ${err?.message || String(err)}`);
    return false;
  }
}
