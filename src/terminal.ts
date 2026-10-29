import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

/**
 * Checks for high-risk destructive commands that should never be executed blindly.
 */
function isDangerousCommand(cmd: string): boolean {
  const trimmed = cmd.trim().toLowerCase();
  const dangerousPatterns = [
    /\brm\s+-[rf]{1,2}\s+[\/\\]/i,             // rm -rf / or rm -fr /
    /\brm\s+-[rf]{1,2}\s+~\s*$/i,              // rm -rf ~
    /\bmkfs\b/i,                               // format disk
    /\bfdisk\b/i,
    /\bdd\s+if=.*of=\/dev\/(r?disk|sd|nvme)/i, // raw disk overwrite
    /:{\s*:\|:&\s*};:/,                        // fork bomb
    /\bdel\s+\/[sfq]\s+c:\\/i,                 // windows del /s c:\
    /\bformat\s+[c-z]:/i,                      // windows format c:
  ];

  return dangerousPatterns.some((p) => p.test(trimmed));
}

export function registerTerminalTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  server.tool(
    "execute_command",
    "Execute a shell or terminal command directly on the host machine with timeout and streaming output capture.",
    {
      command: z.string().describe("Terminal command line string to execute (e.g., 'npm test', 'git status', 'docker ps')"),
      cwd: z.string().optional().describe("Working directory for command execution. Default: current project directory"),
      timeout_seconds: z.number().int().min(1).max(120).optional().describe("Maximum execution time in seconds (default: 30, max: 120)"),
      env_vars: z.record(z.string(), z.string()).optional().describe("Optional extra environment variables to inject"),
    },
    async ({ command, cwd, timeout_seconds, env_vars }) => {
      audit(rootDir, { tool: "execute_command" });

      if (!command || typeof command !== "string" || command.trim().length === 0) {
        return { isError: true, content: [{ type: "text", text: "Error: command must be a non-empty string." }] };
      }

      if (isDangerousCommand(command)) {
        logger.warn(`execute_command rejected dangerous command: "${command}"`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Security Blocked: Command "${command}" was identified as potentially destructive and blocked by safety guardrails.`,
            },
          ],
        };
      }

      const workingDir = cwd ? path.resolve(cwd) : process.cwd();
      if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Working directory does not exist or is not a directory: "${workingDir}".` }],
        };
      }

      const timeoutMs = Math.max(1, Math.min(120, timeout_seconds || 30)) * 1000;
      const startTime = Date.now();

      return new Promise((resolve) => {
        const isWin = process.platform === "win32";
        const pathSep = isWin ? ";" : ":";
        const extraPaths = isWin
          ? [
              path.join(process.env.APPDATA || "", "npm"),
              path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
              path.join(os.homedir(), ".cargo", "bin"),
            ].filter((p) => p && fs.existsSync(p))
          : [
              "/opt/homebrew/bin",
              "/usr/local/bin",
              path.join(os.homedir(), ".local", "bin"),
              path.join(os.homedir(), ".cargo", "bin"),
            ].filter((p) => fs.existsSync(p));

        const currentPath = process.env.PATH || (isWin ? "" : "/usr/bin:/bin:/usr/sbin:/sbin");
        const combinedPath = Array.from(new Set([...extraPaths, ...currentPath.split(pathSep)].filter(Boolean))).join(pathSep);

        const env = {
          ...process.env,
          PATH: combinedPath,
          HOME: process.env.HOME || os.homedir(),
          TERM: "xterm-256color",
          ...(env_vars || {}),
        };

        const shell = isWin ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
        const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const MAX_OUTPUT = 32000; // 32KB output limit

        const child = spawn(shell, shellArgs, {
          cwd: workingDir,
          env,
          shell: false,
          windowsHide: true,
        });

        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            if (isWin) {
              try {
                spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
              } catch {}
            } else {
              try {
                child.kill("SIGKILL");
              } catch {}
            }
          }
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdout.length < MAX_OUTPUT) {
            stdout += chunk.toString("utf8");
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT) {
            stderr += chunk.toString("utf8");
          }
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          const elapsed = Date.now() - startTime;
          const exitCode = timedOut ? -1 : (code !== null ? code : 1);

          resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    command,
                    cwd: workingDir,
                    exitCode,
                    success: exitCode === 0,
                    executionTimeMs: elapsed,
                    timedOut,
                    stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n...[stdout truncated at 32KB]" : stdout,
                    stderr: stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n...[stderr truncated at 32KB]" : stderr,
                  },
                  null,
                  2
                ),
              },
            ],
          });
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          const elapsed = Date.now() - startTime;
          resolve({
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    command,
                    cwd: workingDir,
                    error: err.message,
                    executionTimeMs: elapsed,
                  },
                  null,
                  2
                ),
              },
            ],
          });
        });
      });
    }
  );
}
