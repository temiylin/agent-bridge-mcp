import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
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
    "List files and subdirectories in a local directory path with optional recursion depth and smart noise filtering.",
    {
      path: z.string().describe("Absolute directory path to list"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Directory recursion depth (1: flat contents only, 2: include immediate subdirectories, max: 5). Default: 1"),
      show_hidden: z.boolean().optional().describe("Whether to include hidden files (dotfiles). Default false"),
      ignore_patterns: z
        .array(z.string())
        .optional()
        .describe("Folder or file names to ignore during listing (e.g. ['node_modules', 'dist']). Default ignores common build and cache directories."),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ path: dirPath, depth, show_hidden, ignore_patterns }) => {
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
        const maxDepth = Math.max(1, Math.min(5, depth || 1));
        const includeHidden = Boolean(show_hidden);
        const defaultIgnores = new Set([
          "node_modules",
          ".git",
          ".next",
          ".nuxt",
          "dist",
          "build",
          "out",
          "coverage",
          ".turbo",
          "venv",
          ".venv",
          "__pycache__",
          ".idea",
          ".vscode",
          "target",
          "vendor",
          ...(ignore_patterns || []),
        ]);

        const MAX_ITEMS = 500;
        let totalCount = 0;
        let hasMore = false;

        interface DirItem {
          name: string;
          path: string;
          type: "file" | "directory" | "symlink" | "other";
          sizeBytes?: number;
          modifiedAt?: string;
          depth?: number;
        }

        const items: DirItem[] = [];

        function traverse(currentDir: string, currentDepth: number, relPrefix: string) {
          if (items.length >= MAX_ITEMS) {
            hasMore = true;
            return;
          }

          let entries: fs.Dirent[] = [];
          try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
          } catch {
            return;
          }

          const currentLevelDirs: Array<{ name: string; fullPath: string; relPath: string }> = [];

          for (const entry of entries) {
            if (!includeHidden && entry.name.startsWith(".")) {
              continue;
            }
            if (defaultIgnores.has(entry.name)) {
              continue;
            }

            const fullEntryPath = path.join(currentDir, entry.name);
            const relEntryPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
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
              if (currentDepth < maxDepth) {
                currentLevelDirs.push({ name: entry.name, fullPath: fullEntryPath, relPath: relEntryPath });
              }
            } else if (entry.isSymbolicLink()) {
              type = "symlink";
            }

            totalCount++;
            if (items.length < MAX_ITEMS) {
              items.push({
                name: entry.name,
                path: relEntryPath,
                type,
                ...(sizeBytes !== undefined ? { sizeBytes } : {}),
                ...(modifiedAt !== undefined ? { modifiedAt } : {}),
                ...(maxDepth > 1 ? { depth: currentDepth } : {}),
              });
            } else {
              hasMore = true;
            }
          }

          // Recurse into subdirectories if depth allows
          for (const sub of currentLevelDirs) {
            if (items.length >= MAX_ITEMS) {
              hasMore = true;
              break;
            }
            traverse(sub.fullPath, currentDepth + 1, sub.relPath);
          }
        }

        traverse(dirPath, 1, "");

        // Sort: directories first, then alphabetical by path
        items.sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.path.localeCompare(b.path);
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  directory: dirPath,
                  depth: maxDepth,
                  totalItems: totalCount,
                  returnedItems: items.length,
                  hasMore,
                  items,
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
    { readOnlyHint: true, destructiveHint: false },
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
    { readOnlyHint: true, destructiveHint: false },
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

  // 4. read_multiple_files
  server.tool(
    "read_multiple_files",
    "Read the text contents of multiple files in a single batch request, returning file contents and status per path.",
    {
      paths: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe("Array of absolute file paths to read (maximum 20 files per batch)"),
      max_bytes_per_file: z
        .number()
        .int()
        .min(100)
        .max(64000)
        .optional()
        .describe("Maximum bytes to read per file (default: 8000, max: 64000)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ paths: filePaths, max_bytes_per_file }) => {
      audit(rootDir, { tool: "read_multiple_files" });

      const byteLimit = Math.max(100, Math.min(64000, max_bytes_per_file || 8000));
      const results: Array<{
        path: string;
        success: boolean;
        error?: string;
        sizeBytes?: number;
        bytesRead?: number;
        isBinary?: boolean;
        truncated?: boolean;
        content?: string;
      }> = [];

      for (const filePath of filePaths) {
        if (!filePath || typeof filePath !== "string") {
          results.push({ path: String(filePath), success: false, error: "Path must be a non-empty string." });
          continue;
        }
        if (!path.isAbsolute(filePath)) {
          results.push({ path: filePath, success: false, error: `Path must be an absolute path: "${filePath}".` });
          continue;
        }
        if (isBlockedCredentialPath(filePath)) {
          results.push({ path: filePath, success: false, error: "Access denied by credential protection policy." });
          continue;
        }
        if (!fs.existsSync(filePath)) {
          results.push({ path: filePath, success: false, error: "File does not exist." });
          continue;
        }

        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            results.push({ path: filePath, success: false, error: "Path is not a regular file." });
            continue;
          }

          const toRead = Math.min(byteLimit, stat.size);
          const buffer = Buffer.alloc(toRead);
          const fd = fs.openSync(filePath, "r");
          let bytesRead = 0;
          try {
            bytesRead = fs.readSync(fd, buffer, 0, toRead, 0);
          } finally {
            fs.closeSync(fd);
          }

          const slice = buffer.slice(0, bytesRead);
          let isBinary = false;
          for (let i = 0; i < slice.length; i++) {
            if (slice[i] === 0) {
              isBinary = true;
              break;
            }
          }

          if (isBinary) {
            results.push({
              path: filePath,
              success: true,
              isBinary: true,
              sizeBytes: stat.size,
              bytesRead,
              content: "[Binary file content suppressed]",
            });
            continue;
          }

          results.push({
            path: filePath,
            success: true,
            sizeBytes: stat.size,
            bytesRead,
            truncated: stat.size > bytesRead,
            content: slice.toString("utf8"),
          });
        } catch (readErr: any) {
          results.push({
            path: filePath,
            success: false,
            error: `Failed to read file: ${readErr?.message || String(readErr)}`,
          });
        }
      }

      const summary = {
        totalRequested: filePaths.length,
        totalSuccess: results.filter((r) => r.success).length,
        files: results,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );

  // 5. write_file
  server.tool(
    "write_file",
    "Write text content directly to a local file path. Automatically creates parent directories if needed.",
    {
      path: z.string().describe("Absolute file path to write to"),
      content: z.string().describe("Complete text content to write into the file"),
      overwrite: z.boolean().optional().describe("Whether to overwrite if file already exists. Default: true"),
    },
    async ({ path: filePath, content, overwrite }) => {
      audit(rootDir, { tool: "write_file" });

      if (!filePath || typeof filePath !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: path must be a non-empty string." }] };
      }
      if (!path.isAbsolute(filePath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path must be an absolute path: "${filePath}".` }] };
      }
      if (isBlockedCredentialPath(filePath)) {
        return { isError: true, content: [{ type: "text", text: `Access denied: path "${filePath}" is blocked by security policy for credential protection.` }] };
      }

      // Block writing directly to sensitive system root directories
      const normalized = path.normalize(filePath).toLowerCase();
      if (
        normalized.startsWith("/etc/") ||
        normalized.startsWith("/system/") ||
        normalized.startsWith("/bin/") ||
        normalized.startsWith("/sbin/") ||
        normalized.startsWith("/usr/bin/") ||
        normalized.startsWith("/usr/sbin/") ||
        (process.platform === "win32" && (normalized.startsWith("c:\\windows\\") || normalized.startsWith("c:\\program files\\windows")))
      ) {
        return { isError: true, content: [{ type: "text", text: `Access denied: writing to operating system system directory "${filePath}" is forbidden.` }] };
      }

      const shouldOverwrite = overwrite !== false;
      const fileExists = fs.existsSync(filePath);

      if (fileExists && !shouldOverwrite) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: File already exists at "${filePath}". Pass overwrite: true to overwrite it.`,
            },
          ],
        };
      }

      try {
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, "utf8");
        const bytesWritten = Buffer.byteLength(content, "utf8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  path: filePath,
                  created: !fileExists,
                  bytesWritten,
                  message: `File successfully written (${bytesWritten} bytes).`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`write_file error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error writing file: ${err?.message || String(err)}` }] };
      }
    }
  );

  // 6. edit_block
  server.tool(
    "edit_block",
    "Surgically replace a specific text or code block within an existing file without rewriting the entire file.",
    {
      path: z.string().describe("Absolute file path of the file to edit"),
      target: z.string().describe("Exact snippet of text or code to be replaced (must match existing file content exactly)"),
      replacement: z.string().describe("New text or code to replace the target with"),
      replace_all: z.boolean().optional().describe("Whether to replace all occurrences. Default: false (replaces first unique occurrence)"),
    },
    async ({ path: filePath, target, replacement, replace_all }) => {
      audit(rootDir, { tool: "edit_block" });

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
      if (!target || typeof target !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: target must be a non-empty string snippet." }] };
      }

      try {
        const originalContent = fs.readFileSync(filePath, "utf8");
        const count = originalContent.split(target).length - 1;

        if (count === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: Target snippet was not found in "${filePath}". Please verify character-by-character matching including indentation and whitespace.`,
              },
            ],
          };
        }

        if (count > 1 && !replace_all) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: Target snippet occurs ${count} times in "${filePath}". Set replace_all: true to replace all occurrences, or include more surrounding lines in target to make it unique.`,
              },
            ],
          };
        }

        let updatedContent = "";
        if (replace_all) {
          updatedContent = originalContent.split(target).join(replacement);
        } else {
          const idx = originalContent.indexOf(target);
          updatedContent = originalContent.slice(0, idx) + replacement + originalContent.slice(idx + target.length);
        }

        fs.writeFileSync(filePath, updatedContent, "utf8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  path: filePath,
                  occurrencesReplaced: replace_all ? count : 1,
                  totalMatchesFound: count,
                  message: `Successfully replaced ${replace_all ? count : 1} occurrence(s) in "${filePath}".`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`edit_block error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error editing file: ${err?.message || String(err)}` }] };
      }
    }
  );

  // 7. search_files
  server.tool(
    "search_files",
    "Search for files by name or glob pattern recursively within a directory, ignoring noise folders (node_modules, .git, etc.).",
    {
      path: z.string().describe("Absolute directory path to search within"),
      pattern: z.string().describe("File name substring or glob pattern (e.g. 'auth', '*.ts', 'config')"),
      max_results: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return (default: 50, max: 100)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ path: dirPath, pattern, max_results }) => {
      audit(rootDir, { tool: "search_files" });

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

      const limit = Math.max(1, Math.min(100, max_results || 50));
      const searchPattern = pattern.trim().toLowerCase();

      // Convert simple glob (*.ts, *config*) to regex or substring matcher
      let matcher: (name: string) => boolean;
      if (searchPattern.includes("*")) {
        const regexStr = "^" + searchPattern.split("*").map(s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join(".*") + "$";
        try {
          const re = new RegExp(regexStr, "i");
          matcher = (name) => re.test(name);
        } catch {
          matcher = (name) => name.toLowerCase().includes(searchPattern.replace(/\*/g, ""));
        }
      } else {
        matcher = (name) => name.toLowerCase().includes(searchPattern);
      }

      const defaultIgnores = new Set([
        "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out", "coverage", ".turbo",
        "venv", ".venv", "__pycache__", ".idea", ".vscode", "target", "vendor"
      ]);

      const matches: Array<{ name: string; path: string; sizeBytes: number }> = [];

      function walk(currentDir: string, currentDepth: number) {
        if (matches.length >= limit || currentDepth > 10) return;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (entry.name.startsWith(".") && entry.name !== ".env") continue;
          if (defaultIgnores.has(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isFile()) {
            if (matcher(entry.name)) {
              let sizeBytes = 0;
              try {
                sizeBytes = fs.statSync(fullPath).size;
              } catch {}
              matches.push({
                name: entry.name,
                path: fullPath,
                sizeBytes,
              });
              if (matches.length >= limit) return;
            }
          } else if (entry.isDirectory()) {
            walk(fullPath, currentDepth + 1);
          }
        }
      }

      walk(dirPath, 1);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                directory: dirPath,
                pattern,
                totalFound: matches.length,
                limitReached: matches.length >= limit,
                files: matches,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 8. search_code
  server.tool(
    "search_code",
    "Fast regex and keyword code search across files in a directory, returning matching file paths, line numbers, and snippet lines.",
    {
      path: z.string().describe("Absolute directory path to search within"),
      query: z.string().describe("Search string or regular expression pattern"),
      is_regex: z.boolean().optional().describe("Whether query should be treated as a regular expression. Default: false"),
      case_sensitive: z.boolean().optional().describe("Whether the search should be case sensitive. Default: false"),
      file_pattern: z.string().optional().describe("Optional glob or extension filter (e.g. '*.ts', '*.py')"),
      max_results: z.number().int().min(1).max(100).optional().describe("Maximum number of matching lines to return (default: 30, max: 100)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ path: dirPath, query, is_regex, case_sensitive, file_pattern, max_results }) => {
      audit(rootDir, { tool: "search_code" });

      if (!dirPath || typeof dirPath !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: path must be a non-empty string." }] };
      }
      if (!path.isAbsolute(dirPath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path must be an absolute path: "${dirPath}".` }] };
      }
      if (isBlockedCredentialPath(dirPath)) {
        return { isError: true, content: [{ type: "text", text: `Access denied: path "${dirPath}" is blocked by security policy for credential protection.` }] };
      }
      if (!fs.existsSync(dirPath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path does not exist: "${dirPath}".` }] };
      }
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        return { isError: true, content: [{ type: "text", text: "Error: query must be a non-empty string." }] };
      }

      const limit = Math.max(1, Math.min(100, max_results || 30));

      // Attempt fast native ripgrep (rg) if installed on host system
      const isWin = process.platform === "win32";
      const lookupCmd = isWin ? "where" : "which";
      let hasRg = false;
      try {
        hasRg = spawnSync(lookupCmd, ["rg"], { shell: false }).status === 0;
      } catch {}

      if (hasRg) {
        try {
          const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(limit)];
          if (!case_sensitive) rgArgs.push("-i");
          if (!is_regex) rgArgs.push("-F");
          if (file_pattern) rgArgs.push("-g", file_pattern);
          // Ignore standard noise
          rgArgs.push("-g", "!node_modules", "-g", "!.git", "-g", "!dist", "-g", "!build", "-g", "!.next");
          rgArgs.push(query, dirPath);

          const rgRes = spawnSync("rg", rgArgs, {
            shell: false,
            timeout: 8000,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
          });

          if (rgRes.status === 0 && typeof rgRes.stdout === "string") {
            const lines = rgRes.stdout.trim().split(/\r?\n/).filter(Boolean);
            const matches = lines.slice(0, limit).map((line) => {
              const parts = line.split(":");
              const file = parts[0];
              const lineNum = parseInt(parts[1], 10);
              const text = parts.slice(2).join(":").trim();
              return { file, line: lineNum || 1, text: text.slice(0, 300) };
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      engine: "ripgrep",
                      query,
                      totalFound: matches.length,
                      limitReached: matches.length >= limit,
                      matches,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } catch {}
      }

      // Pure Node.js fallback search engine
      let searchRegex: RegExp;
      try {
        const flags = case_sensitive ? "g" : "gi";
        searchRegex = is_regex
          ? new RegExp(query, flags)
          : new RegExp(query.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), flags);
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Invalid regular expression: ${err?.message || String(err)}` }] };
      }

      const defaultIgnores = new Set([
        "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out", "coverage", ".turbo",
        "venv", ".venv", "__pycache__", ".idea", ".vscode", "target", "vendor"
      ]);

      const matches: Array<{ file: string; line: number; text: string }> = [];

      function searchFile(fileAbsPath: string) {
        if (matches.length >= limit) return;
        try {
          const stat = fs.statSync(fileAbsPath);
          if (stat.size > 2 * 1024 * 1024) return; // skip files > 2MB

          const buf = fs.readFileSync(fileAbsPath);
          for (let i = 0; i < Math.min(buf.length, 512); i++) {
            if (buf[i] === 0) return; // binary file
          }

          const content = buf.toString("utf8");
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            searchRegex.lastIndex = 0;
            if (searchRegex.test(lines[i])) {
              matches.push({
                file: fileAbsPath,
                line: i + 1,
                text: lines[i].trim().slice(0, 300),
              });
              if (matches.length >= limit) return;
            }
          }
        } catch {}
      }

      function walkAndSearch(currentDir: string, depth: number) {
        if (matches.length >= limit || depth > 8) return;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (entry.name.startsWith(".") && entry.name !== ".env") continue;
          if (defaultIgnores.has(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isFile()) {
            if (file_pattern) {
              const cleanPat = file_pattern.replace(/^\*/, "").toLowerCase();
              if (!entry.name.toLowerCase().endsWith(cleanPat)) continue;
            }
            searchFile(fullPath);
          } else if (entry.isDirectory()) {
            walkAndSearch(fullPath, depth + 1);
          }
        }
      }

      const stat = fs.statSync(dirPath);
      if (stat.isFile()) {
        searchFile(dirPath);
      } else {
        walkAndSearch(dirPath, 1);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                engine: "nodejs-fallback",
                query,
                totalFound: matches.length,
                limitReached: matches.length >= limit,
                matches,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 9. tail_file
  server.tool(
    "tail_file",
    "Read the tail (end) of a file or log, returning the most recent lines without loading the whole file.",
    {
      path: z.string().describe("Absolute path to the log or text file"),
      lines: z.number().int().min(1).max(500).optional().describe("Number of lines from end of file (default: 100, max: 500)"),
      max_bytes: z.number().int().min(100).max(64000).optional().describe("Maximum bytes to read from end (default: 16000, max: 64000)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ path: filePath, lines: lineCount, max_bytes }) => {
      audit(rootDir, { tool: "tail_file" });

      if (!filePath || typeof filePath !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: path must be a non-empty string." }] };
      }
      if (!path.isAbsolute(filePath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path must be an absolute path: "${filePath}".` }] };
      }
      if (isBlockedCredentialPath(filePath)) {
        return { isError: true, content: [{ type: "text", text: `Access denied: path "${filePath}" is blocked by credential protection policy.` }] };
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { isError: true, content: [{ type: "text", text: `Error: path does not exist or is not a regular file: "${filePath}".` }] };
      }

      try {
        const stat = fs.statSync(filePath);
        const reqBytes = Math.max(100, Math.min(64000, max_bytes || 16000));
        const readLength = Math.min(stat.size, reqBytes);
        const startOffset = Math.max(0, stat.size - readLength);

        const fd = fs.openSync(filePath, "r");
        const buffer = Buffer.alloc(readLength);
        let bytesRead = 0;
        try {
          bytesRead = fs.readSync(fd, buffer, 0, readLength, startOffset);
        } finally {
          fs.closeSync(fd);
        }

        const rawText = buffer.slice(0, bytesRead).toString("utf8");
        const allLines = rawText.split(/\r?\n/);
        const maxLines = Math.max(1, Math.min(500, lineCount || 100));
        const returnedLines = allLines.slice(-maxLines);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  path: filePath,
                  totalSizeBytes: stat.size,
                  bytesRead,
                  startOffset,
                  linesRequested: maxLines,
                  linesReturned: returnedLines.length,
                  content: returnedLines.join("\n"),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`tail_file error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error reading tail of file: ${err?.message || String(err)}` }] };
      }
    }
  );

  // 10. move_file
  server.tool(
    "move_file",
    "Move or rename a file or directory from source path to destination path.",
    {
      source: z.string().describe("Absolute path to existing source file or directory"),
      destination: z.string().describe("Absolute path to target destination"),
      overwrite: z.boolean().optional().describe("Whether to overwrite destination if it exists. Default: false"),
    },
    async ({ source, destination, overwrite }) => {
      audit(rootDir, { tool: "move_file" });

      if (!source || !destination || typeof source !== "string" || typeof destination !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: source and destination must be non-empty strings." }] };
      }
      if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
        return { isError: true, content: [{ type: "text", text: "Error: source and destination must both be absolute paths." }] };
      }
      if (isBlockedCredentialPath(source) || isBlockedCredentialPath(destination)) {
        return { isError: true, content: [{ type: "text", text: "Access denied by credential protection policy." }] };
      }
      if (!fs.existsSync(source)) {
        return { isError: true, content: [{ type: "text", text: `Error: source path does not exist: "${source}".` }] };
      }

      if (fs.existsSync(destination) && !overwrite) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: destination already exists at "${destination}". Pass overwrite: true to replace.` }],
        };
      }

      try {
        const destParent = path.dirname(destination);
        if (!fs.existsSync(destParent)) {
          fs.mkdirSync(destParent, { recursive: true });
        }

        try {
          fs.renameSync(source, destination);
        } catch (renameErr: any) {
          // If cross-device link error (EXDEV), copy and unlink
          if (renameErr.code === "EXDEV") {
            fs.cpSync(source, destination, { recursive: true, force: Boolean(overwrite) });
            fs.rmSync(source, { recursive: true, force: true });
          } else {
            throw renameErr;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  source,
                  destination,
                  message: `Successfully moved from "${source}" to "${destination}".`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`move_file error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error moving file: ${err?.message || String(err)}` }] };
      }
    }
  );

  // 11. create_directory
  server.tool(
    "create_directory",
    "Create a new directory or nested directory structure on the local filesystem.",
    {
      path: z.string().describe("Absolute directory path to create"),
    },
    async ({ path: dirPath }) => {
      audit(rootDir, { tool: "create_directory" });

      if (!dirPath || typeof dirPath !== "string") {
        return { isError: true, content: [{ type: "text", text: "Error: path must be a non-empty string." }] };
      }
      if (!path.isAbsolute(dirPath)) {
        return { isError: true, content: [{ type: "text", text: `Error: path must be an absolute path: "${dirPath}".` }] };
      }
      if (isBlockedCredentialPath(dirPath)) {
        return { isError: true, content: [{ type: "text", text: `Access denied: path "${dirPath}" is blocked by credential protection policy.` }] };
      }

      try {
        const alreadyExists = fs.existsSync(dirPath);
        if (!alreadyExists) {
          fs.mkdirSync(dirPath, { recursive: true });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  path: dirPath,
                  created: !alreadyExists,
                  message: alreadyExists ? `Directory already exists at "${dirPath}".` : `Directory successfully created at "${dirPath}".`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`create_directory error: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error creating directory: ${err?.message || String(err)}` }] };
      }
    }
  );
}
