import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-worker-test";

async function waitForFile(filePath: string, timeoutMs: number = 8000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.trim().length > 0) return content;
      } catch {
        // file might be in the middle of being renamed
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for file "${filePath}" after ${timeoutMs}ms`);
}

async function runWorkerTests() {
  console.log("=================================================");
  console.log("  agent-bridge-worker Comprehensive Test Suite");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}\n`);

  // Clean setup
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const tasksDir = path.join(TEST_ROOT, "tasks");
  const resultsDir = path.join(TEST_ROOT, "results");
  const logsDir = path.join(TEST_ROOT, "logs");
  const fakeAgentsDir = path.join(TEST_ROOT, "fake-agents");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(fakeAgentsDir, { recursive: true });

  // 1. Create fake agents
  const echoStdinScript = path.join(fakeAgentsDir, "echo-stdin.cjs");
  fs.writeFileSync(
    echoStdinScript,
    `let data = "";
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  process.stdout.write("ECHO_STDIN: " + data);
});
`,
    "utf8"
  );

  const echoArgScript = path.join(fakeAgentsDir, "echo-arg.cjs");
  fs.writeFileSync(
    echoArgScript,
    `const args = process.argv.slice(2);
process.stdout.write("ECHO_ARG: " + args.join(" "));
`,
    "utf8"
  );

  const failScript = path.join(fakeAgentsDir, "fail.cjs");
  fs.writeFileSync(
    failScript,
    `process.stderr.write("Simulated fatal execution failure in fake agent.");
process.exit(2);
`,
    "utf8"
  );

  const sleepScript = path.join(fakeAgentsDir, "sleep.cjs");
  fs.writeFileSync(
    sleepScript,
    `setTimeout(() => {
  process.stdout.write("Woke up after sleep");
}, 10000);
`,
    "utf8"
  );

  // 2. Create agents.json in TEST_ROOT
  const agentsJsonPath = path.join(TEST_ROOT, "agents.json");
  const registryConfig = {
    "echo-agent": {
      command: "node",
      args: [echoStdinScript],
      input: "stdin",
    },
    "echo-arg-agent": {
      command: "node",
      args: [echoArgScript],
      input: "arg",
    },
    "fail-agent": {
      command: "node",
      args: [failScript],
      input: "stdin",
    },
    "sleep-agent": {
      command: "node",
      args: [sleepScript],
      input: "stdin",
    },
  };
  fs.writeFileSync(agentsJsonPath, JSON.stringify(registryConfig, null, 2), "utf8");

  // 3. Start worker process
  console.log("[Worker] Spawning worker process...");
  const workerProcess = spawn("node", ["dist/worker.js"], {
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
      AGENT_BRIDGE_POLL_MS: "200",
      AGENT_BRIDGE_TIMEOUT_MS: "1200",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  workerProcess.stderr?.on("data", (chunk) => {
    // Pipe worker logs to console for inspection
    process.stderr.write(`[worker-stderr] ${chunk.toString("utf8")}`);
  });

  // Give worker a moment to initialize
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(workerProcess.exitCode, null, "Worker process should be running");
  console.log("[Worker] Worker process running successfully (PID: " + workerProcess.pid + ")\n");

  try {
    // -------------------------------------------------------------------------
    // Test 1: Legitimate task executed, results/<task_id>.md generated with echo
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 1] Legitimate task execution with echo");
    console.log("-------------------------------------------------");
    const taskId1 = "task_test_001";
    const taskFile1 = path.join(tasksDir, `${taskId1}.md`);
    fs.writeFileSync(
      taskFile1,
      `# Test Case 1 Valid Task

- **Task ID**: ${taskId1}
- **Agent**: echo-agent
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Hello from agent bridge test prompt!
`,
      "utf8"
    );

    const resultPath1 = path.join(resultsDir, `${taskId1}.md`);
    const content1 = await waitForFile(resultPath1);
    console.log("Result file generated for Test 1:\n" + content1);

    assert.ok(content1.includes("- **Status**: completed"), "Status must be completed");
    assert.ok(content1.includes("- **Agent**: echo-agent"), "Agent must be echo-agent");
    assert.ok(content1.includes("- **Exit Code**: 0"), "Exit Code must be 0");
    assert.ok(content1.includes("ECHO_STDIN: Hello from agent bridge test prompt!"), "Stdout must contain echoed prompt");
    console.log("✓ Test 1 passed: Legitimate task executed successfully with echoed output.\n");

    // -------------------------------------------------------------------------
    // Test 2: Same task is not executed twice
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 2] Verify same task is not executed twice");
    console.log("-------------------------------------------------");
    const processedJsonPath = path.join(logsDir, "processed.json");
    assert.ok(fs.existsSync(processedJsonPath), "processed.json must exist");
    const processedMap = JSON.parse(fs.readFileSync(processedJsonPath, "utf8"));
    assert.ok(taskId1 in processedMap, "taskId1 must be recorded in processed.json");

    const stat1Before = fs.statSync(resultPath1);
    // Wait for at least 2 polling intervals (600ms)
    await new Promise((r) => setTimeout(r, 600));
    const stat1After = fs.statSync(resultPath1);
    assert.equal(stat1Before.mtimeMs, stat1After.mtimeMs, "Result file must not be modified again");
    console.log("✓ Test 2 passed: Processed task was not re-executed.\n");

    // -------------------------------------------------------------------------
    // Test 3: Fake agent returns non-zero exit code, Status is failed, worker continues
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 3] Failing agent execution (exit code != 0)");
    console.log("-------------------------------------------------");
    const taskId3 = "task_test_003_fail";
    const taskFile3 = path.join(tasksDir, `${taskId3}.md`);
    fs.writeFileSync(
      taskFile3,
      `# Test Case 3 Failing Task

- **Task ID**: ${taskId3}
- **Agent**: fail-agent
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Trigger failure
`,
      "utf8"
    );

    const resultPath3 = path.join(resultsDir, `${taskId3}.md`);
    const content3 = await waitForFile(resultPath3);
    console.log("Result file generated for Test 3:\n" + content3);

    assert.ok(content3.includes("- **Status**: failed"), "Status must be failed");
    assert.ok(content3.includes("- **Exit Code**: 2"), "Exit Code must be 2");
    assert.ok(content3.includes("Simulated fatal execution failure"), "Error details must capture stderr");
    assert.equal(workerProcess.exitCode, null, "Worker process must continue running after task failure");
    console.log("✓ Test 3 passed: Failing task recorded as failed; worker remained running.\n");

    // -------------------------------------------------------------------------
    // Test 4: Sleep task times out, Status is failed (timeout)
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 4] Execution timeout handling");
    console.log("-------------------------------------------------");
    const taskId4 = "task_test_004_timeout";
    const taskFile4 = path.join(tasksDir, `${taskId4}.md`);
    fs.writeFileSync(
      taskFile4,
      `# Test Case 4 Sleep Task

- **Task ID**: ${taskId4}
- **Agent**: sleep-agent
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Sleep indefinitely
`,
      "utf8"
    );

    const resultPath4 = path.join(resultsDir, `${taskId4}.md`);
    const content4 = await waitForFile(resultPath4, 8000);
    console.log("Result file generated for Test 4:\n" + content4);

    assert.ok(content4.includes("- **Status**: failed (timeout)"), "Status must be failed (timeout)");
    assert.equal(workerProcess.exitCode, null, "Worker process must survive timeout kill");
    console.log("✓ Test 4 passed: Timed out task killed and marked as failed (timeout).\n");

    // -------------------------------------------------------------------------
    // Test 5: Invalid filename skipped, no result generated
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 5] Invalid filename handling");
    console.log("-------------------------------------------------");
    const invalidFileName = "invalid task with spaces.md";
    fs.writeFileSync(path.join(tasksDir, invalidFileName), "# Invalid\n- **Agent**: echo-agent\n", "utf8");

    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!fs.existsSync(path.join(resultsDir, invalidFileName)), "Invalid filename must not produce result file");
    console.log("✓ Test 5 passed: Invalid filename was skipped without generating result.\n");

    // -------------------------------------------------------------------------
    // Test 6: Agent field missing or unregistered, Status is failed, no command executed
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 6] Missing or unregistered agent in task file");
    console.log("-------------------------------------------------");
    // Subcase 6a: missing agent
    const taskId6a = "task_test_006a_no_agent";
    fs.writeFileSync(
      path.join(tasksDir, `${taskId6a}.md`),
      `# Missing Agent Task\n- **Task ID**: ${taskId6a}\n- **Agent**: \n---\n## Prompt\nNo agent\n`,
      "utf8"
    );
    const content6a = await waitForFile(path.join(resultsDir, `${taskId6a}.md`));
    assert.ok(content6a.includes("- **Status**: failed (agent not registered)"), "Must fail when agent field is empty");

    // Subcase 6b: unregistered agent
    const taskId6b = "task_test_006b_unregistered";
    fs.writeFileSync(
      path.join(tasksDir, `${taskId6b}.md`),
      `# Unregistered Agent Task\n- **Task ID**: ${taskId6b}\n- **Agent**: non-existent-agent\n---\n## Prompt\nTest\n`,
      "utf8"
    );
    const content6b = await waitForFile(path.join(resultsDir, `${taskId6b}.md`));
    assert.ok(content6b.includes("- **Status**: failed (agent not registered)"), "Must fail when agent is unregistered");
    console.log("✓ Test 6 passed: Tasks with missing/unregistered agent properly marked as failed.\n");

    // -------------------------------------------------------------------------
    // Test 7: Result goes through .tmp, no residual .tmp files
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 7] Verify atomic writing with no leftover .tmp files");
    console.log("-------------------------------------------------");
    const resultFiles = fs.readdirSync(resultsDir);
    const tmpFiles = resultFiles.filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, `Expected 0 .tmp files, found: ${tmpFiles.join(", ")}`);
    console.log("✓ Test 7 passed: No residual .tmp files in results directory.\n");

    // -------------------------------------------------------------------------
    // Test 8: send_task with unregistered agent returns isError: true and lists available names
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 8] MCP send_task validation with unregistered agent");
    console.log("-------------------------------------------------");
    const serverPath = path.resolve("dist/index.js");
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: {
        ...process.env,
        AGENT_BRIDGE_ROOT: TEST_ROOT,
      },
    });

    const mcpClient = new Client({ name: "worker-test-mcp-client", version: "1.0.0" }, { capabilities: {} });
    await mcpClient.connect(transport);

    const invalidAgentCall = await mcpClient.callTool({
      name: "send_task",
      arguments: {
        title: "Test Unregistered",
        prompt: "Check rejection",
        agent: "phantom-agent",
      },
    });

    console.log("send_task response for unregistered agent:", JSON.stringify(invalidAgentCall, null, 2));
    assert.equal(invalidAgentCall.isError, true, "send_task must return isError: true for unregistered agent");
    const errText = (invalidAgentCall.content as Array<{ type: string; text: string }>)[0].text;
    assert.ok(errText.includes('Agent "phantom-agent" is not registered in agents.json'), "Error must specify agent name");
    assert.ok(errText.includes("echo-agent"), "Error must list available agent names");

    await mcpClient.close();
    console.log("✓ Test 8 passed: send_task correctly rejected unregistered agent and listed available ones.\n");
  } finally {
    // Cleanly stop worker process
    console.log("[Cleanup] Terminating worker process...");
    workerProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 600));
    if (!workerProcess.killed) {
      workerProcess.kill("SIGKILL");
    }
  }

  console.log("=================================================");
  console.log("All 8 worker test assertions passed successfully!");
  console.log("=================================================");
}

runWorkerTests().catch((err) => {
  console.error("Worker test runner failed:", err);
  process.exit(1);
});
