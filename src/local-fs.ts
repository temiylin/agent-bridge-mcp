import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";

/**
 * Checks whether a target path attempts to access sensitive system or user credentials.
 * Blocks access to SSH keys, cloud tokens, GPG, kubeconfig, shadow/passwd, and private key formats.
 */
export function isBlockedCredentialPath(targetPath: string): boolean {
  const normalized = path.normalize(path.resolve(targetPath)).toLowerCase();
  const home = os.homedir().toLowerCase();

  // Blocked directories relative to user home
  const sensitiveHomeDirs = [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
  ];

  for (const dir of sensitiveHomeDirs) {
    if (normalized === dir.toLowerCase() || normalized.startsWith(dir.toLowerCase() + path.sep)) {
      return true;
    }
  }

  // Blocked sensitive system authentication files
  const blockedSystemFiles = [
    "/etc/shadow",
    "/etc/master.passwd",
    "/etc/sudoers",
    "/private/etc/shadow",
    "/private/etc/master.passwd",
    "/private/etc/sudoers",
  ];

  for (const sysFile of blockedSystemFiles) {
    if (normalized === sysFile.toLowerCase()) {
      return true;
    }
  }

  // Block private key and certificate formats anywhere
  const baseName = path.basename(normalized);
  if (
    baseName === "id_rsa" ||
    baseName === "id_ed25519" ||
    baseName === "id_ecdsa" ||
    baseName === "id_dsa" ||
    baseName.endsWith(".pem") ||
    baseName.endsWith(".key") ||
    baseName.endsWith(".p12") ||
    baseName.endsWith(".keystore")
  ) {
    return true;
  }

  return false;
}

