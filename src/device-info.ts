import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

export function registerDeviceInfoTool(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  server.tool(
    "device_info",
    "Get read-only system and hardware environment overview (hostname, OS, CPU, memory, disk, process count, network interfaces, runtime versions).",
    {},
    async () => {
      audit(rootDir, { tool: "device_info" });

      try {
        // 1. Hostname & OS
        const hostname = os.hostname();
        const platform = os.platform();
        const release = os.release();
        const osVersion = os.version();

        // 2. CPU & Memory
        const cpus = os.cpus();
        const cpuInfo = {
          architecture: os.arch(),
          model: cpus[0]?.model || "unknown",
          cores: cpus.length,
        };

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const memoryInfo = {
          totalBytes: totalMem,
          freeBytes: freeMem,
          usedPercentage: totalMem > 0 ? Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1)) : 0,
        };

        // 3. Disk Space (using Node native statfsSync)
        let diskInfo: { totalBytes: number; freeBytes: number; availableBytes: number; freePercentage: number } | null = null;
        try {
          const rootDrive = process.platform === "win32" ? (path.parse(process.cwd()).root || "C:\\") : "/";
          const stat = fs.statfsSync(rootDrive);
          const totalBytes = Number(stat.blocks) * Number(stat.bsize);
          const freeBytes = Number(stat.bfree) * Number(stat.bsize);
          const availableBytes = Number(stat.bavail) * Number(stat.bsize);
          diskInfo = {
            totalBytes,
            freeBytes,
            availableBytes,
            freePercentage: totalBytes > 0 ? Number(((freeBytes / totalBytes) * 100).toFixed(1)) : 0,
          };
        } catch (err: any) {
          logger.warn(`device_info: statfsSync error: ${err?.message || String(err)}`);
        }

        // 4. Running Processes Count (strictly count only, no parameters or process names)
        let runningProcessCount = 0;
        try {
          if (process.platform === "win32") {
            const tasklistRes = spawnSync("tasklist", ["/fo", "csv", "/nh"], {
              shell: false,
              timeout: 3000,
              encoding: "utf8",
            });
            if (tasklistRes.status === 0 && typeof tasklistRes.stdout === "string") {
              runningProcessCount = tasklistRes.stdout.trim().split(/\r?\n/).filter(Boolean).length;
            }
          } else {
            const psResult = spawnSync("ps", ["-A", "-o", "pid="], {
              shell: false,
              timeout: 3000,
              encoding: "utf8",
            });
            if (psResult.status === 0 && typeof psResult.stdout === "string") {
              runningProcessCount = psResult.stdout.trim().split("\n").filter(Boolean).length;
            }
          }
        } catch (err: any) {
          logger.warn(`device_info: error counting processes: ${err?.message || String(err)}`);
        }

        // 5. Network Interfaces (address, family, internal only - NO MAC or credentials)
        const networkSummary: Record<string, Array<{ address: string; family: string; internal: boolean }>> = {};
        const interfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(interfaces)) {
          if (addrs) {
            networkSummary[name] = addrs.map((a) => ({
              address: a.address,
              family: a.family,
              internal: a.internal,
            }));
          }
        }

        // 6. Runtime Versions
        const nodeVersion = process.version;
        let gitVersion = "unknown";
        try {
          const gitRes = spawnSync("git", ["--version"], {
            shell: false,
            timeout: 3000,
            encoding: "utf8",
          });
          if (gitRes.status === 0 && typeof gitRes.stdout === "string") {
            gitVersion = gitRes.stdout.trim();
          }
        } catch {}

        const result = {
          hostname,
          os: {
            platform,
            release,
            version: osVersion,
          },
          cpu: cpuInfo,
          memory: memoryInfo,
          disk: diskInfo,
          runningProcessCount,
          network: networkSummary,
          runtimes: {
            node: nodeVersion,
            git: gitVersion,
          },
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`device_info: unexpected error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving device_info: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  // check_port
  server.tool(
    "check_port",
    "Inspect local TCP port status to determine if it is currently in use, and identify the listening process PID and command.",
    {
      port: z.number().int().min(1).max(65535).describe("TCP Port number to inspect (1-65535)"),
    },
    async ({ port }) => {
      audit(rootDir, { tool: "check_port" });

      const isWin = process.platform === "win32";
      try {
        if (isWin) {
          const res = spawnSync("netstat", ["-ano", "-p", "TCP"], {
            shell: false,
            timeout: 5000,
            encoding: "utf8",
          });
          if (res.status === 0 && typeof res.stdout === "string") {
            const lines = res.stdout.split(/\r?\n/);
            const targetPattern = `:${port} `;
            for (const line of lines) {
              if (line.includes("LISTENING") && line.includes(targetPattern)) {
                const parts = line.trim().split(/\s+/);
                const pidStr = parts[parts.length - 1];
                const pid = parseInt(pidStr, 10);

                let processName = "unknown";
                if (!Number.isNaN(pid)) {
                  try {
                    const taskRes = spawnSync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
                      shell: false,
                      timeout: 3000,
                      encoding: "utf8",
                    });
                    if (taskRes.status === 0 && typeof taskRes.stdout === "string") {
                      const match = taskRes.stdout.match(/"([^"]+)"/);
                      if (match) processName = match[1];
                    }
                  } catch {}
                }

                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          port,
                          inUse: true,
                          protocol: "TCP",
                          status: "LISTENING",
                          pid: !Number.isNaN(pid) ? pid : undefined,
                          processName,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }
            }
          }
        } else {
          // macOS / Linux: use lsof
          const res = spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-n"], {
            shell: false,
            timeout: 5000,
            encoding: "utf8",
          });
          if (res.status === 0 && typeof res.stdout === "string" && res.stdout.trim().length > 0) {
            const lines = res.stdout.trim().split("\n");
            if (lines.length > 1) {
              const parts = lines[1].trim().split(/\s+/);
              const command = parts[0];
              const pid = parseInt(parts[1], 10);
              const user = parts[2];

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        port,
                        inUse: true,
                        protocol: "TCP",
                        status: "LISTENING",
                        command,
                        pid: !Number.isNaN(pid) ? pid : undefined,
                        user,
                      },
                      null,
                      2
                    ),
                  },
                ],
              };
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  port,
                  inUse: false,
                  status: "FREE",
                  message: `Port ${port} is free and not currently in use by any listening process.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`check_port error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error checking port: ${err?.message || String(err)}` }] };
      }
    }
  );
}
