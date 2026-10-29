import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { isBlockedCredentialPath } from "./local-fs.js";

const MAX_PROJECTS = 30;
const MAX_GIT_OUTPUT = 2000;
const DEFAULT_DIRECTORIES = ["docs", "output", "tmp", "scratch", "work"];

export interface ProjectInspectionOptions {
  root_path: string;
  project_names?: string[];
  directory_names?: string[];
  include_git_status?: boolean;
  max_entries?: number;
  max_depth?: number;
  timeout_seconds?: number;
}

interface DirectorySummary {
  name: string;
  status: "ok" | "missing" | "not_directory" | "blocked" | "skipped_symlink" | "error" | "not_scanned";
  file_count: number | null;
  total_bytes: number | null;
  complete: boolean;
  reasons: string[];
  skipped_symlinks: number;
  blocked_entries: number;
  error_count: number;
}

interface GitSummary {
  status: "ok" | "not_repository" | "skipped" | "error" | "timeout";
  text?: string;
  truncated?: boolean;
  submodules_ignored?: boolean;
  filters_disabled?: boolean;
  note?: string;
}

interface Budget {
  visited: number;
  maxEntries: number;
  deadline: number;
  reasons: Set<string>;
}

function directChildName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && name !== "." && name !== ".." &&
    !/[\\/\x00-\x1f:*?"<>|]/.test(name) && !path.isAbsolute(name) && !/[. ]$/.test(name);
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function exhausted(budget: Budget): string | undefined {
  if (Date.now() >= budget.deadline) {
    budget.reasons.add("time_limit");
    return "time_limit";
  }
  if (budget.visited >= budget.maxEntries) {
    budget.reasons.add("entry_limit");
    return "entry_limit";
  }
  return undefined;
}

function emptySummary(name: string, status: DirectorySummary["status"]): DirectorySummary {
  return {
    name, status, file_count: status === "ok" ? 0 : null,
    total_bytes: status === "ok" ? 0 : null, complete: status === "ok" || status === "missing",
    reasons: [], skipped_symlinks: 0, blocked_entries: 0, error_count: 0,
  };
}

function addReason(summary: DirectorySummary, reason: string): void {
  summary.complete = false;
  if (!summary.reasons.includes(reason)) summary.reasons.push(reason);
}

async function summarizeDirectory(projectPath: string, name: string, maxDepth: number, budget: Budget): Promise<DirectorySummary> {
  const target = path.join(projectPath, name);
  if (isBlockedCredentialPath(target)) return emptySummary(name, "blocked");
  const earlyLimit = exhausted(budget);
  if (earlyLimit) {
    const summary = emptySummary(name, "not_scanned");
    addReason(summary, earlyLimit);
    return summary;
  }
  let targetReal: string;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return emptySummary(name, "skipped_symlink");
    if (!stat.isDirectory()) return emptySummary(name, "not_directory");
    targetReal = await fs.realpath(target);
    if (!inside(projectPath, targetReal) || isBlockedCredentialPath(targetReal)) return emptySummary(name, "blocked");
  } catch (err: any) {
    return emptySummary(name, err?.code === "ENOENT" ? "missing" : "error");
  }

  const summary = emptySummary(name, "ok");
  const pending: Array<{ directory: string; depth: number }> = [{ directory: targetReal, depth: 0 }];
  while (pending.length > 0) {
    const limit = exhausted(budget);
    if (limit) { addReason(summary, limit); break; }
    const current = pending.pop()!;
    try {
      // Recheck before opening each directory: directory links are never followed.
      const currentStat = await fs.lstat(current.directory);
      const currentReal = await fs.realpath(current.directory);
      if (currentStat.isSymbolicLink()) {
        summary.skipped_symlinks++;
        addReason(summary, "symbolic_links_skipped");
        continue;
      }
      if (!inside(targetReal, currentReal) || isBlockedCredentialPath(currentReal)) {
        summary.blocked_entries++;
        addReason(summary, "blocked_entries");
        continue;
      }
      const directory = await fs.opendir(currentReal);
      for await (const entry of directory) {
        const entryLimit = exhausted(budget);
        if (entryLimit) { addReason(summary, entryLimit); break; }
        budget.visited++;
        const entryPath = path.join(currentReal, entry.name);
        try {
          const stat = await fs.lstat(entryPath);
          if (stat.isSymbolicLink()) {
            summary.skipped_symlinks++;
            addReason(summary, "symbolic_links_skipped");
            continue;
          }
          if (isBlockedCredentialPath(entryPath)) {
            summary.blocked_entries++;
            addReason(summary, "blocked_entries");
            continue;
          }
          if (stat.isFile()) {
            summary.file_count!++;
            summary.total_bytes! += stat.size;
          } else if (stat.isDirectory()) {
            if (current.depth + 1 >= maxDepth) addReason(summary, "depth_limit");
            else pending.push({ directory: entryPath, depth: current.depth + 1 });
          }
        } catch {
          summary.error_count++;
          addReason(summary, "entry_errors");
        }
      }
    } catch {
      summary.error_count++;
      addReason(summary, "directory_errors");
    }
  }
  return summary;
}

