import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-worker-alive-test";

async function runWorkerAliveTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp worker_alive_summary Test Suite");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}\n`);

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const logsDir = path.join(TEST_ROOT, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  // 1. Start a dummy mock worker child process (strictly managed inside this test)
  console.log("[Setup] Spawning dummy mock worker child process...");
  const dummyWorker = spawn("node", ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  assert.ok(dummyWorker.pid, "Dummy worker must have a PID");
  console.log(`[Setup] Dummy worker running with PID: ${dummyWorker.pid}`);

  const pidPath = path.join(logsDir, "worker.pid");
  const workerLogPath = path.join(logsDir, "worker.log");

  // Write mock PID and mock worker.log with ISO timestamp
  fs.writeFileSync(pidPath, String(dummyWorker.pid), "utf8");
  const MOCK_TIMESTAMP = "2026-10-28T09:15:30.123Z";
  fs.writeFileSync(
    workerLogPath,
    `[2026-10-28T09:00:00.000Z] [INFO] Starting up\n[${MOCK_TIMESTAMP}] [INFO] Processing task: taskId=mock_001, agent="echo"\n`,
    "utf8"
  );

  // Setup minimal agents.json for server initialization
  fs.writeFileSync(
    path.join(TEST_ROOT, "agents.json"),
    JSON.stringify({ codex: { command: "codex", args: ["exec"], input: "arg" } }, null, 2),
    "utf8"
  );

  // 2. Connect client to dist/index.js
  const serverPath = path.resolve("dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
    },
  });
  const client = new Client({ name: "worker-alive-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // -------------------------------------------------
    // [Test 1] Worker is running
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 1] Worker alive probe while running");
    console.log("-------------------------------------------------");
    const res1 = await client.callTool({ name: "worker_alive_summary" });
    assert.equal(res1.isError, undefined, "Tool call should succeed");
    const text1 = (res1.content as Array<{ type: string; text: string }>)[0]?.text || "";
    console.log("Tool response while running:\n" + text1);
    const data1 = JSON.parse(text1);

    assert.equal(data1.running, true, "Worker should be reported as running");
    assert.equal(data1.pid, dummyWorker.pid, "Reported PID should match dummy worker");
    assert.equal(data1.lastActivity, MOCK_TIMESTAMP, "lastActivity must match last log timestamp");
    console.log("✓ Test 1 passed: Running worker detected via signal 0 and last activity parsed.\n");

    // -------------------------------------------------
    // [Test 2] Worker terminated (stale PID in file)
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 2] Worker terminated (stale PID detection)");
    console.log("-------------------------------------------------");
    dummyWorker.kill("SIGTERM");
    await new Promise((resolve) => dummyWorker.on("exit", resolve));
    console.log("[Test 2] Dummy worker process terminated.");

    const res2 = await client.callTool({ name: "worker_alive_summary" });
    const text2 = (res2.content as Array<{ type: string; text: string }>)[0]?.text || "";
    console.log("Tool response after termination:\n" + text2);
    const data2 = JSON.parse(text2);

    assert.equal(data2.running, false, "Worker should be reported as NOT running");
    assert.equal(data2.pid, dummyWorker.pid, "Stale PID should still be reported");
    assert.equal(data2.lastActivity, MOCK_TIMESTAMP, "lastActivity should still be reported");
    console.log("✓ Test 2 passed: Dead worker detected via signal 0 returning ESRCH.\n");

    // -------------------------------------------------
    // [Test 3] No worker.pid file present
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 3] Missing worker.pid file");
    console.log("-------------------------------------------------");
    fs.unlinkSync(pidPath);
    const res3 = await client.callTool({ name: "worker_alive_summary" });
    const text3 = (res3.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const data3 = JSON.parse(text3);

    assert.equal(data3.running, false, "Worker should be reported as NOT running");
    assert.equal(data3.pid, undefined, "PID should be undefined when file is missing");
    assert.equal(data3.lastActivity, MOCK_TIMESTAMP, "lastActivity still read from log");
    console.log("✓ Test 3 passed: Missing pid file handled gracefully.\n");

    // -------------------------------------------------
    // [Test 4] Invalid / corrupt worker.pid content
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 4] Corrupt worker.pid content");
    console.log("-------------------------------------------------");
    fs.writeFileSync(pidPath, "not-a-valid-pid\n", "utf8");
    const res4 = await client.callTool({ name: "worker_alive_summary" });
    const text4 = (res4.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const data4 = JSON.parse(text4);

    assert.equal(data4.running, false, "Worker should be reported as NOT running");
    assert.equal(data4.pid, undefined, "Invalid PID should not be parsed");
    console.log("✓ Test 4 passed: Corrupt pid file ignored safely.\n");

    // -------------------------------------------------
    // [Test 5] Audit log check
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 5] Audit log verification");
    console.log("-------------------------------------------------");
    const auditPath = path.join(TEST_ROOT, "logs", "audit.log");
    assert.ok(fs.existsSync(auditPath), "audit.log must exist");
    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    assert.ok(auditLines.length >= 4, "Should have recorded audit lines");
    for (const line of auditLines) {
      const record = JSON.parse(line);
      assert.equal(record.tool, "worker_alive_summary", "Audit entry must record tool name");
      assert.ok(record.ts, "Audit entry must record timestamp");
      assert.equal(record.output, undefined, "Audit entry must NOT contain output");
    }
    console.log("✓ Test 5 passed: Audit log records only tool name and timestamp without output.\n");

  } finally {
    // Ensure dummy worker is completely killed
    try {
      dummyWorker.kill("SIGKILL");
    } catch {}
    await client.close();
  }

  console.log("=================================================");
  console.log("  All worker_alive_summary tests passed!         ");
  console.log("=================================================");
}

runWorkerAliveTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
