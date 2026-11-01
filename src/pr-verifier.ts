import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBridgeRoot } from "./config.js";
import { loadProjectsConfig } from "./project-router.js";
import { BridgeLogger } from "./logger.js";

export interface VerifyPrResult {
  success: boolean;
  project: string;
  prNumber: number | string;
  headBranch?: string;
  baseBranch?: string;
  passedCount: number;
  failedCount: number;
  failingCases: string[];
  logTail: string;
  commandsExecuted: string[];
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

export function parseTestCounts(output: string): { passed: number; failed: number; failingCases: string[] } {
  let passed = 0;
  let failed = 0;
  const failingCases: string[] = [];

  // Patterns for npm test, jest, vitest, pytest, mocha, tap
  // Example: Tests: 5 passed, 2 failed, 7 total
  // Example: 10 passing, 1 failing
  // Example: 5 passed, 1 failed in 2.3s
  // Example: # pass 2 / # fail 2
  const passedMatch = output.match(/(\d+)\s+(?:passing|passed)/i) || output.match(/#\s*pass\s+(\d+)/i);
  if (passedMatch) {
    passed = parseInt(passedMatch[1], 10);
  }

  const failedMatch = output.match(/(\d+)\s+(?:failing|failed)/i) || output.match(/#\s*fail\s+(\d+)/i);
  if (failedMatch) {
    failed = parseInt(failedMatch[1], 10);
  }

  // Extract failing test titles (e.g. "✕ test name", "FAIL: test_name", "not ok 1 - test_name")
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const notOkMatch = trimmed.match(/^not ok\s+\d+\s+-\s+(.+)/i);
    if (notOkMatch) {
      failingCases.push(notOkMatch[1].trim());
    } else if (/^[✕✗x]\s+(.+)/i.test(trimmed)) {
      failingCases.push(trimmed);
    } else if (/^FAIL(?:\s+|:)(.+)/i.test(trimmed)) {
      failingCases.push(trimmed);
    } else if (/Error:\s+(AssertionError.*)/i.test(trimmed)) {
      failingCases.push(trimmed);
    }
  }

  return { passed, failed, failingCases: failingCases.slice(0, 10) };
}

export async function verifyPr(
  rootDir: string,
  projectId: string,
  prNumber: number | string,
  logger?: BridgeLogger
): Promise<VerifyPrResult> {
  const config = loadProjectsConfig(rootDir);
  const proj = config.projects[projectId];
  if (!proj) {
    return {
      success: false,
      project: projectId,
      prNumber,
      passedCount: 0,
      failedCount: 0,
      failingCases: [],
      logTail: "",
      commandsExecuted: [],
      error: `Project "${projectId}" not found in projects.json`,
    };
  }

  const repoDir = proj.paths?.[0];
  if (!repoDir || !fs.existsSync(repoDir)) {
    return {
      success: false,
      project: projectId,
      prNumber,
      passedCount: 0,
      failedCount: 0,
      failingCases: [],
      logTail: "",
      commandsExecuted: [],
      error: `Project repository directory does not exist: "${repoDir}"`,
    };
  }

  const ghBin = resolveGhCli();

  // 1. Fetch PR details (branch name)
  let headBranch = "";
  let baseBranch = "";
  try {
    const viewRes = spawnSync(ghBin, ["pr", "view", String(prNumber), "--json", "headRefName,baseRefName"], {
      cwd: repoDir,
      encoding: "utf8",
      shell: false,
      timeout: 30000,
    });
    if (viewRes.status === 0 && viewRes.stdout) {
      const parsed = JSON.parse(viewRes.stdout);
      headBranch = parsed.headRefName;
      baseBranch = parsed.baseRefName;
    }
  } catch (err: any) {
    logger?.warn(`verify_pr: Failed to get PR info via gh pr view: ${err?.message || String(err)}`);
  }

  // 2. Fetch and checkout PR branch (or checkout pr via gh pr checkout)
  logger?.info(`verify_pr: Checking out PR #${prNumber} in ${repoDir}`);
  const checkoutRes = spawnSync(ghBin, ["pr", "checkout", String(prNumber)], {
    cwd: repoDir,
    encoding: "utf8",
    shell: false,
    timeout: 60000,
  });

  if (checkoutRes.status !== 0) {
    return {
      success: false,
      project: projectId,
      prNumber,
      headBranch,
      baseBranch,
      passedCount: 0,
      failedCount: 1,
      failingCases: ["Checkout PR branch failed"],
      logTail: checkoutRes.stderr || checkoutRes.stdout,
      commandsExecuted: [`gh pr checkout ${prNumber}`],
      error: `Failed to checkout PR #${prNumber}: ${checkoutRes.stderr || checkoutRes.stdout}`,
    };
  }

  // 3. Execute configured test commands
  const testCommands = proj.verify_pr?.test_commands || ["npm test"];
  const timeoutMs = (proj.verify_pr?.timeout_seconds || 300) * 1000;
  const isWin = process.platform === "win32";
  const shellCmd = isWin ? "cmd.exe" : "/bin/sh";

  let totalPassed = 0;
  let totalFailed = 0;
  const allFailingCases: string[] = [];
  const logTailChunks: string[] = [];
  let allSuccess = true;

  for (const cmd of testCommands) {
    logger?.info(`verify_pr: Running command "${cmd}" in ${repoDir}`);
    const shellArgs = isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    const procRes = spawnSync(shellCmd, shellArgs, {
      cwd: repoDir,
      encoding: "utf8",
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });

    const output = (procRes.stdout || "") + "\n" + (procRes.stderr || "");
    const counts = parseTestCounts(output);

    totalPassed += counts.passed;
    totalFailed += counts.failed;
    allFailingCases.push(...counts.failingCases);

    if (procRes.status !== 0) {
      allSuccess = false;
      if (counts.failed === 0) totalFailed += 1;
    } else if (counts.failed === 0 && counts.passed === 0) {
      totalPassed += 1;
    }

    // Capture tail (last 20 lines)
    const lines = output.split("\n").filter(Boolean);
    const tail = lines.slice(-20).join("\n");
    logTailChunks.push(`--- [${cmd}] ---\n${tail}`);
  }

  return {
    success: allSuccess && totalFailed === 0,
    project: projectId,
    prNumber,
    headBranch,
    baseBranch,
    passedCount: totalPassed,
    failedCount: totalFailed,
    failingCases: allFailingCases,
    logTail: logTailChunks.join("\n\n"),
    commandsExecuted: testCommands,
  };
}
