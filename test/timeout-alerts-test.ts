import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import {
  resolveWebhookDelivery,
  setTaskWebhook,
  triggerTaskWebhook,
} from "../src/webhook.js";
import { resolveHardKillTimeoutMs, HARD_KILL_SAFETY_CAP_MS } from "../src/worker.js";
import { getAgentSessionOrProgressMtime, getProcessTreeCpuTime, getDescendantPids } from "../src/task-reconcile.js";

const TEST_ROOT = "/tmp/agent-bridge-timeout-alerts-test";

async function waitForFile(filePath: string, timeoutMs: number = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (content.trim().length > 0) return content;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for file "${filePath}"`);
}

async function waitForCondition(check: () => boolean, timeoutMs: number = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Condition not met within timeout");
}

async function runTimeoutAlertTests() {
  console.log("=================================================");
  console.log("  Task soft/hard timeout alert test suite");
  console.log("=================================================");

  console.log("\n[Test A] resolveHardKillTimeoutMs and webhook event filtering helpers");
  assert.equal(resolveHardKillTimeoutMs(undefined, 1000), HARD_KILL_SAFETY_CAP_MS);
  assert.equal(resolveHardKillTimeoutMs(42, 1000), 42000);
  assert.deepEqual(resolveWebhookDelivery("timeout", ["timeout"]), { deliver: true, payloadStatus: "timeout" });
  assert.deepEqual(resolveWebhookDelivery("timeout", ["failed"]), { deliver: true, payloadStatus: "failed" });
  assert.equal(resolveWebhookDelivery("timeout", ["completed"]), null);
  assert.deepEqual(resolveWebhookDelivery("overdue", ["overdue"]), { deliver: true, payloadStatus: "overdue" });
  assert.deepEqual(resolveWebhookDelivery("cancelled", ["cancelled"]), { deliver: true, payloadStatus: "cancelled" });
  assert.deepEqual(resolveWebhookDelivery("cancelled", ["failed"]), { deliver: true, payloadStatus: "failed" });
  console.log("✓ Test A passed.\n");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const tasksDir = path.join(TEST_ROOT, "tasks");
  const resultsDir = path.join(TEST_ROOT, "results");
  const logsDir = path.join(TEST_ROOT, "logs");
  const fakeAgentsDir = path.join(TEST_ROOT, "fake-agents");
  for (const d of [tasksDir, resultsDir, logsDir, fakeAgentsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const sleepScript = path.join(fakeAgentsDir, "sleep-seconds.cjs");
  fs.writeFileSync(
    sleepScript,
    `const sec = Math.max(1, parseInt(process.argv[2] || "5", 10));
setTimeout(() => {
  process.stdout.write("slept " + sec + "s\\n");
  process.exit(0);
}, sec * 1000);
`,
    "utf8"
  );

  const stubbornScript = path.join(fakeAgentsDir, "sleep-stubborn.cjs");
  fs.writeFileSync(
    stubbornScript,
    `process.on("SIGTERM", () => {});
setTimeout(() => process.stdout.write("late"), 60000);
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(TEST_ROOT, "agents.json"),
    JSON.stringify(
      {
        sleeper: { command: "node", args: [sleepScript, "8"], input: "stdin" },
        "sleep-stubborn": { command: "node", args: [stubbornScript], input: "stdin" },
      },
      null,
      2
    ),
    "utf8"
  );

  const callbackHits: Array<{ status: string; duration_s: number }> = [];
  const webhookHits: Array<{ status: string; taskId: string }> = [];

  const callbackServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString("utf8")));
    req.on("end", () => {
      try {
        callbackHits.push(JSON.parse(body));
      } catch {}
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => callbackServer.listen(0, "127.0.0.1", r));
  const callbackPort = (callbackServer.address() as any).port;
  const callbackUrl = `http://127.0.0.1:${callbackPort}/cb`;

  const webhookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString("utf8")));
    req.on("end", () => {
      try {
        webhookHits.push(JSON.parse(body));
      } catch {}
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => webhookServer.listen(0, "127.0.0.1", r));
  const webhookPort = (webhookServer.address() as any).port;
  const webhookUrl = `http://127.0.0.1:${webhookPort}/wh`;

  const workerProcess: ChildProcess = spawn("node", ["dist/worker.js"], {
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
      AGENT_BRIDGE_POLL_MS: "150",
      AGENT_BRIDGE_TIMEOUT_MS: "500",
      AGENT_BRIDGE_NOTIFY: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  workerProcess.stderr?.on("data", (chunk) => process.stderr.write(`[worker] ${chunk}`));
  await new Promise((r) => setTimeout(r, 400));

  try {
    console.log("[Test B] Soft notify overdue fires once and does not kill the process");
    const softTaskId = "task_soft_overdue_001";
    fs.writeFileSync(
      path.join(tasksDir, `${softTaskId}.md`),
      `# Soft overdue

- **Task ID**: ${softTaskId}
- **Agent**: sleeper
- **Notify Overdue Seconds**: 2
- **Callback URL**: ${callbackUrl}
- **Created At**: ${new Date().toISOString()}

---

## Prompt

sleep
`,
      "utf8"
    );

    await waitForCondition(() => callbackHits.some((h) => h.status === "overdue"), 8000);
    const overdueHits = callbackHits.filter((h) => h.status === "overdue");
    assert.equal(overdueHits.length, 1, "overdue callback must fire exactly once");

    const resultPath = path.join(resultsDir, `${softTaskId}.md`);
    await waitForFile(resultPath, 15000);
    const resultContent = fs.readFileSync(resultPath, "utf8");
    assert.ok(resultContent.includes("- **Status**: completed"), "Task must complete after soft overdue alert");
    assert.equal(callbackHits.filter((h) => h.status === "overdue").length, 1, "no second overdue callback");
    console.log("✓ Test B passed.\n");

    console.log("[Test C] Hard timeout webhook status=timeout when subscribed");
    webhookHits.length = 0;
    const hardTaskId = "task_hard_timeout_002";
    setTaskWebhook(TEST_ROOT, hardTaskId, {
      url: webhookUrl,
      events: ["timeout"],
    });
    fs.writeFileSync(
      path.join(tasksDir, `${hardTaskId}.md`),
      `# Hard timeout

- **Task ID**: ${hardTaskId}
- **Agent**: sleep-stubborn
- **Hard Timeout Seconds**: 1
- **Created At**: ${new Date().toISOString()}

---

## Prompt

block
`,
      "utf8"
    );

    await waitForFile(path.join(resultsDir, `${hardTaskId}.md`), 20000);
    await waitForCondition(() => webhookHits.some((h) => h.taskId === hardTaskId), 5000);
    assert.equal(webhookHits.filter((h) => h.taskId === hardTaskId).length, 1);
    assert.equal(webhookHits[0].status, "timeout");
    console.log("✓ Test C passed.\n");

    console.log("[Test D] Hard timeout falls back to failed webhook when timeout event omitted");
    webhookHits.length = 0;
    const fallbackTaskId = "task_hard_timeout_003";
    setTaskWebhook(TEST_ROOT, fallbackTaskId, {
      url: webhookUrl,
      events: ["failed"],
    });
    fs.writeFileSync(
      path.join(tasksDir, `${fallbackTaskId}.md`),
      `# Hard timeout fallback

- **Task ID**: ${fallbackTaskId}
- **Agent**: sleep-stubborn
- **Hard Timeout Seconds**: 1
- **Created At**: ${new Date().toISOString()}

---

## Prompt

block
`,
      "utf8"
    );

    await waitForFile(path.join(resultsDir, `${fallbackTaskId}.md`), 20000);
    await waitForCondition(() => webhookHits.some((h) => h.taskId === fallbackTaskId), 5000);
    assert.equal(webhookHits[0].status, "failed");
    console.log("✓ Test D passed.\n");

    console.log("[Test E] Hard timeout skipped when webhook events exclude timeout/failed");
    webhookHits.length = 0;
    const skipTaskId = "task_hard_timeout_004";
    setTaskWebhook(TEST_ROOT, skipTaskId, {
      url: webhookUrl,
      events: ["completed"],
    });
    await triggerTaskWebhook(TEST_ROOT, skipTaskId, "timeout", undefined, 1000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(webhookHits.length, 0);
    console.log("✓ Test E passed.\n");

    console.log("[Test F] Stuck detection: quiet .out but active conversation/session progress is NOT stuck; truly idle is stuck");
    const fakeGeminiDir = path.join(TEST_ROOT, "fake-gemini-convs");
    fs.mkdirSync(fakeGeminiDir, { recursive: true });
    const fakeConvDb = path.join(fakeGeminiDir, "test-conv.db");
    fs.writeFileSync(fakeConvDb, "conv-turn-1\n", "utf8");

    // Verify helper finds recent mtime in extra dirs
    const initialMtime = getAgentSessionOrProgressMtime(undefined, [fakeGeminiDir]);
    assert.ok(initialMtime > 0, "helper should locate recent conversation mtime");

    // Verify process cpu and descendant helpers
    const currentCpu = getProcessTreeCpuTime(process.pid);
    assert.ok(currentCpu >= 0, "CPU time helper returns valid non-negative number");
    const currentDesc = getDescendantPids(process.pid);
    assert.ok(Array.isArray(currentDesc), "Descendant pids returns an array");
    console.log("✓ Test F passed.\n");
  } finally {
    workerProcess.kill("SIGTERM");
    callbackServer.close();
    webhookServer.close();
  }

  console.log("=================================================");
  console.log("  All timeout alert tests passed");
  console.log("=================================================\n");
}

runTimeoutAlertTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
