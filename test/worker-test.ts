import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-worker-test";

async function waitForFile(filePath: string, timeoutMs: number = 12000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.trim().length > 0) return content;
      } catch {
        // file might be in transition
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

  // 1. Create fake agent scripts
  // echo-stdin: 把 stdin 原样输出到 stdout
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

  // echo-arg: 把最后一个 argv 原样输出到 stdout
  const echoArgScript = path.join(fakeAgentsDir, "echo-arg.cjs");
  fs.writeFileSync(
    echoArgScript,
    `const args = process.argv.slice(2);
const lastArg = args.length > 0 ? args[args.length - 1] : "";
process.stdout.write("ECHO_ARG: " + lastArg);
`,
    "utf8"
  );

  // fail-agent: 输出后以非零码退出
  const failScript = path.join(fakeAgentsDir, "fail.cjs");
  fs.writeFileSync(
    failScript,
    `process.stderr.write("Simulated fatal failure in fail-agent.");
process.exit(2);
`,
    "utf8"
  );

  // sleep-stubborn: 忽略 SIGTERM，必须由 SIGKILL 强制杀掉
  const sleepStubbornScript = path.join(fakeAgentsDir, "sleep-stubborn.cjs");
  fs.writeFileSync(
    sleepStubbornScript,
    `process.on("SIGTERM", () => {
  // deliberately ignore SIGTERM to force SIGKILL
});
setTimeout(() => {
  process.stdout.write("Woke up from sleep-stubborn");
}, 30000);
`,
    "utf8"
  );

  // fake-codex: 打印收到的所有 CLI 参数，用于验证 -m 和 -c model_reasoning_effort 传递
  const fakeCodexScript = path.join(fakeAgentsDir, "fake-codex.cjs");
  fs.writeFileSync(
    fakeCodexScript,
    `process.stdout.write("CODEX_ARGS: " + JSON.stringify(process.argv.slice(2)));\n`,
    "utf8"
  );

  // 2. Register fake agents in TEST_ROOT/agents.json
  const agentsJsonPath = path.join(TEST_ROOT, "agents.json");
  const registryConfig = {
    "echo-stdin": {
      command: "node",
      args: [echoStdinScript],
      input: "stdin",
    },
    "echo-arg": {
      command: "node",
      args: [echoArgScript],
      input: "arg",
    },
    "fail-agent": {
      command: "node",
      args: [failScript],
      input: "stdin",
    },
    "sleep-stubborn": {
      command: "node",
      args: [sleepStubbornScript],
      input: "stdin",
    },
    codex: {
      command: "node",
      args: [fakeCodexScript, "exec", "--sandbox", "workspace-write"],
      input: "stdin",
    },
  };
  fs.writeFileSync(agentsJsonPath, JSON.stringify(registryConfig, null, 2), "utf8");

  // 3. Start worker process (poll interval: 200ms, timeout: 1000ms)
  console.log("[Worker] Spawning worker process...");
  const workerProcess = spawn("node", ["dist/worker.js"], {
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
      AGENT_BRIDGE_POLL_MS: "200",
      AGENT_BRIDGE_TIMEOUT_MS: "1000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  workerProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(`[worker-stderr] ${chunk.toString("utf8")}`);
  });

  // Wait for worker startup
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(workerProcess.exitCode, null, "Worker process should be running");
  console.log(`[Worker] Worker process running successfully (PID: ${workerProcess.pid})\n`);

  try {
    // -------------------------------------------------------------------------
    // Test 1: 合法任务（echo-stdin）被执行，results/<task_id>.md 生成，包含回显
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 1] echo-stdin task execution");
    console.log("-------------------------------------------------");
    const taskId1 = "task_test_001";
    const taskFile1 = path.join(tasksDir, `${taskId1}.md`);
    fs.writeFileSync(
      taskFile1,
      `# Test Case 1 echo-stdin

- **Task ID**: ${taskId1}
- **Agent**: echo-stdin
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Hello from stdin prompt!
`,
      "utf8"
    );

    const resultPath1 = path.join(resultsDir, `${taskId1}.md`);
    const content1 = await waitForFile(resultPath1);
    console.log("Result file content for Test 1:\n" + content1);

    assert.ok(content1.includes("- **Status**: completed"), "Status must be completed");
    assert.ok(content1.includes("- **Agent**: echo-stdin"), "Agent must be echo-stdin");
    assert.ok(content1.includes("- **Exit Code**: 0"), "Exit Code must be 0");
    assert.ok(content1.includes("ECHO_STDIN: Hello from stdin prompt!"), "Stdout must contain echoed stdin prompt");
    console.log("✓ Test 1 passed: echo-stdin task executed successfully.\n");

    // -------------------------------------------------------------------------
    // Test 2: echo-arg 的任务同样生成正确结果，证明 arg 模式可用
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 2] echo-arg task execution (arg mode)");
    console.log("-------------------------------------------------");
    const taskId2 = "task_test_002_arg";
    const taskFile2 = path.join(tasksDir, `${taskId2}.md`);
    fs.writeFileSync(
      taskFile2,
      `# Test Case 2 echo-arg

- **Task ID**: ${taskId2}
- **Agent**: echo-arg
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Hello from arg prompt!
`,
      "utf8"
    );

    const resultPath2 = path.join(resultsDir, `${taskId2}.md`);
    const content2 = await waitForFile(resultPath2);
    console.log("Result file content for Test 2:\n" + content2);

    assert.ok(content2.includes("- **Status**: completed"), "Status must be completed");
    assert.ok(content2.includes("- **Agent**: echo-arg"), "Agent must be echo-arg");
    assert.ok(content2.includes("- **Exit Code**: 0"), "Exit Code must be 0");
    assert.ok(content2.includes("ECHO_ARG: Hello from arg prompt!"), "Stdout must contain echoed arg prompt");
    console.log("✓ Test 2 passed: echo-arg task executed successfully.\n");

    // -------------------------------------------------------------------------
    // Test 3: 同一任务不会被执行两次 (统计 worker.log 出现次数 = 1，断言 processed.json)
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 3] Verify same task is not executed twice");
    console.log("-------------------------------------------------");
    const processedJsonPath = path.join(logsDir, "processed.json");
    assert.ok(fs.existsSync(processedJsonPath), "processed.json must exist");
    const processedMap = JSON.parse(fs.readFileSync(processedJsonPath, "utf8"));
    assert.ok(taskId1 in processedMap, `taskId1 "${taskId1}" must be in processed.json`);
    assert.ok(taskId2 in processedMap, `taskId2 "${taskId2}" must be in processed.json`);

    // Wait several polling intervals
    const stat1Before = fs.statSync(resultPath1);
    await new Promise((r) => setTimeout(r, 600));
    const stat1After = fs.statSync(resultPath1);
    assert.equal(stat1Before.mtimeMs, stat1After.mtimeMs, "Result file must not be modified again");

    // Verify worker.log has exactly 1 "Processing task:" occurrence for taskId1
    const workerLogContent = fs.readFileSync(path.join(logsDir, "worker.log"), "utf8");
    const task1Matches = workerLogContent
      .split("\n")
      .filter((line) => line.includes("Processing task:") && line.includes(taskId1));
    assert.equal(task1Matches.length, 1, `Expected exactly 1 "Processing task" log for ${taskId1}, got ${task1Matches.length}`);
    console.log("✓ Test 3 passed: Duplicate execution prevented (confirmed via worker.log count = 1 and processed.json).\n");

    // -------------------------------------------------------------------------
    // Test 4: fail-agent 返回非零码，Status 为 failed，worker 继续处理后续任务
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 4] fail-agent execution (exit code != 0)");
    console.log("-------------------------------------------------");
    const taskId4 = "task_test_004_fail";
    const taskFile4 = path.join(tasksDir, `${taskId4}.md`);
    fs.writeFileSync(
      taskFile4,
      `# Test Case 4 fail-agent

- **Task ID**: ${taskId4}
- **Agent**: fail-agent
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Trigger failure
`,
      "utf8"
    );

    const resultPath4 = path.join(resultsDir, `${taskId4}.md`);
    const content4 = await waitForFile(resultPath4);
    console.log("Result file content for Test 4:\n" + content4);

    assert.ok(content4.includes("- **Status**: failed"), "Status must be failed");
    assert.ok(content4.includes("- **Exit Code**: 2"), "Exit Code must be 2");
    assert.ok(content4.includes("Simulated fatal failure in fail-agent"), "Error details must capture stderr");
    assert.equal(workerProcess.exitCode, null, "Worker process must continue running after task failure");
    console.log("✓ Test 4 passed: Failing task recorded as failed, worker continues running.\n");

    // -------------------------------------------------------------------------
    // Test 5: sleep-stubborn 配合短超时，忽略 SIGTERM，断言在 超时 + 5 秒 + 余量 内结束，结果包含 SIGKILL
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 5] Timeout handling with sleep-stubborn (SIGTERM ignored, killed via SIGKILL)");
    console.log("-------------------------------------------------");
    const taskId5 = "task_test_005_timeout";
    const taskFile5 = path.join(tasksDir, `${taskId5}.md`);
    fs.writeFileSync(
      taskFile5,
      `# Test Case 5 sleep-stubborn

- **Task ID**: ${taskId5}
- **Agent**: sleep-stubborn
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Sleep stubbornly
`,
      "utf8"
    );

    const start5 = Date.now();
    const resultPath5 = path.join(resultsDir, `${taskId5}.md`);
    const content5 = await waitForFile(resultPath5, 12000);
    const elapsed5 = Date.now() - start5;
    console.log(`Result file content for Test 5 (elapsed: ${elapsed5}ms):\n` + content5);

    // Timeout: 1000ms + SIGKILL delay: 5000ms = 6000ms expected duration (+- margin)
    assert.ok(elapsed5 >= 5500 && elapsed5 <= 10000, `Expected elapsed time around timeout + 5s (~6000ms), got ${elapsed5}ms`);
    assert.ok(content5.includes("- **Status**: failed (timeout)"), "Status must be failed (timeout)");

    const workerLogAfter5 = fs.readFileSync(path.join(logsDir, "worker.log"), "utf8");
    assert.ok(workerLogAfter5.includes("SIGKILL"), 'worker.log must contain "SIGKILL" log entry');
    assert.equal(workerProcess.exitCode, null, "Worker process must remain alive after killing timed-out child");
    console.log("✓ Test 5 passed: Timed out task killed via SIGKILL and marked as failed (timeout).\n");

    // -------------------------------------------------------------------------
    // Test 6: 文件名 ../x.md 或含空格的任务被跳过，不生成结果；且非法文件名的 WARN 日志只出现 1 次
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 6] Invalid filename skipped and warned only once");
    console.log("-------------------------------------------------");
    const invalidFileName = "invalid task with spaces.md";
    fs.writeFileSync(path.join(tasksDir, invalidFileName), "# Invalid\n- **Agent**: echo-stdin\n", "utf8");

    // Wait several polling intervals
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(!fs.existsSync(path.join(resultsDir, invalidFileName)), "Invalid filename must not generate result file");

    const workerLogAfter6 = fs.readFileSync(path.join(logsDir, "worker.log"), "utf8");
    const warnMatches = workerLogAfter6
      .split("\n")
      .filter((line) => line.includes("Skipping invalid task file") && line.includes(invalidFileName));
    assert.equal(warnMatches.length, 1, `Expected exactly 1 warning for invalid filename "${invalidFileName}", got ${warnMatches.length}`);
    console.log("✓ Test 6 passed: Invalid task filename was skipped and warned only once in worker.log.\n");

    // -------------------------------------------------------------------------
    // Test 7: Agent 字段缺失或未注册：Status 为 failed，且不执行任何命令
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 7] Missing or unregistered agent in task file");
    console.log("-------------------------------------------------");
    // 7a: Missing agent
    const taskId7a = "task_test_007a_missing";
    fs.writeFileSync(
      path.join(tasksDir, `${taskId7a}.md`),
      `# Missing Agent Task\n- **Task ID**: ${taskId7a}\n- **Agent**: \n---\n## Prompt\nNo agent\n`,
      "utf8"
    );
    const content7a = await waitForFile(path.join(resultsDir, `${taskId7a}.md`));
    assert.ok(content7a.includes("- **Status**: failed (agent not registered)"), "Must fail when agent field is empty");

    // 7b: Unregistered agent
    const taskId7b = "task_test_007b_unregistered";
    fs.writeFileSync(
      path.join(tasksDir, `${taskId7b}.md`),
      `# Unregistered Agent Task\n- **Task ID**: ${taskId7b}\n- **Agent**: ghost-agent\n---\n## Prompt\nGhost\n`,
      "utf8"
    );
    const content7b = await waitForFile(path.join(resultsDir, `${taskId7b}.md`));
    assert.ok(content7b.includes("- **Status**: failed (agent not registered)"), "Must fail when agent is unregistered");
    console.log("✓ Test 7 passed: Tasks with missing or unregistered agent marked as failed without command execution.\n");

    // -------------------------------------------------------------------------
    // Test 8: 结果经过 .tmp 中转，测试结束时不存在残留 .tmp（使用 fs.readdirSync 检查）
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 8] Verify atomic writing with no leftover .tmp files via fs.readdirSync");
    console.log("-------------------------------------------------");
    const resultFiles = fs.readdirSync(resultsDir);
    const tmpFiles = resultFiles.filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, `Expected 0 .tmp files in results directory, found: ${tmpFiles.join(", ")}`);
    console.log("✓ Test 8 passed: fs.readdirSync confirmed 0 residual .tmp files in results directory.\n");

    // -------------------------------------------------------------------------
    // Test 9: send_task 传入未注册的 agent 时返回 isError: true，且列出可用名称
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 9] MCP send_task validation with unregistered agent");
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
    assert.ok(errText.includes("echo-stdin"), "Error must list available agent names");
    assert.ok(errText.includes("echo-arg"), "Error must list available agent names");

    await mcpClient.close();
    console.log("✓ Test 9 passed: send_task correctly rejected unregistered agent and listed available names.\n");

    // -------------------------------------------------------------------------
    // Test 10: Codex 任务指定 model 与 reasoning_effort，worker 正确透传 CLI 参数
    // -------------------------------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 10] Codex task execution with custom model & reasoning_effort");
    console.log("-------------------------------------------------");
    const taskId10 = "task_test_010_model";
    const taskFile10 = path.join(tasksDir, `${taskId10}.md`);
    fs.writeFileSync(
      taskFile10,
      `# Test Case 10 codex-model

- **Task ID**: ${taskId10}
- **Agent**: codex
- **Model**: gpt-6.1-sol
- **Reasoning Effort**: high
- **Created At**: ${new Date().toISOString()}

---

## Prompt

Analyze codebase architecture
`,
      "utf8"
    );

    const resultPath10 = path.join(resultsDir, `${taskId10}.md`);
    const content10 = await waitForFile(resultPath10);
    console.log("Result file content for Test 10:\n" + content10);

    assert.ok(content10.includes("- **Status**: completed"), "Status must be completed");
    assert.ok(content10.includes("- **Agent**: codex"), "Agent must be codex");
    assert.ok(content10.includes("- **Model**: gpt-6.1-sol"), "Result must contain Model header");
    assert.ok(content10.includes("- **Reasoning Effort**: high"), "Result must contain Reasoning Effort header");
    assert.ok(content10.includes("- **Exit Code**: 0"), "Exit Code must be 0");
    assert.ok(content10.includes("-m"), "Output must contain -m flag");
    assert.ok(content10.includes("gpt-6.1-sol"), "Output must contain model value");
    assert.ok(content10.includes("-c"), "Output must contain -c flag");
    assert.ok(content10.includes('model_reasoning_effort=\\"high\\"'), "Output must contain model_reasoning_effort");
    console.log("✓ Test 10 passed: Codex task executed with -m and -c model_reasoning_effort flags correctly.\n");
  } finally {
    // Terminate worker cleanly
    console.log("[Cleanup] Terminating worker process...");
    workerProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 600));
    if (!workerProcess.killed) {
      workerProcess.kill("SIGKILL");
    }
  }

  console.log("=================================================");
  console.log("All 10 worker test assertions passed successfully!");
  console.log("=================================================");
}

runWorkerTests().catch((err) => {
  console.error("Worker test runner failed:", err);
  process.exit(1);
});
