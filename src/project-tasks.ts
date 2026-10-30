import fs from "node:fs";
import path from "node:path";
import { resolveBridgeRoot } from "./config.js";
import { readStatus, TaskStatusInfo } from "./status.js";
import { loadProjectsConfig } from "./project-router.js";
import { BridgeLogger } from "./logger.js";

export interface ProjectTaskInfo {
  taskId: string;
  project: string;
  agent?: string;
  state: string;
  startedAt?: string;
  elapsedSeconds: number;
  lastOutputLine: string;
}

export function listProjectTasks(
  rootDir: string,
  projectId: string,
  logger?: BridgeLogger
): ProjectTaskInfo[] {
  const statusDir = path.join(rootDir, "status");
  const tasksDir = path.join(rootDir, "tasks");
  const logsDir = path.join(rootDir, "logs");

  const results: ProjectTaskInfo[] = [];

  if (!fs.existsSync(statusDir)) {
    return results;
  }

  const files = fs.readdirSync(statusDir);
  for (const f of files) {
    if (!f.endsWith(".json") || f.includes(".tmp")) continue;
    const taskId = f.replace(/\.json$/, "");
    const status = readStatus(rootDir, taskId);
    if (!status) continue;

    // Filter to running tasks (running or queued)
    if (status.state !== "running" && status.state !== "queued") {
      continue;
    }

    // Check project association from task file or status
    let taskProjectId = "";
    const taskFilePath = path.join(tasksDir, `${taskId}.md`);
    if (fs.existsSync(taskFilePath)) {
      try {
        const content = fs.readFileSync(taskFilePath, "utf8");
        const match = content.match(/- \*\*Project ID\*\*:\s*([^\r\n]+)/i);
        if (match) taskProjectId = match[1].trim();
      } catch {}
    }

    if (taskProjectId.toLowerCase() !== projectId.toLowerCase()) {
      continue;
    }

    // Calculate elapsed
    let elapsed = 0;
    if (status.startedAt) {
      elapsed = Math.max(0, Math.round((Date.now() - new Date(status.startedAt).getTime()) / 1000));
    }

    // Read last output line from logs/<taskId>.out
    let lastLine = "";
    const outPath = path.join(logsDir, `${taskId}.out`);
    if (fs.existsSync(outPath)) {
      try {
        const outText = fs.readFileSync(outPath, "utf8");
        const lines = outText.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          lastLine = lines[lines.length - 1];
        }
      } catch {}
    }

    results.push({
      taskId,
      project: projectId,
      agent: status.agent,
      state: status.state,
      startedAt: status.startedAt,
      elapsedSeconds: elapsed,
      lastOutputLine: lastLine,
    });
  }

  return results;
}