export function registerLocalFsTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  // 1. list_directory
  server.tool(
    "list_directory",
    "List files and subdirectories in a local directory path with metadata and size.",
    {
      path: z.string().describe("Absolute directory path to list"),
      show_hidden: z.boolean().optional().describe("Whether to include hidden files (dotfiles). Default false"),
    },
    async ({ path: dirPath, show_hidden }) => {
      audit(rootDir, { tool: "list_directory" });

      if (!dirPath || typeof dirPath !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: path must be a non-empty string." }] };
      }
      if (!path.isAbsolute(dirPath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path must be an absolute path: "${dirPath}".` }] };
      }
      if (isBlockedCredentialPath(dirPath)) {
        return { isError: true, content: [{ type: "text", text: `Access denied: path "${dirPath}" is blocked by security policy for credential protection.` }] };
      }
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return { isError: true, content: [{ type: "text", text: `Error: path does not exist or is not a directory: "${dirPath}".` }] };
      }

      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const includeHidden = Boolean(show_hidden);
        const items: Array<{
          name: string;
          type: "file" | "directory" | "symlink" | "other";
          sizeBytes?: number;
          modifiedAt?: string;
        }> = [];

        for (const entry of entries) {
          if (!includeHidden && entry.name.startsWith(".")) {
            continue;
          }
          const fullEntryPath = path.join(dirPath, entry.name);
          let type: "file" | "directory" | "symlink" | "other" = "other";
          let sizeBytes: number | undefined = undefined;
          let modifiedAt: string | undefined = undefined;

          if (entry.isFile()) {
            type = "file";
            try {
              const stat = fs.statSync(fullEntryPath);
              sizeBytes = stat.size;
              modifiedAt = stat.mtime.toISOString();
            } catch {}
          } else if (entry.isDirectory()) {
            type = "directory";
            try {
              const stat = fs.statSync(fullEntryPath);
              modifiedAt = stat.mtime.toISOString();
            } catch {}
          } else if (entry.isSymbolicLink()) {
            type = "symlink";
          }

          items.push({
            name: entry.name,
            type,
            ...(sizeBytes !== undefined ? { sizeBytes } : {}),
            ...(modifiedAt !== undefined ? { modifiedAt } : {}),
          });
        }

        // Sort directories first, then alphabetically
        items.sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });

        const MAX_ITEMS = 300;
        const totalCount = items.length;
        const sliced = items.slice(0, MAX_ITEMS);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  directory: dirPath,
                  totalItems: totalCount,
                  returnedItems: sliced.length,
                  hasMore: totalCount > MAX_ITEMS,
                  items: sliced,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`list_directory error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error listing directory: ${err?.message || String(err)}` }] };
      }
    }
  );

  // 2. read_file
  server.tool(
    "read_file",
    "Read text content of a local file with offset, length limit, and binary protection.",
    {
      path: z.string().describe("Absolute path to the file"),
      offset: z.number().int().optional().describe("Byte offset to start reading from (default: 0)"),
      length: z.number().int().optional().describe("Number of bytes to read (default: 8000, max: 64000)"),
    },
    async ({ path: filePath, offset, length }) => {
      audit(rootDir, { tool: "read_file" });

      if (!filePath || typeof filePath !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: path must be a non-empty string." }] };
      }
      if (!path.isAbsolute(filePath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path must be an absolute path: "${filePath}".` }] };
      }
      if (isBlockedCredentialPath(filePath)) {
        return { isError: true, content: [{ type: "text", text: `Access denied: path "${filePath}" is blocked by security policy for credential protection.` }] };
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { isError: true, content: [{ type: "text", text: `Error: path does not exist or is not a regular file: "${filePath}".` }] };
      }

      try {
        const stat = fs.statSync(filePath);
        const startOffset = Math.max(0, typeof offset === "number" && !Number.isNaN(offset) ? offset : 0);
        const reqLength = typeof length === "number" && !Number.isNaN(length) ? length : 8000;
        const readLength = Math.max(1, Math.min(64000, reqLength));

        if (startOffset >= stat.size) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    path: filePath,
                    totalBytes: stat.size,
                    offset: startOffset,
                    bytesRead: 0,
                    eof: true,
                    content: "",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const toRead = Math.min(readLength, stat.size - startOffset);
        const buffer = Buffer.alloc(toRead);
        const fd = fs.openSync(filePath, "r");
        let bytesRead = 0;
        try {
          bytesRead = fs.readSync(fd, buffer, 0, toRead, startOffset);
        } finally {
          fs.closeSync(fd);
        }

        // Check if binary (presence of null bytes in slice)
        const slice = buffer.slice(0, bytesRead);
        let isBinary = false;
        for (let i = 0; i < slice.length; i++) {
          if (slice[i] === 0) {
            isBinary = true;
            break;
          }
        }

        if (isBinary) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    path: filePath,
                    totalBytes: stat.size,
                    offset: startOffset,
                    bytesRead,
                    eof: startOffset + bytesRead >= stat.size,
                    isBinary: true,
                    message: "Binary file content suppressed to avoid corruption.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const textContent = slice.toString("utf8");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  path: filePath,
                  totalBytes: stat.size,
                  offset: startOffset,
                  bytesRead,
                  eof: startOffset + bytesRead >= stat.size,
                  content: textContent,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`read_file error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error reading file: ${err?.message || String(err)}` }] };
      }
    }
  );

  // 3. get_file_info
  server.tool(
    "get_file_info",
    "Get detailed filesystem metadata and permissions for a file or directory path.",
    {
      path: z.string().describe("Absolute file or directory path"),
    },
    async ({ path: targetPath }) => {
      audit(rootDir, { tool: "get_file_info" });

      if (!targetPath || typeof targetPath !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: path must be a non-empty string." }] };
      }
      if (!path.isAbsolute(targetPath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path must be an absolute path: "${targetPath}".` }] };
      }
      if (isBlockedCredentialPath(targetPath)) {
        return { isError: true, content: [{ type: "text", text: `Access denied: path "${targetPath}" is blocked by security policy for credential protection.` }] };
      }
      if (!fs.existsSync(targetPath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path does not exist: "${targetPath}".` }] };
      }

      try {
        const stat = fs.lstatSync(targetPath);
        const info = {
          path: targetPath,
          exists: true,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          isSymbolicLink: stat.isSymbolicLink(),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          accessedAt: stat.atime.toISOString(),
          createdAt: stat.birthtime ? stat.birthtime.toISOString() : undefined,
          permissions: (stat.mode & 0o777).toString(8),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`get_file_info error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error getting file info: ${err?.message || String(err)}` }] };
      }
    }
  );
}
