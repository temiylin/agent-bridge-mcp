import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-device-info-test";

async function runDeviceInfoTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp device_info Test Suite");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}\n`);

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const logsDir = path.join(TEST_ROOT, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  // Minimal agents.json for server init
  fs.writeFileSync(
    path.join(TEST_ROOT, "agents.json"),
    JSON.stringify({ codex: { command: "codex", args: ["exec"], input: "arg" } }, null, 2),
    "utf8"
  );

  // Inject canary secret environment variables to verify they are never leaked
  const SECRET_ENV_KEY = "SECRET_CANARY_ENV_KEY_12345";
  const SECRET_ENV_VAL = "SECRET_CANARY_ENV_VAL_67890";
  process.env[SECRET_ENV_KEY] = SECRET_ENV_VAL;
  process.env["MY_PRIVATE_TEST_TOKEN"] = "token-abcdef-secret-9999";

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
  const client = new Client({ name: "device-info-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    console.log("-------------------------------------------------");
    console.log("[Test 1] Tool invocation & field whitelist");
    console.log("-------------------------------------------------");
    const res = await client.callTool({ name: "device_info" });
    assert.equal(res.isError, undefined, "device_info should execute successfully");
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text || "";
    console.log("device_info response preview:\n" + text + "\n");
    const data = JSON.parse(text);

    // 1. Top-level whitelist
    const expectedTopKeys = [
      "hostname",
      "os",
      "cpu",
      "memory",
      "disk",
      "runningProcessCount",
      "network",
      "runtimes",
    ];
    assert.deepEqual(
      Object.keys(data).sort(),
      expectedTopKeys.sort(),
      "Top-level keys must strictly match whitelist"
    );

    // 2. OS whitelist
    assert.deepEqual(
      Object.keys(data.os).sort(),
      ["platform", "release", "version"].sort(),
      "OS keys must strictly match whitelist"
    );
    assert.ok(typeof data.os.platform === "string");
    assert.ok(typeof data.os.release === "string");
    assert.ok(typeof data.os.version === "string");

    // 3. CPU whitelist
    assert.deepEqual(
      Object.keys(data.cpu).sort(),
      ["architecture", "cores", "model"].sort(),
      "CPU keys must strictly match whitelist"
    );
    assert.ok(typeof data.cpu.architecture === "string");
    assert.ok(typeof data.cpu.model === "string");
    assert.ok(typeof data.cpu.cores === "number" && data.cpu.cores > 0);

    // 4. Memory whitelist
    assert.deepEqual(
      Object.keys(data.memory).sort(),
      ["freeBytes", "totalBytes", "usedPercentage"].sort(),
      "Memory keys must strictly match whitelist"
    );
    assert.ok(typeof data.memory.totalBytes === "number" && data.memory.totalBytes > 0);
    assert.ok(typeof data.memory.freeBytes === "number" && data.memory.freeBytes >= 0);
    assert.ok(typeof data.memory.usedPercentage === "number");

    // 5. Disk whitelist
    assert.deepEqual(
      Object.keys(data.disk).sort(),
      ["availableBytes", "freeBytes", "freePercentage", "totalBytes"].sort(),
      "Disk keys must strictly match whitelist"
    );
    assert.ok(typeof data.disk.totalBytes === "number" && data.disk.totalBytes > 0);
    assert.ok(typeof data.disk.freeBytes === "number" && data.disk.freeBytes >= 0);

    // 6. Running process count (count only)
    assert.ok(typeof data.runningProcessCount === "number", "Process count must be a number");
    assert.ok(data.runningProcessCount > 0, "Running process count must be > 0");

    // 7. Network interfaces whitelist (no mac addresses or sensitive credentials)
    for (const [ifaceName, addrs] of Object.entries(data.network as Record<string, any[]>)) {
      assert.ok(typeof ifaceName === "string");
      assert.ok(Array.isArray(addrs));
      for (const addr of addrs) {
        assert.deepEqual(
          Object.keys(addr).sort(),
          ["address", "family", "internal"].sort(),
          `Network interface ${ifaceName} item keys must strictly match whitelist`
        );
      }
    }

    // 8. Runtimes whitelist
    assert.deepEqual(
      Object.keys(data.runtimes).sort(),
      ["git", "node"].sort(),
      "Runtimes keys must strictly match whitelist"
    );
    assert.ok(typeof data.runtimes.node === "string" && data.runtimes.node.startsWith("v"));
    assert.ok(typeof data.runtimes.git === "string" && data.runtimes.git.length > 0);

    console.log("✓ Test 1 passed: All returned fields strictly match whitelist.\n");

    // -------------------------------------------------
    // [Test 2] Privacy & Leakage Assertions
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 2] Privacy & anti-leakage assertions");
    console.log("-------------------------------------------------");

    // Must NOT leak environment variables
    assert.ok(!text.includes(SECRET_ENV_KEY), "Must strictly NOT contain secret env key");
    assert.ok(!text.includes(SECRET_ENV_VAL), "Must strictly NOT contain secret env value");
    assert.ok(!text.includes("MY_PRIVATE_TEST_TOKEN"), "Must strictly NOT contain test token key");
    assert.ok(!text.includes("token-abcdef-secret-9999"), "Must strictly NOT contain test token value");

    // Must NOT leak user home directory path
    const homedir = os.homedir();
    assert.ok(!text.includes(homedir), `Must strictly NOT contain user homedir path ("${homedir}")`);

    // Must NOT leak process command line arguments
    assert.ok(!text.includes("--secret"), "Must NOT contain process arguments");
    assert.ok(!text.includes("scripts/run-env"), "Must NOT contain process invocation scripts");

    // Must NOT leak MAC addresses
    const macRegex = /[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}/;
    assert.ok(!macRegex.test(text), "Must NOT contain MAC addresses");

    console.log("✓ Test 2 passed: Environment variables, process args, user homedir, and MAC addresses strictly absent.\n");

    // -------------------------------------------------
    // [Test 3] Audit log check
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 3] Audit log verification");
    console.log("-------------------------------------------------");
    const auditPath = path.join(TEST_ROOT, "logs", "audit.log");
    assert.ok(fs.existsSync(auditPath), "audit.log must exist");
    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    assert.ok(auditLines.length >= 1, "Audit log must contain record");
    const lastRecord = JSON.parse(auditLines[auditLines.length - 1]);
    assert.equal(lastRecord.tool, "device_info", "Audit record must log tool name: 'device_info'");
    assert.ok(lastRecord.ts, "Audit record must log timestamp");
    assert.equal(lastRecord.output, undefined, "Audit record must NOT contain output");

    console.log("✓ Test 3 passed: Audit log verified (tool name and timestamp only).\n");

  } finally {
    delete process.env[SECRET_ENV_KEY];
    delete process.env["MY_PRIVATE_TEST_TOKEN"];
    await client.close();
  }

  console.log("=================================================");
  console.log("  All device_info tests passed successfully!     ");
  console.log("=================================================");
}

runDeviceInfoTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
