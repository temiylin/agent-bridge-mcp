import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface BridgeDirectories {
  rootDir: string;
  tasksDir: string;
  resultsDir: string;
  logsDir: string;
}

/**
 * Resolves the root directory from the AGENT_BRIDGE_ROOT environment variable.
 * Defaults to ~/agent-bridge if unset or empty.
 * Correctly expands tilde (~) to the user's home directory.
 */
export function resolveBridgeRoot(): string {
  const envRoot = process.env.AGENT_BRIDGE_ROOT;
  let rootPath: string;

  if (!envRoot || envRoot.trim() === "") {
    rootPath = path.join(os.homedir(), "agent-bridge");
  } else {
    const trimmed = envRoot.trim();
    if (trimmed === "~") {
      rootPath = os.homedir();
    } else if (trimmed.startsWith("~" + path.sep) || trimmed.startsWith("~/")) {
      rootPath = path.join(os.homedir(), trimmed.slice(2));
    } else {
      rootPath = trimmed;
    }
  }

  return path.resolve(rootPath);
}

/**
 * Ensures that the required directories ($AGENT_BRIDGE_ROOT/tasks, results, logs) exist.
 * Automatically creates them recursively if they do not exist.
 */
export function ensureBridgeDirectories(rootDir: string = resolveBridgeRoot()): BridgeDirectories {
  const tasksDir = path.join(rootDir, "tasks");
  const resultsDir = path.join(rootDir, "results");
  const logsDir = path.join(rootDir, "logs");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  return { rootDir, tasksDir, resultsDir, logsDir };
}
