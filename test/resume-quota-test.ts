import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isQuotaExhaustedError,
  stashQuotaTask,
  getStashedQuotaTask,
  removeStashedQuotaTask,
} from "../src/session-quota.js";
import { enqueueTask, loadSessionQueue } from "../src/queue.js";
import { onTaskFinished } from "../src/queue-dispatcher.js";
import { writeStatus, readStatus } from "../src/status.js";
import { createBridgeMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_ROOT = "/tmp/agent-bridge-resume-quota-test";

async function runResumeQuotaTests() {
  console.log("=================================================");
  console.log("  Resume Session After Quota & Account Switch    ");
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

  // 1. Quota detection patterns test
  console.log("\n[Test 1] Quota error detection patterns");
  assert.equal(isQuotaExhaustedError(429, "", ""), true);
  assert.equal(isQuotaExhaustedError(1, "", "Resource_Exhausted: rate limit exceeded"), true);
  assert.equal(isQuotaExhaustedError(1, "You exceeded your current quota, please check your plan", ""), true);
  assert.equal(isQuotaExhaustedError(1, "", "Fatal syntax error in file"), false);
  console.log("✓ Test 1 passed: Quota error detection handles status codes and error messages.");

  // 2. Task quota pause & queue non-permanent failure
  console.log("\n[Test 2] Quota detection -> paused_quota & queue NOT permanently failed");
  const sessionId = "sess_cockpit_flow";
  const taskId = "task_quota_001";

  // Enqueue next task in this session
  const queuedItem = enqueueTask(TEST_ROOT, {
    session_id: sessionId,
    prompt: "Step 2 of the multi-turn session",
    mode: "auto",
  });

  // Write status as paused_quota
  writeStatus(TEST_ROOT, taskId, {
    state: "paused_quota",
    reason: "quota or rate limit exhausted",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
  });

  // Stash task context
  stashQuotaTask(TEST_ROOT, {
    taskId,
    session_id: sessionId,
    agent: "agy",
    model: "gemini-3.8-flash",
    prompt: "Step 1: complex refactoring that ran out of tokens",
    pausedAt: new Date().toISOString(),
  });

  // Call onTaskFinished with paused_quota
  onTaskFinished(TEST_ROOT, taskId, "paused_quota", sessionId, "quota or rate limit exhausted");

  // Verify status is paused_quota
  const statusRead = readStatus(TEST_ROOT, taskId);
  assert.equal(statusRead?.state, "paused_quota");

  // Verify session queue is paused, but NOT permanently failed
  const queueState = loadSessionQueue(TEST_ROOT, sessionId);
  assert.equal(queueState.paused, true);
  assert.ok(queueState.pause_reason?.includes("paused_quota"));
  // Next item remains intact in queue
  assert.equal(queueState.items.length, 1);
  assert.equal(queueState.items[0].id, queuedItem.id);
  assert.equal(queueState.items[0].status, "queued");
  console.log("✓ Test 2 passed: Marked paused_quota; queue paused cleanly without discarding queued items.");

  // 3. Resume path continues same session (not starting fresh)
  console.log("\n[Test 3] Resume after account switch continues SAME session_id");
  const instance = createBridgeMcpServer(TEST_ROOT);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    instance.server.connect(serverTransport),
  ]);

  const resumeRes = await client.callTool({
    name: "resume_after_account_switch",
    arguments: {
      target: taskId,
    },
  });
  assert.ok(!resumeRes.isError);
  const resumeData = JSON.parse((resumeRes.content as any)[0].text);
  assert.equal(resumeData.resumed, true);
  assert.equal(resumeData.session_id, sessionId);
  assert.equal(resumeData.continued_session, true);
  assert.ok(resumeData.new_task_id);

  // Check generated task file has Continue Session: true and identical Session ID
  const newTaskFile = path.join(tasksDir, `${resumeData.new_task_id}.md`);
  assert.ok(fs.existsSync(newTaskFile), "New resumed task file must exist");
  const newTaskContent = fs.readFileSync(newTaskFile, "utf8");
  assert.ok(newTaskContent.includes("- **Continue Session**: true"));
  assert.ok(newTaskContent.includes(`- **Session ID**: ${sessionId}`));
  assert.ok(newTaskContent.includes("Step 1: complex refactoring that ran out of tokens"));

  // Verify session queue was automatically unpaused upon resume
  const queueAfterResume = loadSessionQueue(TEST_ROOT, sessionId);
  assert.equal(queueAfterResume.paused, false, "Session queue should be unpaused upon resume");

  // Verify stashed quota record was cleaned up
  assert.equal(getStashedQuotaTask(TEST_ROOT, taskId), null);
  console.log("✓ Test 3 passed: Re-launched task with continue_session=true and identical session_id.");

  // 4. auto_resume_on_account_ready test
  console.log("\n[Test 4] auto_resume_on_account_ready tool check");
  const autoRes = await client.callTool({
    name: "auto_resume_on_account_ready",
    arguments: {},
  });
  assert.ok(!autoRes.isError);
  const autoData = JSON.parse((autoRes.content as any)[0].text);
  assert.ok("account_ready" in autoData);
  console.log("✓ Test 4 passed: auto_resume_on_account_ready responded cleanly.");

  await client.close();

  console.log("\n=================================================");
  console.log("  All Resume Quota tests passed successfully!   ");
  console.log("=================================================\n");
}

runResumeQuotaTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
