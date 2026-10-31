import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  enqueueTask,
  listQueue,
  reorderQueue,
  updateQueueItem,
  cancelQueueItem,
  pauseQueue,
  resumeQueue,
  loadSessionQueue,
} from "../src/queue.js";
import {
  dispatchNextInQueue,
  onTaskFinished,
  reconcileQueues,
  isSessionBusy,
} from "../src/queue-dispatcher.js";
import { createBridgeMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeStatus } from "../src/status.js";

const TEST_ROOT = "/tmp/agent-bridge-queue-test";

async function runQueueTests() {
  console.log("=================================================");
  console.log("  Auto Task Queue & Session Dispatch Test Suite  ");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // 1. Storage & Queue ordering tests
  console.log("\n[Test 1] Queue Ordering & Atomic Persistence");
  const sessionId = "sess_feature_checkout";
  const item1 = enqueueTask(TEST_ROOT, {
    session_id: sessionId,
    prompt: "Step 1: Write data model migrations for cart table",
    mode: "auto",
  });
  const item2 = enqueueTask(TEST_ROOT, {
    session_id: sessionId,
    prompt: "Step 2: Add API endpoint POST /api/cart",
    mode: "auto",
  });
  const item3 = enqueueTask(TEST_ROOT, {
    session_id: sessionId,
    prompt: "Step 3: Add unit tests with mock DB",
    mode: "notify",
  });

  assert.equal(item1.position, 1);
  assert.equal(item2.position, 2);
  assert.equal(item3.position, 3);

  // Check no leftover .tmp files
  const qDir = path.join(TEST_ROOT, "queue");
  const tmpFiles = fs.readdirSync(qDir).filter((f) => f.endsWith(".tmp"));
  assert.equal(tmpFiles.length, 0, "No .tmp files in queue dir");

  // Reorder: move item 3 to position 1
  const reorderRes = reorderQueue(TEST_ROOT, sessionId, undefined, {
    id: item3.id,
    target_position: 1,
  });
  assert.ok(reorderRes.success);
  assert.equal(reorderRes.items[0].id, item3.id);
  assert.equal(reorderRes.items[0].position, 1);
  assert.equal(reorderRes.items[1].id, item1.id);
  assert.equal(reorderRes.items[1].position, 2);
  assert.equal(reorderRes.items[2].id, item2.id);
  assert.equal(reorderRes.items[2].position, 3);
  console.log("✓ Test 1 passed: Queue ordering, positions, and reorder working as expected.");

  // Restore order: item1, item2, item3
  reorderQueue(TEST_ROOT, sessionId, [item1.id, item2.id, item3.id]);

  // 2. Completion trigger auto-dispatch test
  console.log("\n[Test 2] Task Completion Auto-Dispatch");
  // Simulate task 0 completing in this session
  const task0Id = "task_init_cart_000";
  writeStatus(TEST_ROOT, task0Id, {
    state: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  // Call onTaskFinished for task0
  onTaskFinished(TEST_ROOT, task0Id, "completed", sessionId);

  // item1 was auto mode, so it should have been dispatched!
  const stateAfter1 = loadSessionQueue(TEST_ROOT, sessionId);
  // item1 removed from pending items list upon dispatch
  assert.equal(stateAfter1.items.length, 2);
  assert.equal(stateAfter1.items[0].id, item2.id);
  assert.equal(stateAfter1.items[0].position, 1);

  // Check task generated in tasks/
  const taskFiles = fs.readdirSync(path.join(TEST_ROOT, "tasks"));
  assert.equal(taskFiles.length, 1, "Dispatched task file should exist in tasks/");
  const dispatchedTaskContent = fs.readFileSync(path.join(TEST_ROOT, "tasks", taskFiles[0]), "utf8");
  assert.ok(dispatchedTaskContent.includes("Step 1: Write data model migrations for cart table"));
  assert.ok(dispatchedTaskContent.includes(`- **Session ID**: ${sessionId}`));
  console.log("✓ Test 2 passed: onTaskFinished(completed) auto-dispatched the next item.");

  // 3. Single in-flight task per session check
  console.log("\n[Test 3] Single In-Flight Task Constraint");
  // The dispatched task from step 2 is currently "queued" in status/
  assert.ok(isSessionBusy(TEST_ROOT, sessionId), "Session should be busy while dispatched task is in-flight");
  const nextAttempt = dispatchNextInQueue(TEST_ROOT, sessionId);
  assert.equal(nextAttempt, null, "Should not dispatch next item while previous task is still in-flight");
  console.log("✓ Test 3 passed: Enforced single in-flight task per session.");

  // Complete the in-flight task
  const dispatchedTaskId = taskFiles[0].replace(/\.md$/, "");
  writeStatus(TEST_ROOT, dispatchedTaskId, {
    state: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  // 4. Failure pause test
  console.log("\n[Test 4] Task Failure Queue Pause");
  // Simulate task failure in session
  const failingTaskId = "task_failing_999";
  writeStatus(TEST_ROOT, failingTaskId, {
    state: "failed",
    reason: "Unit test assertion failed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  onTaskFinished(TEST_ROOT, failingTaskId, "failed", sessionId, "Unit test assertion failed");

  const stateAfterFail = loadSessionQueue(TEST_ROOT, sessionId);
  assert.equal(stateAfterFail.paused, true, "Session queue should be paused on failure");
  assert.ok(stateAfterFail.pause_reason?.includes("Unit test assertion failed"));
  // item2 should still be queued and NOT dispatched
  assert.equal(stateAfterFail.items.length, 2);
  assert.equal(stateAfterFail.items[0].id, item2.id);
  assert.equal(stateAfterFail.items[0].status, "queued");
  console.log("✓ Test 4 passed: Failure properly paused queue and recorded reason.");

  // Resume queue
  resumeQueue(TEST_ROOT, sessionId);
  const stateResumed = loadSessionQueue(TEST_ROOT, sessionId);
  assert.equal(stateResumed.paused, false);

  // Now dispatch next: item2 is auto mode
  const dispItem2 = dispatchNextInQueue(TEST_ROOT, sessionId);
  assert.ok(dispItem2);
  assert.equal(dispItem2?.id, item2.id);

  // Complete item2's dispatched task
  assert.ok(dispItem2?.dispatched_task_id);
  writeStatus(TEST_ROOT, dispItem2.dispatched_task_id!, {
    state: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  // 5. mode=notify check
  console.log("\n[Test 5] mode=notify Behavior");
  // The next item is item3 (mode="notify")
  const dispItem3 = dispatchNextInQueue(TEST_ROOT, sessionId);
  assert.ok(dispItem3);
  assert.equal(dispItem3?.id, item3.id);
  assert.equal(dispItem3?.status, "ready", "mode=notify should mark status 'ready' without dispatching");
  assert.equal(dispItem3?.dispatched_task_id, undefined, "mode=notify should not create a task directly");
  console.log("✓ Test 5 passed: mode=notify marked item as 'ready' for caller.");

  // 6. Restart Recovery / Reconcile test
  console.log("\n[Test 6] Restart Recovery & Reconcile");
  const sessionRecover = "sess_recover_xyz";
  const triggerTaskId = "task_trigger_before_restart";
  writeStatus(TEST_ROOT, triggerTaskId, {
    state: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  // Enqueue item with after_task_id = triggerTaskId while worker was 'down'
  enqueueTask(TEST_ROOT, {
    session_id: sessionRecover,
    after_task_id: triggerTaskId,
    prompt: "Run post-restart data sync",
    mode: "auto",
  });

  // Trigger reconcile
  reconcileQueues(TEST_ROOT);

  const recoverQueue = loadSessionQueue(TEST_ROOT, sessionRecover);
  // Item should have been dispatched during reconcile
  assert.equal(recoverQueue.items.length, 0);
  const allTasks = fs.readdirSync(path.join(TEST_ROOT, "tasks"));
  const syncTask = allTasks.find((f) => {
    const c = fs.readFileSync(path.join(TEST_ROOT, "tasks", f), "utf8");
    return c.includes("Run post-restart data sync");
  });
  assert.ok(syncTask, "Item triggered by finished task should be dispatched on reconcile");
  console.log("✓ Test 6 passed: Reconcile detected already-finished trigger task and dispatched.");

  // 7. MCP Tools for Queue test
  console.log("\n[Test 7] MCP Queue Tools via Client");
  const instance = createBridgeMcpServer(TEST_ROOT);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    instance.server.connect(serverTransport),
  ]);

  // enqueue_task MCP tool
  const enqRes = await client.callTool({
    name: "enqueue_task",
    arguments: {
      session_id: "sess_mcp_test",
      prompt: "Execute MCP queue test step 1",
      mode: "auto",
    },
  });
  assert.ok(!enqRes.isError);
  const enqData = JSON.parse((enqRes.content as any)[0].text);
  assert.ok(enqData.id);
  assert.equal(enqData.position, 1);

  // list_queue MCP tool
  const listRes = await client.callTool({
    name: "list_queue",
    arguments: {
      session_id: "sess_mcp_test",
    },
  });
  assert.ok(!listRes.isError);
  const listData = JSON.parse((listRes.content as any)[0].text);
  assert.equal(listData.length, 1);
  assert.equal(listData[0].id, enqData.id);
  assert.ok(listData[0].prompt_preview.length <= 80);

  // update_queue_item MCP tool
  const updateRes = await client.callTool({
    name: "update_queue_item",
    arguments: {
      id: enqData.id,
      prompt: "Execute MCP queue test step 1 (updated)",
      mode: "notify",
    },
  });
  assert.ok(!updateRes.isError);

  // pause_queue & resume_queue MCP tools
  const pauseRes = await client.callTool({
    name: "pause_queue",
    arguments: { session_id: "sess_mcp_test" },
  });
  assert.ok(!pauseRes.isError);
  assert.equal(loadSessionQueue(TEST_ROOT, "sess_mcp_test").paused, true);

  const resumeRes = await client.callTool({
    name: "resume_queue",
    arguments: { session_id: "sess_mcp_test" },
  });
  assert.ok(!resumeRes.isError);
  assert.equal(loadSessionQueue(TEST_ROOT, "sess_mcp_test").paused, false);

  // cancel_queue_item MCP tool
  const cancelRes = await client.callTool({
    name: "cancel_queue_item",
    arguments: { id: enqData.id },
  });
  assert.ok(!cancelRes.isError);
  assert.equal(loadSessionQueue(TEST_ROOT, "sess_mcp_test").items.length, 0);
  console.log("✓ Test 7 passed: All MCP queue tools work as expected.");

  await client.close();

  console.log("\n=================================================");
  console.log("  All Auto Queue tests passed successfully!     ");
  console.log("=================================================\n");
}

runQueueTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
