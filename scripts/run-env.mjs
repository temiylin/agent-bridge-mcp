#!/usr/bin/env node

/**
 * scripts/run-env.mjs
 * Cross-platform environment variable wrapper and command runner.
 *
 * Usage:
 *   node scripts/run-env.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [args...]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function printUsageAndExit() {
  console.error(`Usage: node scripts/run-env.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [args...]

Sets environment variables and executes <command> with shell: false.

Examples:
  node scripts/run-env.mjs AGENT_BRIDGE_ROOT=/tmp/test -- tsx test/test-runner.ts
  node scripts/run-env.mjs FOO=1 BAR=2 -- node app.js
`);
  process.exit(2);
}

function resolveTsxCli() {
  // Option 1: check project node_modules/tsx/dist/cli.mjs
  const localCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (fs.existsSync(localCli)) {
    return localCli;
  }
  // Option 2: resolve via module loader
  try {
    const require = createRequire(import.meta.url);
    const tsxEntry = require.resolve("tsx");
    const cliCandidate = path.join(path.dirname(tsxEntry), "cli.mjs");
    if (fs.existsSync(cliCandidate)) {
      return cliCandidate;
    }
  } catch {}
  return null;
}

function isCommandInPath(cmd) {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = path.join(dir, cmd);
    try {
      if (fs.existsSync(fullPath)) {
        return true;
      }
    } catch {}
  }
  return false;
}

const rawArgs = process.argv.slice(2);
const dashDashIndex = rawArgs.indexOf("--");

// Validate -- presence and command existence
if (dashDashIndex === -1 || dashDashIndex === rawArgs.length - 1) {
  printUsageAndExit();
}

const envArgs = rawArgs.slice(0, dashDashIndex);
const cmdArgs = rawArgs.slice(dashDashIndex + 1);

if (cmdArgs.length === 0) {
  printUsageAndExit();
}

// Parse KEY=VALUE pairs
const envOverrides = {};
for (const envArg of envArgs) {
  const eqIdx = envArg.indexOf("=");
  if (eqIdx <= 0) {
    console.error(`Error: Invalid environment variable syntax '${envArg}'. Expected KEY=VALUE.`);
    printUsageAndExit();
  }
  const key = envArg.slice(0, eqIdx);
  const value = envArg.slice(eqIdx + 1);
  envOverrides[key] = value;
}

const command = cmdArgs[0];
const args = cmdArgs.slice(1);

let spawnCommand = command;
let spawnArgs = args;

// On Windows (or when tsx is not in PATH), resolve tsx to node executable + cli.mjs without shell
if (command === "tsx") {
  const tsxCli = resolveTsxCli();
  if (process.platform === "win32") {
    if (tsxCli) {
      spawnCommand = process.execPath;
      spawnArgs = [tsxCli, ...args];
    } else {
      spawnCommand = "tsx.cmd";
    }
  } else if (tsxCli && !isCommandInPath("tsx")) {
    spawnCommand = process.execPath;
    spawnArgs = [tsxCli, ...args];
  }
}

const childEnv = { ...process.env, ...envOverrides };

const child = spawn(spawnCommand, spawnArgs, {
  stdio: "inherit",
  shell: false,
  env: childEnv,
});

child.on("error", (err) => {
  console.error(`run-env child process error: ${err.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (code !== null && code !== undefined) {
    process.exit(code);
  } else if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
  } else {
    process.exit(0);
  }
});
