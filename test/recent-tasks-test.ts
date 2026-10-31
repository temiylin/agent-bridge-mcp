import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  queryRecentTasks,
  formatElapsedSeconds,
  getLastLogLine,
  extractPrUrl,
} from "../src/recent-tasks.js";
import { enqueueTask, pauseQueue } from "../src/queue.js";
import { writeStatus } from "../src/status.js";
import { createBridgeMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_ROOT = "/tmp/agent-bridge-recent-tasks-test";

async function runRecentTasksTests() {
  console.log("=================================================");
  console.log("  list_recent_tasks & dashboard MCP Tools Test   ");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const tasksDir = path.join(TEST_ROOT, "tasks");
  const resultsDir = path.join(TEST_ROOT, "results");
  const logsDir = path.join(TEST_ROOT, "logs");
  const statusDir = path.join(TEST_ROOT, "status");
  const queueDir = path.join(TEST_ROOT, "queue");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(statusDir, { recursive: true });
  fs.mkdirSync(queueDir, { recursive: true });

  // 1. Helper functions test
  console.log("\n[Test 1] Helper functions (elapsed, last log line, PR URL)");
  assert.equal(formatElapsedSeconds(5), "5s");
  assert.equal(formatElapsedSeconds(125), "2m 5s");
  assert.equal(formatElapsedSeconds(3665), "1h 1m");

  const sampleLogPath = path.join(logsDir, "test.log");
  fs.writeFileSync(sampleLogPath, "line 1\nline 2\n[INFO] Build succeeded in 4.2s\n", "utf8");
  assert.equal(getLastLogLine(sampleLogPath), "[INFO] Build succeeded in 4.2s");

  const prText = "Created PR at https://github.com/generic-org/generic-repo/pull/42 for review";
  assert.equal(extractPrUrl(prText), "https://github.com/generic-org/generic-repo/pull/42");
  console.log("✓ Test 1 passed: Helpers working accurately.");

  // 2. Setup mock tasks in status/ and queue/
  console.log("\n[Test 2] Query recent tasks aggregation & filtering");
  // Running task
  const runTaskId = "task_running_001";
  writeStatus(TEST_ROOT, runTaskId, {
    state: "running",
    startedAt: new Date(Date.now() - 45000).toISOString(), // 45s ago
    pid: process.pid, // live pid so reconciliation keeps it running
    workerPid: process.pid,
  } as any);
  fs.writeFileSync(
    path.join(tasksDir, `${runTaskId}.md`),
    "# Running Task\n\n- **Task ID**: task_running_001\n- **Project**: billing-api\n- **Session ID**: sess_billing\n\nPrompt content\n"
  );
  fs.writeFileSync(
    path.join(logsDir, `${runTaskId}.out`),
    "Compiling TypeScript files...\nEmitting outputs for 12 files\n"
  );

  // Completed task with PR URL
  const compTaskId = "task_comp_002";
  writeStatus(TEST_ROOT, compTaskId, {
    state: "completed",
    startedAt: new Date(Date.now() - 100000).toISOString(),
    finishedAt: new Date(Date.now() - 50000).toISOString(),
  });
  fs.writeFileSync(
    path.join(tasksDir, `${compTaskId}.md`),
    "# Completed Task\n\n- **Task ID**: task_comp_002\n- **Project**: auth-svc\n- **Session ID**: sess_auth\n\nPrompt content\n"
  );
  fs.writeFileSync(
    path.join(resultsDir, `${compTaskId}.md`),
    "# Result\n\nPR created: https://github.com/test-org/test-repo/pull/123\n\n## Output\n\nTests passed: 24/24\n"
  );

  // Queued task and Paused task in queue/
  enqueueTask(TEST_ROOT, {
    session_id: "sess_queued_session",
    prompt: "Queued prompt for data export",
    mode: "auto",
    options: { project: "analytics" },
  });

  enqueueTask(TEST_ROOT, {
    session_id: "sess_paused_session",
    prompt: "Paused prompt for backup",
    mode: "auto",
    options: { project: "ops" },
  });
  pauseQueue(TEST_ROOT, "sess_paused_session");

  // Query all
  const allTasks = queryRecentTasks(TEST_ROOT);
  assert.equal(allTasks.length, 4);

  // Running task should come first
  assert.equal(allTasks[0].taskId, runTaskId);
  assert.equal(allTasks[0].status, "running");
  assert.ok(allTasks[0].elapsed?.includes("45s"));
  assert.equal(allTasks[0].last_log_line, "Emitting outputs for 12 files");
  assert.equal(allTasks[0].session_id, "sess_billing");
  assert.equal(allTasks[0].project, "billing-api");

  // Completed task
  const compItem = allTasks.find((t) => t.taskId === compTaskId);
  assert.ok(compItem);
  assert.equal(compItem?.status, "completed");
  assert.equal(compItem?.pr_url, "https://github.com/test-org/test-repo/pull/123");
  assert.equal(compItem?.last_log_line, "Tests passed: 24/24");

  // Filter by status=paused
  const pausedList = queryRecentTasks(TEST_ROOT, { status: "paused" });
  assert.equal(pausedList.length, 1);
  assert.equal(pausedList[0].session_id, "sess_paused_session");
  assert.equal(pausedList[0].status, "paused");

  // Filter by project=billing-api
  const billingList = queryRecentTasks(TEST_ROOT, { project: "billing-api" });
  assert.equal(billingList.length, 1);
  assert.equal(billingList[0].taskId, runTaskId);

  // Filter by session_id=sess_auth
  const authList = queryRecentTasks(TEST_ROOT, { session_id: "sess_auth" });
  assert.equal(authList.length, 1);
  assert.equal(authList[0].taskId, compTaskId);
  console.log("✓ Test 2 passed: Direct query and filtering verified.");

  // 3. MCP Tools test (list_recent_tasks and alias dashboard)
  console.log("\n[Test 3] MCP Tools (list_recent_tasks and dashboard alias)");
  const instance = createBridgeMcpServer(TEST_ROOT);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    instance.server.connect(serverTransport),
  ]);

  // Test calling list_recent_tasks
  const listRes = await client.callTool({
    name: "list_recent_tasks",
    arguments: { limit: 10 },
  });
  assert.ok(!listRes.isError);
  const listItems = JSON.parse((listRes.content as any)[0].text);
  assert.equal(listItems.length, 4);

  // Test calling dashboard alias
  const dashRes = await client.callTool({
    name: "dashboard",
    arguments: { limit: 10 },
  });
  assert.ok(!dashRes.isError);
  const dashItems = JSON.parse((dashRes.content as any)[0].text);
  assert.deepEqual(dashItems, listItems, "dashboard alias output must match list_recent_tasks exactly");
  console.log("✓ Test 3 passed: Both list_recent_tasks and dashboard MCP tools return matching compact results.");

  await client.close();

  console.log("\n=================================================");
  console.log("  All Recent Tasks / Dashboard tests passed!     ");
  console.log("=================================================\n");
}

runRecentTasksTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
