import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { resolveDeviceToken } from "../src/token.js";
import { resolveCallbackHeaders, extractPrUrl, extractLast20LogLines, sendCompletionCallback } from "../src/callback.js";
import { loadProjectsConfig, saveProjectsConfig } from "../src/project-router.js";
import { agentSupportsEffort } from "../src/agents.js";
import { setupGitWorktree, resolveWorktreeRoot } from "../src/worktree.js";
import { runSelfCheck } from "../src/self-check.js";
import { parseTaskFile } from "../src/worker.js";

async function runTests() {
  console.log("=================================================");
  console.log("  feat/task-callback-hardening Comprehensive Test Suite");
  console.log("=================================================");

  // -------------------------------------------------------------------------
  // 1. Completion Callback tests
  // -------------------------------------------------------------------------
  console.log("\n[Test 1] Completion callback header secret resolution & retries");
  process.env.TEST_SECRET_ENV = "Bearer my-secret-token-12345";
  const headers = resolveCallbackHeaders({
    "X-Api-Key": "$TEST_SECRET_ENV",
    "Authorization": "TEST_SECRET_ENV",
    "X-Custom-Plain": "plain-value",
  });
  assert.strictEqual(headers["X-Api-Key"], "Bearer my-secret-token-12345");
  assert.strictEqual(headers["Authorization"], "Bearer my-secret-token-12345");
  assert.strictEqual(headers["X-Custom-Plain"], "plain-value");
  assert.strictEqual(headers["Content-Type"], "application/json; charset=utf-8");

  // Test PR extraction & last log lines
  const sampleLog = "line 1\nline 2\nPull request opened: https://github.com/generic-owner/generic-repo/pull/42\nError occurred!";
  assert.strictEqual(extractPrUrl(sampleLog), "https://github.com/generic-owner/generic-repo/pull/42");
  const lastLines = extractLast20LogLines(sampleLog);
  assert.strictEqual(lastLines.length, 4);
  assert.strictEqual(lastLines[lastLines.length - 1], "Error occurred!");

  // Test HTTP callback POST delivery with local server
  let receivedCallback: any = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      receivedCallback = {
        headers: req.headers,
        body: JSON.parse(body),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const callbackUrl = `http://127.0.0.1:${port}/callback`;

  const cbResult = await sendCompletionCallback({
    url: callbackUrl,
    headers: { "X-Test-Header": "TEST_SECRET_ENV" },
    taskId: "task_cb_test_001",
    agent: "codex",
    status: "completed",
    exitCode: 0,
    durationSeconds: 12,
    resultPath: "/tmp/results/task_cb_test_001.md",
    logPath: "/tmp/logs/task_cb_test_001.out",
    outputLog: sampleLog,
  });

  server.close();
  assert.strictEqual(cbResult.success, true);
  assert.strictEqual(cbResult.attempts, 1);
  assert.strictEqual(receivedCallback.body.task_id, "task_cb_test_001");
  assert.strictEqual(receivedCallback.body.status, "completed");
  assert.strictEqual(receivedCallback.body.pr_url, "https://github.com/generic-owner/generic-repo/pull/42");
  assert.strictEqual(receivedCallback.headers["x-test-header"], "Bearer my-secret-token-12345");
  console.log("✓ Test 1 passed: Callback delivered with resolved headers, PR URL and terminal status.");

  // -------------------------------------------------------------------------
  // 2. Slack per-project webhook via env var NAME
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] Slack per-project webhook via env var name in projects.json");
  const testRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-proj-test-"));
  const projCfg = {
    version: "1.0.0",
    projects: {
      "sample-proj": {
        id: "sample-proj",
        name: "Sample Project",
        repo: "generic/sample-proj",
        slack_webhook_env: "SAMPLE_PROJ_SLACK_WEBHOOK",
        callback_url: "https://example.com/api/callback",
        callback_headers: { "Authorization": "$CALLBACK_TOKEN" },
        worktree_root: "/tmp/worktrees",
        symlink_dirs: ["node_modules", ".venv"],
        paths: [testRootDir],
      },
    },
  };
  saveProjectsConfig(testRootDir, projCfg as any);
  const loadedCfg = loadProjectsConfig(testRootDir);
  assert.strictEqual(loadedCfg.projects["sample-proj"].slack_webhook_env, "SAMPLE_PROJ_SLACK_WEBHOOK");
  assert.strictEqual(loadedCfg.projects["sample-proj"].callback_url, "https://example.com/api/callback");
  assert.deepStrictEqual(loadedCfg.projects["sample-proj"].symlink_dirs, ["node_modules", ".venv"]);
  console.log("✓ Test 2 passed: Per-project slack_webhook_env, callback_url, and worktree settings preserved.");

  // -------------------------------------------------------------------------
  // 3. agy agent capabilities and reasoning effort filtering
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] agy reasoning effort capability checks");
  const agyNoEffortConfig = {
    command: "agy",
    args: ["--dangerously-skip-permissions"],
    input: "stdin" as const,
  };
  assert.strictEqual(agentSupportsEffort(agyNoEffortConfig, "claude-3-7-sonnet"), false);

  const agyWithEffortConfig = {
    command: "agy",
    args: ["--dangerously-skip-permissions"],
    input: "stdin" as const,
    capabilities: {
      effort_models: ["claude-3-7-sonnet-thinking", "gemini-2.5-pro"],
    },
  };
  assert.strictEqual(agentSupportsEffort(agyWithEffortConfig, "claude-3-7-sonnet-thinking"), true);
  assert.strictEqual(agentSupportsEffort(agyWithEffortConfig, "claude-3-5-sonnet"), false);

  const codexConfig = {
    command: "codex",
    args: ["exec"],
    input: "stdin" as const,
  };
  assert.strictEqual(agentSupportsEffort(codexConfig, "o3-mini"), true);
  console.log("✓ Test 3 passed: Agent reasoning effort capabilities strictly checked per agents.json.");

  // -------------------------------------------------------------------------
  // 4. Git Worktree support
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] Git worktree creation & symlinking");
  const gitRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-git-repo-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: gitRepoDir });
  spawnSync("git", ["config", "user.name", "TestUser"], { cwd: gitRepoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: gitRepoDir });
  fs.writeFileSync(path.join(gitRepoDir, "README.md"), "# Test Repo\n");
  fs.mkdirSync(path.join(gitRepoDir, "node_modules"));
  fs.writeFileSync(path.join(gitRepoDir, "node_modules", "package.json"), "{}");
  spawnSync("git", ["add", "."], { cwd: gitRepoDir });
  spawnSync("git", ["commit", "-m", "Initial commit"], { cwd: gitRepoDir });

  const customWtRoot = path.join(testRootDir, "custom_worktrees");
  const wtResult = setupGitWorktree({
    repoDir: gitRepoDir,
    worktreeName: "feature-wt-1",
    worktreeRoot: customWtRoot,
    symlinkDirs: ["node_modules"],
  });

  assert.strictEqual(wtResult.created, true);
  assert.strictEqual(fs.existsSync(wtResult.worktreeDir), true);
  const symlinkPath = path.join(wtResult.worktreeDir, "node_modules");
  assert.strictEqual(fs.existsSync(symlinkPath), true);
  assert.strictEqual(fs.lstatSync(symlinkPath).isSymbolicLink(), true);

  // Failure cases: missing base branch / create failure must throw loudly
  assert.throws(
    () => {
      setupGitWorktree({
        repoDir: gitRepoDir,
        worktreeName: "fail-wt-missing-base",
        worktreeRoot: customWtRoot,
        baseBranch: "origin/nonexistent_branch_definitely_missing_12345",
      });
    },
    /git worktree add failed/
  );
  console.log("✓ Test 4 passed: Git worktree created and node_modules directory symlinked (and missing base branch throws loudly).");

  // -------------------------------------------------------------------------
  // 5. Security & Device token resolution
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] Device token security & precedence");
  // Test AGENT_BRIDGE_TOKEN
  process.env.AGENT_BRIDGE_TOKEN = "env_token_sec_998877";
  const r1 = resolveDeviceToken();
  assert.strictEqual(r1.token, "env_token_sec_998877");
  assert.strictEqual(r1.source, "env_token");
  delete process.env.AGENT_BRIDGE_TOKEN;

  // Test AGENT_BRIDGE_TOKEN_FILE
  const tokenFile = path.join(testRootDir, "secret.token");
  fs.writeFileSync(tokenFile, "file_token_sec_112233\n", "utf8");
  process.env.AGENT_BRIDGE_TOKEN_FILE = tokenFile;
  const r2 = resolveDeviceToken();
  assert.strictEqual(r2.token, "file_token_sec_112233");
  assert.strictEqual(r2.source, "env_file");
  delete process.env.AGENT_BRIDGE_TOKEN_FILE;

  // Test CLI deprecation warning
  let warnOutput = "";
  const r3 = resolveDeviceToken("cli_legacy_token", (msg) => { warnOutput = msg; });
  assert.strictEqual(r3.token, "cli_legacy_token");
  assert.strictEqual(r3.deprecatedCliUsed, true);
  assert.match(warnOutput, /Deprecation warning/);
  console.log("✓ Test 5 passed: Token securely resolved from env & token file; CLI flag logged deprecation.");

  // -------------------------------------------------------------------------
  // 6. Startup self-check tool
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] Startup self-check tool");
  // Setup mock agents.json in testRootDir
  const mockAgentsFile = path.join(testRootDir, "agents.json");
  fs.writeFileSync(
    mockAgentsFile,
    JSON.stringify({
      node: {
        command: "node",
        args: [],
        input: "stdin",
      },
    }, null, 2),
    "utf8"
  );
  const selfCheckReport = runSelfCheck(testRootDir);
  assert.strictEqual(typeof selfCheckReport.ok, "boolean");
  assert.strictEqual(selfCheckReport.agents.length, 1);
  assert.strictEqual(selfCheckReport.agents[0].name, "node");
  assert.strictEqual(selfCheckReport.agents[0].runs, true);
  console.log("✓ Test 6 passed: Self-check executed and reported agent/worker liveness.");

  // Cleanup test directories
  try {
    fs.rmSync(testRootDir, { recursive: true, force: true });
    // Worktree prune before deleting repo
    spawnSync("git", ["worktree", "prune"], { cwd: gitRepoDir });
    fs.rmSync(gitRepoDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=================================================");
  console.log("🎉 All 6 hardening test suites passed successfully!");
  console.log("=================================================");
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
