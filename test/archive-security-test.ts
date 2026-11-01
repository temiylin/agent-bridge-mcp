import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startHttpServer } from "../src/http-server.js";
import { writeStatus } from "../src/status.js";
import { resolveWorktreeRoot } from "../src/worktree.js";

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
    // 1. Refuse archive for running / queued tasks
    console.log("[Test 1] Refuse archive for running task...");
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

    // 3. Normal completed task moved to archive/ directory
    console.log("[Test 3] Verify completed task is safely moved to archive/ directory...");
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

    const resSafe = await fetch(`${baseUrl}/api/recent-tasks/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: ["task-completed-safe"] }),
    });
    const dataSafe = await resSafe.json();
    assert.equal(dataSafe.deletedCount, 1, "Completed task archived");
    const archivePath = path.join(TEST_ROOT, "archive", "tasks", "task-completed-safe.md");
    assert.ok(fs.existsSync(archivePath), "Task markdown file should be moved into archive/ directory");
    console.log("✓ Assertion passed: Completed task moved into archive/ directory instead of being permanently deleted.");

  } finally {
    await handle.close();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

runArchiveSecurityTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