function gitRead(args: string[], cwd: string, deadline: number): Promise<{ ok: boolean; timedOut: boolean; stdout: string; exitCode: number | null; outputLimit: boolean }> {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { resolve({ ok: false, timedOut: true, stdout: "", exitCode: null, outputLimit: false }); return; }
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const child = spawn("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
      cwd, shell: false, windowsHide: true,
      env: { ...gitEnv, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let timedOut = false;
    let outputLimit = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.min(5000, remaining));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 256 * 1024) { outputLimit = true; child.kill(); }
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: exitCode === 0 && !outputLimit, timedOut, stdout, exitCode, outputLimit });
    };
    child.on("error", () => finish(null));
    child.on("close", code => finish(code));
  });
}

export async function getReadOnlyGitStatus(projectPath: string, deadline: number, maxOutput = MAX_GIT_OUTPUT): Promise<GitSummary> {
  try { await fs.lstat(path.join(projectPath, ".git")); }
  catch (err: any) { return { status: err?.code === "ENOENT" ? "not_repository" : "error" }; }

  // `git status` may otherwise invoke a configured clean/process filter. Read the
  // filter names without executing them, then disable those helpers explicitly.
  const config = await gitRead(["config", "--name-only", "--get-regexp", "^filter\\."], projectPath, deadline);
  if (config.timedOut) return { status: "timeout" };
  // Exit 1 with no output means no filters were configured. Any other config
  // failure must stop here: incomplete filter discovery cannot safely run status.
  if (!config.ok && !(config.exitCode === 1 && config.stdout.trim() === "" && !config.outputLimit)) return { status: "error" };
  const filterNames = new Set<string>();
  for (const line of config.stdout.split(/\r?\n/)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(line.trim());
    if (match) filterNames.add(match[1]);
  }
  if (filterNames.size > 100) return { status: "error" };
  const overrides: string[] = [];
  for (const name of filterNames) {
    overrides.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
  }
  const result = await gitRead([...overrides, "--no-pager", "status", "--short", "--branch", "--untracked-files=normal", "--ignore-submodules=all"], projectPath, deadline);
  if (result.timedOut) return { status: "timeout" };
  if (!result.ok) return { status: "error" };
  return {
    status: "ok", text: result.stdout.trim().slice(0, maxOutput),
    truncated: result.stdout.length > maxOutput, submodules_ignored: true,
    filters_disabled: filterNames.size > 0,
    ...(filterNames.size > 0 ? { note: "Configured clean/process filters were disabled for this read-only inspection; status may differ from normal Git, for example in Git LFS repositories." } : {}),
  };
}

