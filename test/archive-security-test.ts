import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import http from "node:http";
import { startHttpServer } from "../src/http-server.js";
import { writeStatus } from "../src/status.js";
import { resolveWorktreeRoot, setupGitWorktree } from "../src/worktree.js";

const TEST_ROOT = "/tmp/agent-bridge-archive-security-test";
const TEST_PORT = 38092;

async function runArchiveSecurityTests() {
  console.log("=================================================");
  console.log("  Task Archive Security & Worktree Removal Tests");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const handle = await startHttpServer({
    port: TEST_PORT,
    host: "127.0.0.1",
    customRootDir: TEST_ROOT,
  });

  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    // 1. Refuse archive for running / queued / paused_quota tasks
    console.log("[Test 1a] Refuse archive for running task...");
    writeStatus(TEST_ROOT, "task-running-001", {
      state: "running",
      agent: "codex",
      startedAt: new Date().toISOString(),
    });

    const resRunning = await fetch(`${baseUrl}/api/recent-tasks/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: ["task-running-001"] }),
    });
    const dataRunning = await resRunning.json();
    assert.equal(dataRunning.deletedCount, 0, "Running task must not be archived");
    assert.ok(dataRunning.errors && dataRunning.errors.some((e: string) => e.includes("running")), "Error message must mention running state");
    console.log("✓ Assertion passed: Running task archive refused.");

    console.log("[Test 1b] Refuse archive for paused_quota task...");
    writeStatus(TEST_ROOT, "task-paused-quota-001", {
      state: "paused_quota",
      agent: "codex",
      startedAt: new Date().toISOString(),
    });

    const resPausedQuota = await fetch(`${baseUrl}/api/recent-tasks/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: ["task-paused-quota-001"] }),
    });
    const dataPausedQuota = await resPausedQuota.json();
    assert.equal(dataPausedQuota.deletedCount, 0, "paused_quota task must not be archived");
    assert.ok(dataPausedQuota.errors && dataPausedQuota.errors.some((e: string) => e.includes("paused due to quota")), "Error message must mention quota paused");
    console.log("✓ Assertion passed: paused_quota task archive refused.");

    // 2. Refuse worktree cleanup for out-of-bounds directory
    console.log("[Test 2] Refuse worktree cleanup outside bridge worktree root...");
    const fakeRepoDir = path.join(TEST_ROOT, "my-repo");
    fs.mkdirSync(fakeRepoDir, { recursive: true });
    const importantFile = path.join(fakeRepoDir, "important.txt");
    fs.writeFileSync(importantFile, "critical data", "utf8");

    writeStatus(TEST_ROOT, "task-completed-evil", {
      state: "completed",
      agent: "codex",
      workDir: fakeRepoDir, // Out of bounds!
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
    });

    const resEvil = await fetch(`${baseUrl}/api/recent-tasks/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: ["task-completed-evil"], cleanWorktree: true }),
    });
    const dataEvil = await resEvil.json();
    assert.equal(dataEvil.cleanedWorktrees.length, 0, "No worktree should be cleaned outside worktree root");
    assert.ok(fs.existsSync(importantFile), "Out-of-bounds file must remain intact!");
    console.log("✓ Assertion passed: Out-of-bounds worktree cleanup strictly rejected.");

    // 3. Normal completed task moved to archive/ directory with collision handling
    console.log("[Test 3] Verify completed task is safely moved to archive/ directory and collisions get timestamp suffix...");
    const tasksDir = path.join(TEST_ROOT, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const taskMd = path.join(tasksDir, "task-completed-safe.md");
    fs.writeFileSync(taskMd, "# Safe Task\n", "utf8");

    writeStatus(TEST_ROOT, "task-completed-safe", {
      state: "completed",
      agent: "codex",
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
    });

    // Create pre-existing file in archive to force collision
    const archiveTasksDir = path.join(TEST_ROOT, "archive", "tasks");
    fs.mkdirSync(archiveTasksDir, { recursive: true });
    const existingArchived = path.join(archiveTasksDir, "task-completed-safe.md");
    fs.writeFileSync(existingArchived, "# Old Version\n", "utf8");

    const resSafe = await fetch(`${baseUrl}/api/recent-tasks/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: ["task-completed-safe"] }),
    });
    const dataSafe = await resSafe.json();
    assert.equal(dataSafe.deletedCount, 1, "Completed task archived");

    // Old archived file should still exist
    assert.equal(fs.readFileSync(existingArchived, "utf8"), "# Old Version\n");
    // New file with timestamp suffix should exist
    const archiveFiles = fs.readdirSync(archiveTasksDir);
    const stampedFile = archiveFiles.find((f) => f.startsWith("task-completed-safe_") && f.endsWith(".md"));
    assert.ok(stampedFile, "Archived file collision must generate a timestamped file");
    console.log("✓ Assertion passed: Target file collision preserved with timestamp suffix.");

    // 4. Git Worktree actual removal using repoDir
    console.log("[Test 4] Git worktree actual removal via git worktree remove...");
    const gitRepoDir = path.join(TEST_ROOT, "real-git-repo");
    fs.mkdirSync(gitRepoDir, { recursive: true });
    cp.execSync("git init", { cwd: gitRepoDir });
    cp.execSync("git config user.name test && git config user.email test@test.com", { cwd: gitRepoDir });
    cp.execSync("git commit --allow-empty -m init", { cwd: gitRepoDir });

    const wtResult = setupGitWorktree({
      repoDir: gitRepoDir,
      worktreeRoot: path.join(TEST_ROOT, "worktrees"),
      worktreeName: "feature-branch-test",
    });
    assert.ok(fs.existsSync(wtResult.worktreeDir), "Worktree directory should be created");

    // Write task file with Project Dir
    const wtTaskFile = path.join(tasksDir, "task-with-wt.md");
    fs.writeFileSync(wtTaskFile, `# Task with Worktree\n- **Project Dir**: ${gitRepoDir}\n\n## Prompt\nhi\n`, "utf8");
    writeStatus(TEST_ROOT, "task-with-wt", {
      state: "completed",
      agent: "codex",
      workDir: wtResult.worktreeDir,
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
    });

    const resWt = await fetch(`${baseUrl}/api/recent-tasks/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: ["task-with-wt"], cleanWorktree: true }),
    });
    const dataWt = await resWt.json();
    assert.equal(dataWt.deletedCount, 1, "Task with worktree archived");
    assert.equal(dataWt.cleanedWorktrees.length, 1, "Worktree reported cleaned");
    assert.ok(!fs.existsSync(wtResult.worktreeDir), "Worktree directory must be removed by git worktree remove");
    // Verify git worktree list in repo no longer lists the worktree
    const wtList = cp.execSync("git worktree list --porcelain", { cwd: gitRepoDir, encoding: "utf8" });
    assert.ok(!wtList.includes(wtResult.worktreeDir), "git worktree list must no longer show removed worktree");
    console.log("✓ Assertion passed: Git worktree actually removed via git worktree remove.");

    // 5. Host & Origin Validation and Anti-DNS Rebinding
    console.log("[Test 5] Malicious Origin, Invalid Host, Content-Type, and Origin-less curl checks...");

    // 5a. Invalid Host header must return 403 (use node:http to set arbitrary Host header)
    const statusBadHost = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: "/api/system",
        method: "GET",
        headers: { host: "attacker.com:38080" },
      }, (res: any) => {
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(statusBadHost, 403, "Invalid Host header must return 403");
    console.log("✓ Assertion passed: Invalid Host returns 403.");

    // 5b. Malicious Origin on write endpoints must return 403 (even if loopback IP)
    const resMaliciousOriginApi = await fetch(`${baseUrl}/api/recent-tasks/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://malicious-site.com",
      },
      body: JSON.stringify({ taskId: "task_123" }),
    });
    assert.equal(resMaliciousOriginApi.status, 403, "Malicious Origin on /api/* write must return 403");

    const resMaliciousOriginMcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://malicious-site.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(resMaliciousOriginMcp.status, 403, "Malicious Origin on /mcp POST must return 403");
    console.log("✓ Assertion passed: Malicious Origin on write / /mcp POST returns 403.");

    // 5c. text/plain content type on write endpoints must return 415
    const resBadContentType = await fetch(`${baseUrl}/api/recent-tasks/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: "taskId=task_123",
    });
    assert.equal(resBadContentType.status, 415, "Non-JSON Content-Type must return 415");
    console.log("✓ Assertion passed: Non-JSON Content-Type returns 415.");

    // 5d. Origin-less curl requests return 200
    const resNoOrigin = await fetch(`${baseUrl}/api/recent-tasks`, {
      method: "GET",
    });
    assert.equal(resNoOrigin.status, 200, "Origin-less GET request returns 200");

    const resAllowedOrigin = await fetch(`${baseUrl}/api/system`, {
      method: "GET",
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(resAllowedOrigin.status, 200, "Whitelisted Origin returns 200");
    assert.equal(resAllowedOrigin.headers.get("access-control-allow-origin"), "http://localhost:3000");
    console.log("✓ Assertion passed: Whitelisted Origin and Origin-less requests work normally.");

    // 6. /mcp POST behavior on local calls (without Origin / with allowed Origin)
    console.log("[Test 6] /mcp POST behavior unchanged for local calls...");
    const resMcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    assert.equal(resMcp.status, 200, "/mcp POST must return 200");
    const mcpData = await resMcp.json();
    assert.equal(mcpData.result?.serverInfo?.name, "agent-bridge-mcp", "Server info matches");
    console.log("✓ Assertion passed: /mcp POST works seamlessly for local calls.");

  } finally {
    await handle.close();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

runArchiveSecurityTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});