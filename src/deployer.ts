import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBridgeRoot } from "./config.js";
import { loadProjectsConfig } from "./project-router.js";
import { restartService, RestartServiceResult } from "./service-manager.js";
import { BridgeLogger } from "./logger.js";

export interface MergeAndDeployResult {
  success: boolean;
  project: string;
  prNumber: number | string;
  merged: boolean;
  fastForwarded: boolean;
  changedFiles: string[];
  restartedServices: RestartServiceResult[];
  error?: string;
}

function resolveGhCli(): string {
  const isWin = process.platform === "win32";
  const lookup = isWin ? "where" : "which";
  const res = spawnSync(lookup, ["gh"], { encoding: "utf8", windowsHide: true });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim().split(/\r?\n/)[0];
  }
  const common = isWin
    ? ["C:\\Program Files\\GitHub CLI\\gh.exe"]
    : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  for (const p of common) {
    if (fs.existsSync(p)) return p;
  }
  return "gh";
}

export async function mergeAndDeploy(
  rootDir: string,
  projectId: string,
  prNumber: number | string,
  options?: {
    method?: "merge" | "squash" | "rebase";
    logger?: BridgeLogger;
  }
): Promise<MergeAndDeployResult> {
  const logger = options?.logger;
  const config = loadProjectsConfig(rootDir);
  const proj = config.projects[projectId];
  if (!proj) {
    return {
      success: false,
      project: projectId,
      prNumber,
      merged: false,
      fastForwarded: false,
      changedFiles: [],
      restartedServices: [],
      error: `Project "${projectId}" not found in projects.json`,
    };
  }

  const checkoutDir = proj.merge_deploy?.checkout_path || proj.paths?.[0];
  if (!checkoutDir || !fs.existsSync(checkoutDir)) {
    return {
      success: false,
      project: projectId,
      prNumber,
      merged: false,
      fastForwarded: false,
      changedFiles: [],
      restartedServices: [],
      error: `Checkout directory does not exist: "${checkoutDir}"`,
    };
  }

  const ghBin = resolveGhCli();

  // 1. Get changed files of PR before merging
  let changedFiles: string[] = [];
  try {
    const diffRes = spawnSync(ghBin, ["pr", "diff", String(prNumber), "--name-only"], {
      cwd: checkoutDir,
      encoding: "utf8",
      shell: false,
      timeout: 30000,
    });
    if (diffRes.status === 0 && diffRes.stdout) {
      changedFiles = diffRes.stdout.trim().split("\n").map((f) => f.trim()).filter(Boolean);
    }
  } catch (err: any) {
    logger?.warn(`merge_and_deploy: Failed to inspect diff names: ${err?.message || String(err)}`);
  }

  // 2. Merge PR via gh pr merge
  const method = options?.method || "merge";
  const mergeArgs = ["pr", "merge", String(prNumber), `--${method}`];
  if (proj.repo) {
    mergeArgs.push("--repo", proj.repo);
  }

  logger?.info(`merge_and_deploy: Merging PR #${prNumber} with method ${method}`);
  const mergeRes = spawnSync(ghBin, mergeArgs, {
    cwd: checkoutDir,
    encoding: "utf8",
    shell: false,
    timeout: 60000,
  });

  if (mergeRes.status !== 0) {
    return {
      success: false,
      project: projectId,
      prNumber,
      merged: false,
      fastForwarded: false,
      changedFiles,
      restartedServices: [],
      error: `Failed to merge PR #${prNumber}: ${mergeRes.stderr || mergeRes.stdout}`,
    };
  }

  // 3. Fast-forward configured checkout
  const targetBranch = proj.merge_deploy?.target_branch || "develop";
  logger?.info(`merge_and_deploy: Fast-forwarding branch ${targetBranch} in ${checkoutDir}`);
  let fastForwarded = false;

  const pullRes = spawnSync("git", ["pull", "--ff-only", proj.merge_deploy?.remote || "origin", targetBranch], {
    cwd: checkoutDir,
    encoding: "utf8",
    shell: false,
    timeout: 30000,
  });

  if (pullRes.status === 0) {
    fastForwarded = true;
  } else {
    logger?.warn(`merge_and_deploy: Fast-forward git pull returned non-zero: ${pullRes.stderr || pullRes.stdout}`);
  }

  // 4. Restart services by changed-path rules from config
  const servicesToRestart = new Set<string>();
  const configuredServices = proj.services || {};

  // If merge_deploy explicitly names services, or by changed_paths
  for (const [sName, sCfg] of Object.entries(configuredServices)) {
    if (proj.merge_deploy?.services?.includes(sName)) {
      servicesToRestart.add(sName);
      continue;
    }
    const matchRules = sCfg.changed_paths || [];
    if (matchRules.length === 0) {
      // Default: if no changed_paths rules, don't restart unless explicitly listed
      continue;
    }
    for (const file of changedFiles) {
      for (const rule of matchRules) {
        if (file.startsWith(rule) || file.includes(rule)) {
          servicesToRestart.add(sName);
          break;
        }
      }
    }
  }

  const restartResults: RestartServiceResult[] = [];
  for (const sName of servicesToRestart) {
    logger?.info(`merge_and_deploy: Restarting matched service "${sName}"`);
    const sResult = await restartService(rootDir, projectId, sName, logger);
    restartResults.push(sResult);
  }

  const allServicesHealthy = restartResults.every((r) => r.success);

  return {
    success: allServicesHealthy,
    project: projectId,
    prNumber,
    merged: true,
    fastForwarded,
    changedFiles,
    restartedServices: restartResults,
    error: allServicesHealthy ? undefined : "One or more services failed health-check after deploy",
  };
}
