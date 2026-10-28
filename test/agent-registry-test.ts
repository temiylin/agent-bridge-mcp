import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-agent-registry-test";

async function runAgentRegistryTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp agent_registry_summary Test");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}\n`);

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const logsDir = path.join(TEST_ROOT, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const agentsJsonPath = path.join(TEST_ROOT, "agents.json");

  const SECRET_CMD_1 = "/usr/local/bin/SECRET_COMMAND_PATH_ABC";
  const SECRET_TOKEN_1 = "SECRET_TOKEN_XYZ_123";
  const SECRET_CMD_2 = "/opt/private/SECRET_REVIEWER_EXE";
  const SECRET_KEY_2 = "SECRET_KEY_VALUE_456";

  const secretAgentsConfig = {
    codex: {
      command: SECRET_CMD_1,
      args: ["exec", "--token", SECRET_TOKEN_1],
      input: "stdin",
    },
    reviewer: {
      command: SECRET_CMD_2,
      args: ["--key", SECRET_KEY_2],
      input: "arg",
    },
  };

  fs.writeFileSync(agentsJsonPath, JSON.stringify(secretAgentsConfig, null, 2), "utf8");

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
  const client = new Client({ name: "agent-registry-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // -------------------------------------------------
    // [Test 1] Field whitelist & sensitive values blocked
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 1] Field whitelist & sensitive values blocked");
    console.log("-------------------------------------------------");
    const res1 = await client.callTool({ name: "agent_registry_summary" });
    assert.equal(res1.isError, undefined, "Tool call should succeed");
    const text1 = (res1.content as Array<{ type: string; text: string }>)[0]?.text || "";
    console.log("agent_registry_summary output:\n" + text1 + "\n");
    const list1: any[] = JSON.parse(text1);

    assert.equal(list1.length, 2, "Should return 2 agents");

    // Check exact items
    assert.deepEqual(list1, [
      { name: "codex", enabled: true },
      { name: "reviewer", enabled: true },
    ]);

    // Field whitelist check
    for (const item of list1) {
      const keys = Object.keys(item);
      assert.deepEqual(keys.sort(), ["enabled", "name"].sort(), "Item must strictly only contain name and enabled");
      assert.equal(item.enabled, true, "enabled must be true");
    }

    // Sensitive values must NOT appear in output
    assert.ok(!text1.includes(SECRET_CMD_1), "Must not leak command path 1");
    assert.ok(!text1.includes(SECRET_TOKEN_1), "Must not leak secret token 1");
    assert.ok(!text1.includes(SECRET_CMD_2), "Must not leak command path 2");
    assert.ok(!text1.includes(SECRET_KEY_2), "Must not leak secret key 2");
    assert.ok(!text1.includes('"command"'), 'Must not contain "command" property');
    assert.ok(!text1.includes('"args"'), 'Must not contain "args" property');
    assert.ok(!text1.includes('"input"'), 'Must not contain "input" property');
    console.log("✓ Test 1 passed: Whitelist enforced, sensitive command/args completely stripped.\n");

    // -------------------------------------------------
    // [Test 2] Missing agents.json -> returns []
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 2] Missing agents.json handled gracefully");
    console.log("-------------------------------------------------");
    fs.unlinkSync(agentsJsonPath);
    const res2 = await client.callTool({ name: "agent_registry_summary" });
    const text2 = (res2.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const list2: any[] = JSON.parse(text2);
    assert.deepEqual(list2, [], "Missing agents.json must return []");
    console.log("✓ Test 2 passed: Missing agents.json returns empty list.\n");

    // -------------------------------------------------
    // [Test 3] Corrupt agents.json -> returns []
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 3] Corrupt agents.json handled safely");
    console.log("-------------------------------------------------");
    fs.writeFileSync(agentsJsonPath, "{ invalid json content ...", "utf8");
    const res3 = await client.callTool({ name: "agent_registry_summary" });
    const text3 = (res3.content as Array<{ type: string; text: string }>)[0]?.text || "";
    const list3: any[] = JSON.parse(text3);
    assert.deepEqual(list3, [], "Corrupt agents.json must return []");
    console.log("✓ Test 3 passed: Corrupt agents.json returns empty list without error.\n");

    // -------------------------------------------------
    // [Test 4] Audit log check
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 4] Audit log verification");
    console.log("-------------------------------------------------");
    const auditPath = path.join(TEST_ROOT, "logs", "audit.log");
    assert.ok(fs.existsSync(auditPath), "audit.log must exist");
    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    assert.ok(auditLines.length >= 3, "Audit entries must be recorded");
    for (const line of auditLines) {
      const entry = JSON.parse(line);
      assert.equal(entry.tool, "agent_registry_summary");
      assert.ok(entry.ts);
      assert.equal(entry.output, undefined);
    }
    console.log("✓ Test 4 passed: Audit log verified (tool name and timestamp only).\n");

  } finally {
    await client.close();
  }

  console.log("=================================================");
  console.log("  All agent_registry_summary tests passed!       ");
  console.log("=================================================");
}

runAgentRegistryTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
