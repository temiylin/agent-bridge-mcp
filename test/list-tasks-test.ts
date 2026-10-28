import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-list-tasks-test";

async function runListTasksTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp list_tasks_summary Test Suite");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}\n`);

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const statusDir = path.join(TEST_ROOT, "status");
  fs.mkdirSync(statusDir, { recursive: true });
  const logsDir = path.join(TEST_ROOT, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  // Minimal agents.json for server init
  fs.writeFileSync(
    path.join(TEST_ROOT, "agents.json"),
    JSON.stringify({ codex: { command: "codex", args: ["exec"], input: "arg" } }, null, 2),
    "utf8"
  );

  const SECRET_PROMPT_MARKER = "SUPER_SECRET_PROMPT_LEAK_TEST_998877";
  const SECRET_RESULT_MARKER = "SUPER_SECRET_RESULT_LEAK_TEST_665544";

  // Generate 55 mock status files with timestamps and injected secret fields
  console.log("[Setup] Writing 55 mock status files with sensitive injected fields...");
  for (let i = 1; i <= 55; i++) {
    const pad = String(i).padStart(3, "0");
    const taskId = `task_mock_${pad}`;
    const min = String(Math.floor(i / 60)).padStart(2, "0");
    const sec = String(i % 60).padStart(2, "0");
    const startedAt = `2026-10-28T09:${min}:${sec}.000Z`;
    const finishedAt = `2026-10-28T09:${min}:${sec}.500Z`;

    const statusData = {
      taskId,
      state: i % 2 === 0 ? "completed" : "failed",
      agent: "test-agent",
      startedAt,
      finishedAt,
      exitCode: i % 2 === 0 ? 0 : 1,
      // INJECTED SENSITIVE FIELDS - MUST BE FILTERED OUT
      prompt: `${SECRET_PROMPT_MARKER}_${i}`,
      results: `${SECRET_RESULT_MARKER}_${i}`,
      logs: `Some stdout log content ${i}`,
      internalInfo: { secret: true },
    };

    fs.writeFileSync(path.join(statusDir, `${taskId}.json`), JSON.stringify(statusData, null, 2), "utf8");
  }

  // Connect client to dist/index.js
  const serverPath = path.resolve("dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
    },
  });
  const client = new Client({ name: "list-tasks-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // -------------------------------------------------
    // [Test 1] Default limit (20), descending sort, field whitelist & secret filtering
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 1] Default limit (20), descending order & field whitelist");
    console.log("-------------------------------------------------");
    const res1 = await client.callTool({ name: "list_tasks_summary" });
    assert.equal(res1.isError, undefined, "Tool call should succeed");
    const text1 = (res1.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const list1: any[] = JSON.parse(text1);

    assert.equal(list1.length, 20, "Default limit must return exactly 20 items");

    // Verify descending sort
    for (let i = 0; i < list1.length - 1; i++) {
      const timeCurrent = new Date(list1[i].startedAt).getTime();
      const timeNext = new Date(list1[i + 1].startedAt).getTime();
      assert.ok(timeCurrent >= timeNext, "Items must be sorted by startedAt descending");
    }

    // Verify allowed fields whitelist and strict absence of sensitive fields
    const allowedKeys = new Set(["taskId", "state", "agent", "startedAt", "finishedAt", "exitCode"]);
    for (const item of list1) {
      for (const k of Object.keys(item)) {
        assert.ok(allowedKeys.has(k), `Key "${k}" is not in whitelist!`);
      }
    }

    // Assert secret strings are strictly not leaked
    assert.ok(!text1.includes(SECRET_PROMPT_MARKER), "Output must strictly NOT contain prompt text");
    assert.ok(!text1.includes(SECRET_RESULT_MARKER), "Output must strictly NOT contain result text");
    console.log("✓ Test 1 passed: Default 20 items returned, sorted descending, field whitelist enforced, secrets blocked.\n");

    // -------------------------------------------------
    // [Test 2] Custom limit: 5
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 2] Custom limit = 5");
    console.log("-------------------------------------------------");
    const res2 = await client.callTool({ name: "list_tasks_summary", arguments: { limit: 5 } });
    const text2 = (res2.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const list2: any[] = JSON.parse(text2);
    assert.equal(list2.length, 5, "Should return exactly 5 items when limit=5");
    console.log("✓ Test 2 passed: Custom limit=5 respected.\n");

    // -------------------------------------------------
    // [Test 3] Upper bound clamp: limit = 100 clamped to 50
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 3] Upper bound clamp (limit=100 clamped to 50)");
    console.log("-------------------------------------------------");
    const res3 = await client.callTool({ name: "list_tasks_summary", arguments: { limit: 100 } });
    const text3 = (res3.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const list3: any[] = JSON.parse(text3);
    assert.equal(list3.length, 50, "Limit > 50 must be clamped to 50");
    console.log("✓ Test 3 passed: Upper limit 50 clamp enforced.\n");

    // -------------------------------------------------
    // [Test 4] Lower bound clamp: limit = -10 clamped to 1
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 4] Lower bound clamp (limit=-10 clamped to 1)");
    console.log("-------------------------------------------------");
    const res4 = await client.callTool({ name: "list_tasks_summary", arguments: { limit: -10 } });
    const text4 = (res4.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const list4: any[] = JSON.parse(text4);
    assert.equal(list4.length, 1, "Limit < 1 must be clamped to 1");
    console.log("✓ Test 4 passed: Lower limit 1 clamp enforced.\n");

    // -------------------------------------------------
    // [Test 5] Empty status directory -> returns []
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 5] Empty status directory returns []");
    console.log("-------------------------------------------------");
    // Clear status dir
    for (const f of fs.readdirSync(statusDir)) {
      fs.unlinkSync(path.join(statusDir, f));
    }
    const res5 = await client.callTool({ name: "list_tasks_summary" });
    const text5 = (res5.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const list5: any[] = JSON.parse(text5);
    assert.deepEqual(list5, [], "Empty directory must return empty array []");
    console.log("✓ Test 5 passed: Empty status directory handled gracefully.\n");

    // -------------------------------------------------
    // [Test 6] Audit log verification
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 6] Audit log verification");
    console.log("-------------------------------------------------");
    const auditPath = path.join(TEST_ROOT, "logs", "audit.log");
    assert.ok(fs.existsSync(auditPath), "audit.log must exist");
    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    assert.ok(auditLines.length >= 5, "Audit entries must be recorded for each invocation");
    for (const line of auditLines) {
      const entry = JSON.parse(line);
      assert.equal(entry.tool, "list_tasks_summary");
      assert.ok(entry.ts);
      assert.equal(entry.output, undefined);
    }
    console.log("✓ Test 6 passed: Audit log verified (only tool name and timestamp).\n");

  } finally {
    await client.close();
  }

  console.log("=================================================");
  console.log("  All list_tasks_summary tests passed!           ");
  console.log("=================================================");
}

runListTasksTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
