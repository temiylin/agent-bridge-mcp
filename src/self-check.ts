import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBridgeRoot } from "./config.js";
import { loadAgents, AgentRegistry } from "./agents.js";
import { checkWorkerLiveness } from "./worker-alive.js";

export interface AgentCheckResult {
  name: string;
  command: string;
  runs: boolean;
  version?: string;
  error?: string;
}

export interface SelfCheckReport {
  ok: boolean;
  worker: {
    alive: boolean;
    pid?: number;
    lastHeartbeat?: string;
    details?: string;
  };
  agents: AgentCheckResult[];
}

/**
 * Runs self-check against the local worker process and registered agent binaries.
 */
export function runSelfCheck(rootDir: string = resolveBridgeRoot()): SelfCheckReport {
  // 1. Worker check
  const workerStatus = checkWorkerLiveness(rootDir);
  const workerAlive = workerStatus.alive;

  // 2. Agents check
  const agentResults: AgentCheckResult[] = [];
  let registry: AgentRegistry = {};
  try {
    registry = loadAgents(rootDir);
  } catch (err: any) {
    // Registry not found or invalid
  }

  for (const [name, config] of Object.entries(registry)) {
    const cmd = config.command;
    try {
      // Try --version first
      const testRun = spawnSync(cmd, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        shell: false,
      });

      if (testRun.status === 0) {
        const ver = (testRun.stdout || testRun.stderr || "").trim().split("\n")[0];
        agentResults.push({
          name,
          command: cmd,
          runs: true,
          version: ver,
        });
      } else {
        // Fallback to -v or help
        const fallback = spawnSync(cmd, ["-v"], {
          encoding: "utf8",
          timeout: 5000,
          shell: false,
        });
        if (fallback.status === 0) {
          const ver = (fallback.stdout || fallback.stderr || "").trim().split("\n")[0];
          agentResults.push({
            name,
            command: cmd,
            runs: true,
            version: ver,
          });
        } else {
          agentResults.push({
            name,
            command: cmd,
            runs: false,
            error: testRun.stderr || testRun.stdout || `Process exited with code ${testRun.status}`,
          });
        }
      }
    } catch (err: any) {
      agentResults.push({
        name,
        command: cmd,
        runs: false,
        error: err?.message || String(err),
      });
    }
  }

  const allAgentsOk = agentResults.length > 0 ? agentResults.every((a) => a.runs) : true;
  const overallOk = workerAlive && allAgentsOk;

  return {
    ok: overallOk,
    worker: {
      alive: workerAlive,
      pid: workerStatus.pid,
      lastHeartbeat: workerStatus.lastHeartbeat,
      details: workerStatus.alive ? "Worker process is running and active" : "Worker process not responding or inactive",
    },
    agents: agentResults,
  };
}

// CLI execution if executed directly
if (process.argv[1] && process.argv[1].endsWith("self-check.ts")) {
  const report = runSelfCheck();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
