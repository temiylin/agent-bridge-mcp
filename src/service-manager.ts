import http from "node:http";
import https from "node:https";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { resolveBridgeRoot } from "./config.js";
import { loadProjectsConfig, ServiceConfig } from "./project-router.js";
import { BridgeLogger } from "./logger.js";

export interface RestartServiceResult {
  success: boolean;
  service: string;
  project: string;
  port: number;
  healthUrl: string;
  killedPid?: number;
  newPid?: number;
  httpStatus?: number;
  error?: string;
}

/**
 * Finds listening PID on a given port.
 */
export function findListeningPid(port: number): number | null {
  const isWin = process.platform === "win32";
  if (isWin) {
    try {
      const res = spawnSync("netstat", ["-ano", "-p", "TCP"], {
        shell: false,
        timeout: 5000,
        encoding: "utf8",
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.split(/\r?\n/);
        const pattern = `:${port} `;
        for (const line of lines) {
          if (line.includes("LISTENING") && line.includes(pattern)) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1], 10);
            if (!Number.isNaN(pid) && pid > 0) return pid;
          }
        }
      }
    } catch {}
  } else {
    try {
      const res = spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-n"], {
        shell: false,
        timeout: 5000,
        encoding: "utf8",
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.trim().split("\n");
        if (lines.length > 1) {
          const parts = lines[1].trim().split(/\s+/);
          const pid = parseInt(parts[1], 10);
          if (!Number.isNaN(pid) && pid > 0) return pid;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Checks HTTP health URL and returns HTTP status code.
 */
export function checkHttpHealth(url: string, timeoutMs: number = 5000): Promise<{ status: number; ok: boolean }> {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === "https:" ? https : http;
      const req = transport.request(
        parsedUrl,
        {
          method: "GET",
          timeout: timeoutMs,
          headers: { "User-Agent": "agent-bridge-health-check" },
        },
        (res) => {
          const status = res.statusCode || 0;
          res.resume();
          resolve({ status, ok: status >= 200 && status < 400 });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Health check timed out after ${timeoutMs}ms`));
      });
      req.on("error", (err) => reject(err));
      req.end();
    } catch (err: any) {
      reject(err);
    }
  });
}

/**
 * Restarts a configured project service.
 */
export async function restartService(
  rootDir: string,
  projectId: string,
  serviceName: string,
  logger?: BridgeLogger
): Promise<RestartServiceResult> {
  const config = loadProjectsConfig(rootDir);
  const proj = config.projects[projectId];
  if (!proj) {
    return {
      success: false,
      service: serviceName,
      project: projectId,
      port: 0,
      healthUrl: "",
      error: `Project "${projectId}" not found in projects.json`,
    };
  }

  const srv = proj.services?.[serviceName];
  if (!srv) {
    return {
      success: false,
      service: serviceName,
      project: projectId,
      port: 0,
      healthUrl: "",
      error: `Service "${serviceName}" not configured under project "${projectId}". Available services: [${Object.keys(proj.services || {}).join(", ")}]`,
    };
  }

  const port = srv.port;
  const healthUrl = srv.health_url;
  const command = srv.command;
  const cwd = srv.cwd || proj.paths?.[0] || process.cwd();

  // 1. Kill existing listener if present
  let killedPid: number | undefined;
  const existingPid = findListeningPid(port);
  if (existingPid && existingPid !== process.pid) {
    logger?.info(`restart_service: Killing existing listener on port ${port} (PID: ${existingPid})`);
    try {
      process.kill(existingPid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      if (findListeningPid(port) === existingPid) {
        process.kill(existingPid, "SIGKILL");
        await new Promise((r) => setTimeout(r, 500));
      }
      killedPid = existingPid;
    } catch (killErr: any) {
      logger?.warn(`restart_service: Error killing PID ${existingPid}: ${killErr?.message || String(killErr)}`);
    }
  }

  // 2. Start new service process detached
  logger?.info(`restart_service: Starting service "${serviceName}" with command "${command}" in ${cwd}`);
  const isWin = process.platform === "win32";
  const shellCmd = isWin ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

  const child: ChildProcess = spawn(shellCmd, shellArgs, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(srv.env || {}) },
  });

  const newPid = child.pid;
  child.unref();

  // 3. Health-check loop
  const maxWaitSec = srv.health_timeout_seconds || 15;
  const startMs = Date.now();
  let lastStatus = 0;
  let healthy = false;

  while (Date.now() - startMs < maxWaitSec * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await checkHttpHealth(healthUrl, 2000);
      lastStatus = res.status;
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch (hErr: any) {
      // not yet up
    }
  }

  return {
    success: healthy,
    service: serviceName,
    project: projectId,
    port,
    healthUrl,
    killedPid,
    newPid,
    httpStatus: lastStatus || undefined,
    error: healthy ? undefined : `Service health check failed after ${maxWaitSec}s (last status: ${lastStatus || "unreachable"})`,
  };
}