export async function inspectProjectDirectories(options: ProjectInspectionOptions) {
  if (!options.root_path || !path.isAbsolute(options.root_path)) throw new Error("root_path must be an absolute directory path");
  const projectNames = options.project_names && [...new Set(options.project_names)];
  const directoryNames = [...new Set(options.directory_names ?? DEFAULT_DIRECTORIES)];
  if (projectNames && (projectNames.length === 0 || projectNames.length > MAX_PROJECTS || projectNames.some(name => !directChildName(name)))) {
    throw new Error("project_names must contain 1-30 direct child directory names without path separators");
  }
  if (directoryNames.length === 0 || directoryNames.length > 12 || directoryNames.some(name => !directChildName(name))) {
    throw new Error("directory_names must contain 1-12 direct child directory names without path separators");
  }
  if (isBlockedCredentialPath(options.root_path)) throw new Error("root_path is blocked by credential protection");
  const rootStat = await fs.lstat(options.root_path);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("root_path must be an existing directory, not a symbolic link");
  const rootPath = await fs.realpath(options.root_path);
  if (isBlockedCredentialPath(rootPath)) throw new Error("resolved root_path is blocked by credential protection");
  const budget: Budget = {
    visited: 0,
    maxEntries: Math.max(1, Math.min(100000, options.max_entries ?? 50000)),
    deadline: Date.now() + Math.max(1, Math.min(25, options.timeout_seconds ?? 15)) * 1000,
    reasons: new Set<string>(),
  };
  const maxDepth = Math.max(1, Math.min(32, options.max_depth ?? 24));
  const selected: string[] = projectNames ?? [];
  let projectLimitReached = false;
  if (!projectNames) {
    const directory = await fs.opendir(rootPath);
    for await (const entry of directory) {
      if (exhausted(budget)) break;
      budget.visited++;
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || !directChildName(entry.name)) continue;
      if (selected.length >= MAX_PROJECTS) { projectLimitReached = true; budget.reasons.add("project_limit"); break; }
      selected.push(entry.name);
    }
    selected.sort((left, right) => left.localeCompare(right));
  }

  const projects: Array<{ name: string; path: string; status: string; git: GitSummary; directories: DirectorySummary[] }> = [];
  for (const name of selected) {
    const projectPath = path.join(rootPath, name);
    const project = { name, path: projectPath, status: "ok", git: { status: "skipped" } as GitSummary, directories: [] as DirectorySummary[] };
    projects.push(project);
    if (exhausted(budget)) { project.status = "not_scanned"; continue; }
    try {
      const stat = await fs.lstat(projectPath);
      if (stat.isSymbolicLink()) { project.status = "skipped_symlink"; continue; }
      if (!stat.isDirectory()) { project.status = "not_directory"; continue; }
      const real = await fs.realpath(projectPath);
      if (!inside(rootPath, real) || isBlockedCredentialPath(real) || isBlockedCredentialPath(projectPath)) { project.status = "blocked"; continue; }
      for (const directoryName of directoryNames) project.directories.push(await summarizeDirectory(real, directoryName, maxDepth, budget));
      if (options.include_git_status !== false) project.git = await getReadOnlyGitStatus(real, budget.deadline);
    } catch (err: any) { project.status = err?.code === "ENOENT" ? "missing" : "error"; }
  }
  const complete = budget.reasons.size === 0 && projects.every(project => project.status === "ok" &&
    project.directories.every(directory => directory.complete) && !["error", "timeout"].includes(project.git.status));
  const reasons = new Set(budget.reasons);
  if (projects.some(project => project.status !== "ok")) reasons.add("project_errors_or_skips");
  if (projects.some(project => project.directories.some(directory => !directory.complete))) reasons.add("incomplete_directories");
  if (projects.some(project => ["error", "timeout"].includes(project.git.status))) reasons.add("git_errors_or_timeouts");
  return { root_path: rootPath, projects, complete, reasons: [...reasons], visited_entries: budget.visited, project_limit_reached: projectLimitReached };
}

export function registerProjectInspectionTool(server: McpServer, rootDir: string, logger: BridgeLogger): void {
  const childName = z.string().min(1).max(100).refine(directChildName, "Use a direct child directory name, not a path");
  server.tool(
    "inspect_project_directories",
    "Inspect project folders under a local workspace: summarize recursive file counts and byte sizes for docs/output/tmp/scratch/work (or named directories), plus read-only Git status. Use this instead of execute_command or PowerShell to inventory documents, compare project clutter, or check repository changes. Returns metadata and status, not file contents; does not modify files or accept commands. Symbolic links are skipped and partial results are identified.",
    {
      root_path: z.string().max(4096).describe("Absolute workspace directory containing the projects as direct child folders"),
      project_names: z.array(childName).min(1).max(MAX_PROJECTS).optional().describe("Direct child project names; omit to discover up to 30 projects"),
      directory_names: z.array(childName).min(1).max(12).optional().describe("Direct child directories to summarize per project; default docs, output, tmp, scratch, work"),
      include_git_status: z.boolean().optional().describe("Include bounded, read-only Git status; default true"),
      max_entries: z.number().int().min(1).max(100000).optional().describe("Global file/directory entry budget, default 50000"),
      max_depth: z.number().int().min(1).max(32).optional().describe("Maximum traversal depth for each target directory, default 24"),
      timeout_seconds: z.number().int().min(1).max(25).optional().describe("Global best-effort inspection time budget, default 15 seconds"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async options => {
      audit(rootDir, { tool: "inspect_project_directories" });
      try {
        const result = await inspectProjectDirectories(options);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err: any) {
        logger.warn(`inspect_project_directories rejected or failed: ${err?.message || String(err)}`);
        return { isError: true, content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }] };
      }
    }
  );
}
