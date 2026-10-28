import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-ops-test";

async function runOpsTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp Ops & Management Test Suite");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}\n`);

  // Clean setup
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const tasksDir = path.join(TEST_ROOT, "tasks");
  const resultsDir = path.join(TEST_ROOT, "results");
  const logsDir = path.join(TEST_ROOT, "logs");
  const statusDir = path.join(TEST_ROOT, "status");
  const controlDir = path.join(TEST_ROOT, "control");
  const workdir = path.join(TEST_ROOT, "workdir");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(statusDir, { recursive: true });
  fs.mkdirSync(controlDir, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });

  // 1. Setup mock agents in agents.json
  const agentsJsonPath = path.join(TEST_ROOT, "agents.json");
  const registryConfig = {
    "echo-stdin": {
      command: "node",
      args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d));"],
      input: "stdin",
    },
    "two-stage": {
      command: "node",
      args: ["-e", "process.stdout.write('STAGE1\\n');setTimeout(()=>{process.stdout.write('STAGE2\\n');}, 2000);"],
      input: "stdin",
    },
    "sleep-stubborn": {
      command: "node",
      args: ["-e", "process.on('SIGTERM', ()=>{}); setInterval(()=>{}, 1000);"],
      input: "stdin",
    },
    "large-output": {
      command: "node",
      args: ["-e", "process.stdout.write('X'.repeat(5000));"],
      input: "stdin",
    },
  };
  fs.writeFileSync(agentsJsonPath, JSON.stringify(registryConfig, null, 2), "utf8");

  // 2. Start worker process
  console.log("[Worker] Spawning worker process...");
  const workerProcess = spawn("node", ["dist/worker.js"], {
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
      AGENT_BRIDGE_POLL_MS: "100",
      AGENT_BRIDGE_TIMEOUT_MS: "30000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  workerProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim()) console.log(`[worker-stderr] ${line.trim()}`);
    }
  });

  await new Promise((r) => setTimeout(r, 500));
  assert.ok(workerProcess.pid, "Worker PID should exist");
  console.log(`[Worker] Worker running (PID: ${workerProcess.pid})\n`);

  // 3. Connect MCP Client to dist/index.js
  console.log("[MCP Client] Connecting to agent-bridge-mcp server...");
  const serverPath = path.resolve("dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
    },
  });

  const client = new Client({ name: "ops-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log("[MCP Client] Connected successfully!\n");

  // Helper to wait for file existence
  async function waitForFile(filePath: string, timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(filePath)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  const UNIQUE_PROMPT_SECRET = "SECRET_PROMPT_TOKEN_XYZ_999";

  try {
    // -------------------------------------------------
    // [Test A] get_task_status: queued -> running -> completed
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test A] get_task_status state transitions");
    console.log("-------------------------------------------------");

    // Test queued state with unstarted task
    const queuedTaskId = "task_ops_queued_001";
    fs.writeFileSync(
      path.join(tasksDir, `${queuedTaskId}.md`),
      `# Task\n- **Task ID**: ${queuedTaskId}\n- **Agent**: echo-stdin\n---\n## Prompt\n${UNIQUE_PROMPT_SECRET}\n`
    );
    // Before worker processes it, query status:
    const statusBeforeRes = await client.callTool({
      name: "get_task_status",
      arguments: { task_id: queuedTaskId },
    });
    const statusBefore = JSON.parse((statusBeforeRes.content as any)[0].text);
    console.log("Status before/queued:", statusBefore);
    assert.ok(["queued", "running", "completed"].includes(statusBefore.state), "State should be valid");

    // Wait for it to complete
    const qResultReady = await waitForFile(path.join(resultsDir, `${queuedTaskId}.md`), 5000);
    assert.ok(qResultReady, "Queued task should complete");

    const statusAfterRes = await client.callTool({
      name: "get_task_status",
      arguments: { task_id: queuedTaskId },
    });
    const statusAfter = JSON.parse((statusAfterRes.content as any)[0].text);
    console.log("Status after completion:", statusAfter);
    assert.equal(statusAfter.state, "completed", "Final state must be completed");
    console.log("✓ Test A passed: get_task_status correctly reported status transitions.\n");

    // -------------------------------------------------
    // [Test B] read_task_output: incremental stdout during & after two-stage
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test B] read_task_output incremental reading");
    console.log("-------------------------------------------------");

    const twoStageTaskId = "task_ops_twostage_002";
    fs.writeFileSync(
      path.join(tasksDir, `${twoStageTaskId}.md`),
      `# TwoStage\n- **Task ID**: ${twoStageTaskId}\n- **Agent**: two-stage\n---\n## Prompt\nrun\n`
    );

    // Wait for STAGE1 to be written (takes ~300ms)
    const outFilePath = path.join(logsDir, `${twoStageTaskId}.out`);
    await waitForFile(outFilePath, 3000);
    await new Promise((r) => setTimeout(r, 600));

    // Mid-execution read
    const midReadRes = await client.callTool({
      name: "read_task_output",
      arguments: { task_id: twoStageTaskId, offset: 0, length: 4000 },
    });
    const midOutput = JSON.parse((midReadRes.content as any)[0].text);
    console.log("Mid-execution output read:", midOutput);

    assert.ok(midOutput.output.includes("STAGE1"), "Mid-execution read must include STAGE1");
    assert.ok(!midOutput.output.includes("STAGE2"), "Mid-execution read must NOT include STAGE2 yet");
    assert.equal(midOutput.eof, false, "eof must be false mid-execution");
    assert.ok(midOutput.nextOffset > 0, "nextOffset must be positive");

    // Wait for task completion (two-stage finishes in 2s)
    const twoStageDone = await waitForFile(path.join(resultsDir, `${twoStageTaskId}.md`), 5000);
    assert.ok(twoStageDone, "Two-stage task should finish");

    // Second read from nextOffset
    const postReadRes = await client.callTool({
      name: "read_task_output",
      arguments: { task_id: twoStageTaskId, offset: midOutput.nextOffset, length: 4000 },
    });
    const postOutput = JSON.parse((postReadRes.content as any)[0].text);
    console.log("Post-completion output read:", postOutput);

    assert.ok(postOutput.output.includes("STAGE2"), "Post-completion read must include STAGE2");
    assert.equal(postOutput.eof, true, "eof must be true after completion");
    console.log("✓ Test B passed: read_task_output read output incrementally with valid nextOffset and eof.\n");

    // -------------------------------------------------
    // [Test C] read_result_page: paged result reading
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test C] read_result_page multi-page stitched reading");
    console.log("-------------------------------------------------");

    const largeTaskId = "task_ops_large_003";
    fs.writeFileSync(
      path.join(tasksDir, `${largeTaskId}.md`),
      `# Large\n- **Task ID**: ${largeTaskId}\n- **Agent**: large-output\n---\n## Prompt\nlarge\n`
    );

    const largeDone = await waitForFile(path.join(resultsDir, `${largeTaskId}.md`), 5000);
    assert.ok(largeDone, "Large output task should finish");

    const fullResultContent = fs.readFileSync(path.join(resultsDir, `${largeTaskId}.md`), "utf8");
    assert.ok(fullResultContent.length > 4000, `Result file length (${fullResultContent.length}) should exceed 4000 bytes`);

    // Page 1: length 3000
    const page1Res = await client.callTool({
      name: "read_result_page",
      arguments: { task_id: largeTaskId, offset: 0, length: 3000 },
    });
    const page1 = JSON.parse((page1Res.content as any)[0].text);
    assert.equal(page1.eof, false, "Page 1 eof must be false");
    assert.equal(page1.nextOffset, 3000, "Page 1 nextOffset must be 3000");

    // Page 2: length 5000 from offset 3000
    const page2Res = await client.callTool({
      name: "read_result_page",
      arguments: { task_id: largeTaskId, offset: page1.nextOffset, length: 5000 },
    });
    const page2 = JSON.parse((page2Res.content as any)[0].text);
    assert.equal(page2.eof, true, "Page 2 eof must be true");

    const stitched = page1.content + page2.content;
    assert.equal(stitched, fullResultContent, "Stitched content must equal full result file content");
    console.log("✓ Test C passed: read_result_page paged results match 100% with original.\n");

    // -------------------------------------------------
    // [Test D] cancel_task: cancel running sleep-stubborn within 10s
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test D] cancel_task on running sleep-stubborn");
    console.log("-------------------------------------------------");

    const stubbornTaskId = "task_ops_stubborn_004";
    fs.writeFileSync(
      path.join(tasksDir, `${stubbornTaskId}.md`),
      `# Stubborn\n- **Task ID**: ${stubbornTaskId}\n- **Agent**: sleep-stubborn\n---\n## Prompt\nsleep\n`
    );

    // Wait until worker picks it up and marks running
    let runningDetected = false;
    for (let i = 0; i < 30; i++) {
      const s = await client.callTool({
        name: "get_task_status",
        arguments: { task_id: stubbornTaskId },
      });
      const parsed = JSON.parse((s.content as any)[0].text);
      if (parsed.state === "running") {
        runningDetected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(runningDetected, "Stubborn task must reach running state");

    const t0 = Date.now();
    const cancelRes = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: stubbornTaskId },
    });
    console.log("cancel_task response:", (cancelRes.content as any)[0].text);

    // Wait until result file is generated with status cancelled
    const stubbornResultPath = path.join(resultsDir, `${stubbornTaskId}.md`);
    const stubbornDone = await waitForFile(stubbornResultPath, 10000);
    const cancelDuration = Date.now() - t0;
    console.log(`Cancellation completed in ${cancelDuration}ms`);

    assert.ok(stubbornDone, "Cancelled result file should exist");
    assert.ok(cancelDuration <= 10000, `Cancellation took ${cancelDuration}ms, must be within 10s`);

    const stubbornResult = fs.readFileSync(stubbornResultPath, "utf8");
    assert.ok(stubbornResult.includes("cancelled"), "Result file must have cancelled status");

    const workerLogContent = fs.readFileSync(path.join(logsDir, "worker.log"), "utf8");
    assert.ok(
      workerLogContent.includes("SIGTERM") || workerLogContent.includes("SIGKILL"),
      "worker.log must record SIGTERM or SIGKILL signal sending"
    );
    console.log("✓ Test D passed: sleep-stubborn was cancelled via SIGTERM/SIGKILL within 10s.\n");

    // -------------------------------------------------
    // [Test E] cancel_task: pre-cancelled task not started
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test E] cancel_task before task start");
    console.log("-------------------------------------------------");

    const preCancelTaskId = "task_ops_precancel_005";
    // Write cancel file FIRST before task file
    fs.writeFileSync(path.join(controlDir, `${preCancelTaskId}.cancel`), new Date().toISOString(), "utf8");
    fs.writeFileSync(
      path.join(tasksDir, `${preCancelTaskId}.md`),
      `# PreCancel\n- **Task ID**: ${preCancelTaskId}\n- **Agent**: echo-stdin\n---\n## Prompt\nshould_not_run\n`
    );

    const preDone = await waitForFile(path.join(resultsDir, `${preCancelTaskId}.md`), 5000);
    assert.ok(preDone, "Pre-cancelled task should generate result");

    const preResult = fs.readFileSync(path.join(resultsDir, `${preCancelTaskId}.md`), "utf8");
    assert.ok(preResult.includes("cancelled"), "Result must be cancelled");

    const updatedWorkerLog = fs.readFileSync(path.join(logsDir, "worker.log"), "utf8");
    assert.ok(
      !updatedWorkerLog.includes(`Processing task: taskId=${preCancelTaskId}`),
      `worker.log must NOT contain 'Processing task: taskId=${preCancelTaskId}'`
    );
    console.log("✓ Test E passed: task pre-cancelled without agent execution.\n");

    // -------------------------------------------------
    // [Test F] Audit log: valid JSON, does not contain secret prompt token
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test F] audit.log validation & privacy verification");
    console.log("-------------------------------------------------");

    const auditLogPath = path.join(logsDir, "audit.log");
    assert.ok(fs.existsSync(auditLogPath), "audit.log must exist");

    const auditLines = fs.readFileSync(auditLogPath, "utf8").trim().split("\n");
    console.log(`audit.log contains ${auditLines.length} lines.`);
    assert.ok(auditLines.length > 0, "audit.log must contain entries");

    for (let i = 0; i < auditLines.length; i++) {
      const line = auditLines[i];
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        assert.fail(`audit.log line ${i + 1} is not valid JSON: ${line}`);
      }
      assert.ok(parsed.ts, "Audit entry must contain ts");
      assert.ok(parsed.tool || parsed.state, "Audit entry must contain tool or state");
    }

    const fullAuditText = fs.readFileSync(auditLogPath, "utf8");
    assert.ok(
      !fullAuditText.includes(UNIQUE_PROMPT_SECRET),
      `audit.log must NOT contain prompt token '${UNIQUE_PROMPT_SECRET}'`
    );
    console.log("✓ Test F passed: audit.log entries are valid JSON and do NOT leak prompt text.\n");

    // -------------------------------------------------
    // [Test G] get_task_status invalid task_id returns isError: true
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test G] get_task_status invalid task_id validation");
    console.log("-------------------------------------------------");

    const badStatusRes = await client.callTool({
      name: "get_task_status",
      arguments: { task_id: "../etc/passwd" },
    });
    assert.equal(badStatusRes.isError, true, "Invalid task_id must return isError: true");
    console.log("✓ Test G passed: get_task_status returned isError: true on invalid task_id.\n");

    // -------------------------------------------------
    // [Test H] No residual .tmp files in control and status directories
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test H] No .tmp residual files in control and status");
    console.log("-------------------------------------------------");

    const statusTmpFiles = fs.readdirSync(statusDir).filter((f) => f.endsWith(".tmp"));
    const controlTmpFiles = fs.readdirSync(controlDir).filter((f) => f.endsWith(".tmp"));

    console.log("status .tmp files count:", statusTmpFiles.length);
    console.log("control .tmp files count:", controlTmpFiles.length);

    assert.equal(statusTmpFiles.length, 0, "status directory must contain 0 .tmp files");
    assert.equal(controlTmpFiles.length, 0, "control directory must contain 0 .tmp files");
    console.log("✓ Test H passed: 0 .tmp residual files detected.\n");

    console.log("=================================================");
    console.log("  All ops test assertions passed successfully!   ");
    console.log("=================================================");
  } finally {
    console.log("\n[Cleanup] Closing client and terminating worker...");
    await client.close();
    workerProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!workerProcess.killed) workerProcess.kill("SIGKILL");
  }
}

runOpsTests().catch((err) => {
  console.error("Ops tests failed:", err);
  process.exit(1);
});
