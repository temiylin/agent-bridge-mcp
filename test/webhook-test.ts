import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {
  setTaskWebhook,
  getTaskWebhook,
  clearTaskWebhook,
  deliverWebhookWithRetry,
  triggerTaskWebhook,
  computeHmacSignature,
} from "../src/webhook.js";
import { enqueueTask, loadSessionQueue } from "../src/queue.js";
import { onTaskFinished, dispatchTaskDirect } from "../src/queue-dispatcher.js";
import { createBridgeMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_ROOT = "/tmp/agent-bridge-webhook-test";

async function runWebhookTests() {
  console.log("=================================================");
  console.log("  Opt-In Per-Task Completion Webhook Test Suite  ");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // Start local HTTP server to receive webhook POSTs
  const receivedWebhooks: Array<{ body: any; headers: http.IncomingHttpHeaders }> = [];
  let shouldFail = false;

  const server = http.createServer((req, res) => {
    let bodyStr = "";
    req.on("data", (chunk) => {
      bodyStr += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (shouldFail) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "server error" }));
        return;
      }
      try {
        const parsed = JSON.parse(bodyStr);
        receivedWebhooks.push({ body: parsed, headers: req.headers });
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const webhookUrl = `http://127.0.0.1:${port}/webhook`;

  // 1. Storage & signature tests
  console.log("\n[Test 1] Per-task storage, HMAC signature, and helper tools");
  const taskId1 = "task_test_wh_001";
  const secretKey = "super-secret-hmac-key";

  setTaskWebhook(TEST_ROOT, taskId1, {
    url: webhookUrl,
    secret: secretKey,
    events: ["completed", "failed"],
  });

  const storedConfig = getTaskWebhook(TEST_ROOT, taskId1);
  assert.ok(storedConfig);
  assert.equal(storedConfig?.url, webhookUrl);
  assert.equal(storedConfig?.secret, secretKey);

  const testPayload = JSON.stringify({ hello: "world" });
  const sig = computeHmacSignature(testPayload, secretKey);
  assert.ok(sig && sig.length === 64, "HMAC signature should be 64 hex chars");

  clearTaskWebhook(TEST_ROOT, taskId1);
  assert.equal(getTaskWebhook(TEST_ROOT, taskId1), null, "Webhook should be cleared");
  console.log("✓ Test 1 passed: setTaskWebhook, clearTaskWebhook, and HMAC signature work.");

  // 2. Fire on complete test
  console.log("\n[Test 2] Fire on complete with payload & HMAC header");
  const taskId2 = "task_test_wh_002";
  setTaskWebhook(TEST_ROOT, taskId2, {
    url: webhookUrl,
    secret: secretKey,
    events: ["completed"],
  });

  // Write mock task log
  const logsDir = path.join(TEST_ROOT, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, `${taskId2}.out`), "Done executing build step!\n[SUCCESS] All checks passed.\n");

  await triggerTaskWebhook(TEST_ROOT, taskId2, "completed", "sess_web_1", 2500);

  // Wait a tick for async delivery
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(receivedWebhooks.length, 1);
  const received = receivedWebhooks[0];
  assert.equal(received.body.taskId, taskId2);
  assert.equal(received.body.session_id, "sess_web_1");
  assert.equal(received.body.status, "completed");
  assert.equal(received.body.elapsed_ms, 2500);
  assert.equal(received.body.last_log_snippet, "[SUCCESS] All checks passed.");
  assert.ok(received.headers["x-agent-bridge-signature"]);
  console.log("✓ Test 2 passed: Webhook fired on complete with accurate payload and HMAC signature.");

  // 3. Skip when omitted test (opt-in only requirement)
  console.log("\n[Test 3] Skip when omitted (no webhook configured for task)");
  const taskIdNoWebhook = "task_no_webhook_003";
  await triggerTaskWebhook(TEST_ROOT, taskIdNoWebhook, "completed", "sess_web_1");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(receivedWebhooks.length, 1, "No webhook should fire when on_complete was not opted in");
  console.log("✓ Test 3 passed: Skipped cleanly when omitted.");

  // 4. Webhook failure does NOT block queue advance
  console.log("\n[Test 4] Failure does NOT block queue advance");
  const sessQueueId = "sess_queue_resilient";
  const item1 = enqueueTask(TEST_ROOT, {
    session_id: sessQueueId,
    prompt: "Step 1 of queue",
    mode: "auto",
  });

  // Make webhook server fail with 500
  shouldFail = true;

  // Simulate task finishing for a previous task in this session with failing webhook
  const failingWhTaskId = "task_wh_failing_004";
  setTaskWebhook(TEST_ROOT, failingWhTaskId, {
    url: webhookUrl,
  });

  // Calling triggerTaskWebhook should not throw
  await triggerTaskWebhook(TEST_ROOT, failingWhTaskId, "completed", sessQueueId);

  // Advance queue on task finished
  onTaskFinished(TEST_ROOT, failingWhTaskId, "completed", sessQueueId);

  // Verify queue advanced and item1 was dispatched regardless of webhook failure
  const queueState = loadSessionQueue(TEST_ROOT, sessQueueId);
  assert.equal(queueState.items.length, 0, "Queue must advance and dispatch next item even if webhook delivery fails");
  console.log("✓ Test 4 passed: Webhook failure did not block queue progression.");

  shouldFail = false;

  // 5. MCP tools for set_task_webhook and clear_task_webhook
  console.log("\n[Test 5] MCP set_task_webhook and clear_task_webhook tools");
  const instance = createBridgeMcpServer(TEST_ROOT);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    instance.server.connect(serverTransport),
  ]);

  const attachRes = await client.callTool({
    name: "set_task_webhook",
    arguments: {
      taskId: "task_via_mcp_005",
      on_complete: {
        url: webhookUrl,
        secret: "my-secret",
      },
    },
  });
  assert.ok(!attachRes.isError);
  assert.ok(getTaskWebhook(TEST_ROOT, "task_via_mcp_005"));

  const clearRes = await client.callTool({
    name: "clear_task_webhook",
    arguments: {
      taskId: "task_via_mcp_005",
    },
  });
  assert.ok(!clearRes.isError);
  assert.equal(getTaskWebhook(TEST_ROOT, "task_via_mcp_005"), null);
  console.log("✓ Test 5 passed: MCP webhook tools verified.");

  await client.close();
  server.close();

  console.log("\n=================================================");
  console.log("  All Webhook tests passed successfully!        ");
  console.log("=================================================\n");
}

runWebhookTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
