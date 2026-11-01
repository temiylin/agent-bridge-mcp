import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgeMcpServer } from "../src/server.js";
import {
  setupGitWorktree,
  acquireWorktreeLock,
  releaseWorktreeLock,
  getWorktreeLockState,
  evaluateWorktreeDynamicStatus,
  detectWorktreeFileConflicts,
  checkWorktreeRemovalSafety,
} from "../src/worktree.js";
import { evaluateTaskConflicts, CandidateTask } from "../src/scheduler-tools.js";
import { performTaskDiagnosis } from "../src/recovery-tools.js";
import { writeStatus } from "../src/status.js";

async function runTests() {
  console.log("=== Running Worktree, Scheduler & Recovery Comprehensive Tests ===");

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-wt-sched-test-"));
  const tasksDir = path.join(testRoot, "tasks");
  const resultsDir = path.join(testRoot, "results");
  const logsDir = path.join(testRoot, "logs");
  const statusDir = path.join(testRoot, "status");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(statusDir, { recursive: true });

  // Create a real mock Git repo
  const repoDir = path.join(testRoot, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n");
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "test-repo", scripts: { test: "echo 'TESTS_PASSED'" } }, null, 2));
  spawnSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir, stdio: "ignore" });

  // Register in projects.json
  const projectsConfig = {
    version: 1,
    projects: {
      "vision_hub": {
        id: "vision_hub",
        name: "Vision Hub",
        repo_path: repoDir,
        paths: [repoDir],
        default_base_branch: "main",
        default_agent: "codex",
        verify_pr: {
          command: "npm test",
        },
      },
    },
  };
  fs.writeFileSync(path.join(testRoot, "projects.json"), JSON.stringify(projectsConfig, null, 2));

  // Initialize MCP Server & Client
  const { server } = createBridgeMcpServer(testRoot);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  console.log("✓ MCP Client connected to InMemoryTransport");

  // -------------------------------------------------------------
  // Test 1: create_worktree and verify directory creation
  // -------------------------------------------------------------
  console.log("\n[Test 1] create_worktree");
  const createWtRes = (await client.callTool({
    name: "create_worktree",
    arguments: {
      name: "mobile-sidebar-safe-area",
      project_id: "vision_hub",
      base_branch: "main",
    },
  })) as any;

  assert.ok(!createWtRes.isError, "create_worktree must not error");
  const createWtJson = JSON.parse(createWtRes.content[0].text);
  assert.strictEqual(createWtJson.success, true);
  assert.strictEqual(createWtJson.name, "mobile-sidebar-safe-area");
  assert.ok(fs.existsSync(createWtJson.path), "Worktree directory must exist on disk");
  console.log("✓ [1/9] create_worktree verified successfully");

  // -------------------------------------------------------------
  // Test 2: acquire_worktree_lock and release_worktree_lock
  // -------------------------------------------------------------
  console.log("\n[Test 2] acquire_worktree_lock & release_worktree_lock");
  const lockRes1 = (await client.callTool({
    name: "acquire_worktree_lock",
    arguments: {
      name: "mobile-sidebar-safe-area",
      task_id: "task_1001",
      reason: "Refactoring sidebar styles",
      mode: "read_write",
    },
  })) as any;
  assert.ok(!lockRes1.isError, "acquire_worktree_lock must succeed");

  // Second write lock on same worktree without force must be rejected!
  const lockRes2 = (await client.callTool({
    name: "acquire_worktree_lock",
    arguments: {
      name: "mobile-sidebar-safe-area",
      task_id: "task_1002",
      reason: "Concurrent edit",
      mode: "read_write",
      force: false,
    },
  })) as any;
  assert.ok(lockRes2.isError, "Conflicting acquire_worktree_lock must fail without force");

  // Release lock
  const unlockRes = (await client.callTool({
    name: "release_worktree_lock",
    arguments: {
      name: "mobile-sidebar-safe-area",
      task_id: "task_1001",
    },
  })) as any;
  assert.ok(!unlockRes.isError, "release_worktree_lock must succeed");
  console.log("✓ [2/9] acquire_worktree_lock & release_worktree_lock verified");

  // -------------------------------------------------------------
  // Test 3: Crash Recovery for Worktree Locks (Dead PID auto-unlock)
  // -------------------------------------------------------------
  console.log("\n[Test 3] Dynamic Crash Recovery for Stale Locks");
  // Acquire lock for task with a dead PID (e.g. pid 999999999)
  acquireWorktreeLock(testRoot, "mobile-sidebar-safe-area", {
    locked: true,
    locked_by: "task_crashed_999",
    task_id: "task_crashed_999",
    reason: "Orphaned lock from crashed worker",
    mode: "read_write",
  }, true);

  // Write status for crashed task indicating running, but with dead PID
  writeStatus(testRoot, "task_crashed_999", {
    state: "running",
    pid: 999999999, // Non-existent PID
    startedAt: new Date().toISOString(),
    worktreeName: "mobile-sidebar-safe-area",
  });

  const registry = {
    version: 1,
    worktrees: {
      "mobile-sidebar-safe-area": {
        worktree_id: "wt_mobile_sidebar",
        name: "mobile-sidebar-safe-area",
        path: createWtJson.path,
        branch: "mobile-sidebar-safe-area",
        lock: {
          locked: true,
          locked_by: "task_crashed_999",
          task_id: "task_crashed_999",
          reason: "Orphaned lock",
          mode: "read_write" as const,
          locked_at: new Date().toISOString(),
        },
      },
    },
  };
  const dynamicStatus = evaluateWorktreeDynamicStatus(testRoot, registry.worktrees["mobile-sidebar-safe-area"] as any, repoDir);
  assert.strictEqual(dynamicStatus.status, "idle", "Dead process lock must automatically evaluate as idle");
  console.log("✓ [3/9] Dynamic crash recovery auto-cleared stale lock from dead PID");

  // -------------------------------------------------------------
  // Test 4: list_worktrees and worktree_status
  // -------------------------------------------------------------
  console.log("\n[Test 4] list_worktrees and worktree_status");
  const listWtRes = (await client.callTool({
    name: "list_worktrees",
    arguments: {
      project_id: "vision_hub",
    },
  })) as any;
  assert.ok(!listWtRes.isError, "list_worktrees must not error");
  const listWtJson = JSON.parse(listWtRes.content[0].text);
  assert.ok(listWtJson.total_worktrees >= 2, "Should list main repo and created worktree");

  const wtStatusRes = (await client.callTool({
    name: "worktree_status",
    arguments: {
      name: "mobile-sidebar-safe-area",
      project_id: "vision_hub",
    },
  })) as any;
  assert.ok(!wtStatusRes.isError, "worktree_status must not error");
  const wtStatusJson = JSON.parse(wtStatusRes.content[0].text);
  assert.strictEqual(wtStatusJson.name, "mobile-sidebar-safe-area");
  console.log("✓ [4/9] list_worktrees and worktree_status verified");

  // -------------------------------------------------------------
  // Test 5: verify_worktree runs verification command
  // -------------------------------------------------------------
  console.log("\n[Test 5] verify_worktree");
  const verifyRes = (await client.callTool({
    name: "verify_worktree",
    arguments: {
      name: "mobile-sidebar-safe-area",
      project_id: "vision_hub",
      command: "echo 'VERIFY_SUCCESS'",
    },
  })) as any;
  assert.ok(!verifyRes.isError, "verify_worktree must not error");
  const verifyJson = JSON.parse(verifyRes.content[0].text);
  assert.strictEqual(verifyJson.success, true);
  assert.strictEqual(verifyJson.exit_code, 0);
  assert.ok(verifyJson.stdout.includes("VERIFY_SUCCESS"));
  console.log("✓ [5/9] verify_worktree executed tests in worktree");

  // -------------------------------------------------------------
  // Test 6: check_task_conflicts
  // -------------------------------------------------------------
  console.log("\n[Test 6] check_task_conflicts");
  const conflictRes = (await client.callTool({
    name: "check_task_conflicts",
    arguments: {
      tasks: [
        {
          id: "task_A",
          title: "Update navigation",
          prompt: "Modify sidebar in worktree",
          worktree: "mobile-sidebar-safe-area",
          worktree_mode: "read_write",
          target_files: ["src/sidebar.tsx"],
        },
        {
          id: "task_B",
          title: "Refactor sidebar buttons",
          prompt: "Change button colors in worktree",
          worktree: "mobile-sidebar-safe-area",
          worktree_mode: "read_write",
          target_files: ["src/sidebar.tsx"],
        },
        {
          id: "task_C",
          title: "Fix video stream",
          prompt: "Fix horizontal scrolling",
          worktree: "mobile-discover-video-scroll",
          worktree_mode: "read_write",
          target_files: ["src/video.tsx"],
        },
      ],
      project_id: "vision_hub",
    },
  })) as any;

  assert.ok(!conflictRes.isError, "check_task_conflicts must not error");
  const conflictJson = JSON.parse(conflictRes.content[0].text);
  assert.strictEqual(conflictJson.has_conflicts, true);
  assert.ok(conflictJson.conflicts.some((c: any) => c.type === "worktree_write_collision"));
  assert.ok(conflictJson.conflicts.some((c: any) => c.type === "target_file_overlap"));
  console.log("✓ [6/9] check_task_conflicts detected worktree write and target file overlaps");

  // -------------------------------------------------------------
  // Test 7: schedule_tasks auto-parallelizes non-conflicting & queues conflicting
  // -------------------------------------------------------------
  console.log("\n[Test 7] schedule_tasks");
  const schedRes = (await client.callTool({
    name: "schedule_tasks",
    arguments: {
      tasks: [
        {
          title: "Task Parallel 1",
          prompt: "Modify sidebar",
          worktree: "mobile-sidebar-safe-area",
          worktree_mode: "read_write",
        },
        {
          title: "Task Conflicting 2",
          prompt: "Also modify sidebar concurrently",
          worktree: "mobile-sidebar-safe-area",
          worktree_mode: "read_write",
        },
      ],
      project_id: "vision_hub",
    },
  })) as any;

  assert.ok(!schedRes.isError, "schedule_tasks must not error");
  const schedJson = JSON.parse(schedRes.content[0].text);
  assert.strictEqual(schedJson.dispatched_count, 1, "First non-conflicting task should be dispatched immediately");
  assert.strictEqual(schedJson.queued_count, 1, "Second conflicting task should be queued");
  console.log("✓ [7/9] schedule_tasks successfully dispatched 1 and queued 1 conflicting task");

  // -------------------------------------------------------------
  // Test 8: diagnose_task & recover_task with uncommitted worktree files
  // -------------------------------------------------------------
  console.log("\n[Test 8] diagnose_task and recover_task with worktree dirty preservation");
  const crashedTaskId = "task_crashed_with_files";
  const wtDir = createWtJson.path;

  // Simulate dirty files created before crash
  fs.writeFileSync(path.join(wtDir, "new-feature.ts"), "export const FEATURE = true;\n");

  writeStatus(testRoot, crashedTaskId, {
    state: "running",
    pid: 999999999, // Dead PID -> crashed!
    startedAt: new Date(Date.now() - 30000).toISOString(),
    worktreeName: "mobile-sidebar-safe-area",
    workDir: wtDir,
    projectId: "vision_hub",
  });
  fs.writeFileSync(path.join(tasksDir, `${crashedTaskId}.md`), `# Crashed Task\n\n- **Task ID**: ${crashedTaskId}\n\n---\n\n## Prompt\n\nImplement new feature in new-feature.ts\n`);

  const diagRes = (await client.callTool({
    name: "diagnose_task",
    arguments: {
      task_id: crashedTaskId,
    },
  })) as any;

  assert.ok(!diagRes.isError, "diagnose_task must not error");
  const diagJson = JSON.parse(diagRes.content[0].text);
  assert.strictEqual(diagJson.health_status, "process_crashed");
  assert.strictEqual(diagJson.can_recover, true);
  assert.ok(diagJson.worktree_state.dirty_count > 0, "Must detect dirty files in worktree");

  // Call recover_task
  const recRes = (await client.callTool({
    name: "recover_task",
    arguments: {
      task_id: crashedTaskId,
      resume_mode: "continue_worktree",
      additional_instructions: "Please finish adding unit tests.",
    },
  })) as any;

  assert.ok(!recRes.isError, "recover_task must not error");
  const recJson = JSON.parse(recRes.content[0].text);
  assert.strictEqual(recJson.success, true);
  assert.strictEqual(recJson.recovered_from_task_id, crashedTaskId);
  assert.strictEqual(recJson.worktree_retained, "mobile-sidebar-safe-area");
  assert.ok(recJson.retained_files.includes("new-feature.ts"), "Must preserve modified new-feature.ts");
  console.log("✓ [8/9] diagnose_task and recover_task preserved dirty worktree files and redispatched");

  // -------------------------------------------------------------
  // Test 9: get_handoff_context & project_summary
  // -------------------------------------------------------------
  console.log("\n[Test 9] get_handoff_context & project_summary");
  const handoffRes = (await client.callTool({
    name: "get_handoff_context",
    arguments: {
      worktree_name: "mobile-sidebar-safe-area",
      project_id: "vision_hub",
    },
  })) as any;
  assert.ok(!handoffRes.isError, "get_handoff_context must not error");
  const handoffJson = JSON.parse(handoffRes.content[0].text);
  assert.strictEqual(handoffJson.worktree, "mobile-sidebar-safe-area");
  assert.ok(handoffJson.handoff_prompt_block.includes("AI Handoff Dossier"));

  const projSummRes = (await client.callTool({
    name: "project_summary",
    arguments: {
      project_id: "vision_hub",
    },
  })) as any;
  assert.ok(!projSummRes.isError, "project_summary must not error");
  const projSummJson = JSON.parse(projSummRes.content[0].text);
  assert.ok(projSummJson.worktrees, "project_summary must include worktrees");
  assert.ok(projSummJson.worktrees.total_worktrees >= 2);
  assert.ok(projSummJson.queue, "project_summary must include queue");
  console.log("✓ [9/9] get_handoff_context & enhanced project_summary verified");

  // Cleanup
  await client.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log("\n=== All Worktree, Scheduler & Recovery Tests Passed! ===\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
