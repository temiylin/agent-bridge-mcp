import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const TEST_ROOT = "/tmp/agent-bridge-e2e-codex-write";
const WORKDIR = path.join(TEST_ROOT, "workdir");

async function runE2ECodexWriteTest() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp Real Codex Write E2E Test");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}`);
  console.log(`Worker cwd / working directory: ${WORKDIR}\n`);

  // Clean setup
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(WORKDIR, { recursive: true });

  const tasksDir = path.join(TEST_ROOT, "tasks");
  const resultsDir = path.join(TEST_ROOT, "results");
  const logsDir = path.join(TEST_ROOT, "logs");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  // 1. Write agents.json with codex in workspace-write mode
  const agentsJsonPath = path.join(TEST_ROOT, "agents.json");
  const registryConfig = {
    codex: {
      command: "codex",
      args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"],
      input: "stdin",
    },
  };
  fs.writeFileSync(agentsJsonPath, JSON.stringify(registryConfig, null, 2), "utf8");
  console.log("Registered codex agent in temporary agents.json:", JSON.stringify(registryConfig));

  // 2. Write task file in tasks/
  const taskId = "task_e2e_codex_write_001";
  const taskFilePath = path.join(tasksDir, `${taskId}.md`);
  const createdAt = new Date().toISOString();
  fs.writeFileSync(
    taskFilePath,
    `# E2E Test Codex Write

- **Task ID**: ${taskId}
- **Agent**: codex
- **Created At**: ${createdAt}

---

## Prompt

Create a file named hello.txt in the current working directory containing exactly the text: WRITE_OK. Do not create any other files.
`,
    "utf8"
  );
  console.log(`Created task file: ${taskFilePath}\n`);

  // 3. Start worker process with cwd = WORKDIR
  const workerScript = path.resolve("dist/worker.js");
  console.log(`[Worker] Spawning worker process from: ${workerScript} (cwd: ${WORKDIR})...`);
  const workerProcess = spawn("node", [workerScript], {
    cwd: WORKDIR,
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
      AGENT_BRIDGE_POLL_MS: "500",
      AGENT_BRIDGE_TIMEOUT_MS: "180000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  workerProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(`[worker-stderr] ${chunk.toString("utf8")}`);
  });

  // Wait for worker startup
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(workerProcess.exitCode, null, "Worker process should be running");
  console.log(`[Worker] Worker running (PID: ${workerProcess.pid})\n`);

  const workerLogPath = path.join(logsDir, "worker.log");

  try {
    // 4. Wait for results/<task_id>.md to appear (max 180s)
    const resultFilePath = path.join(resultsDir, `${taskId}.md`);
    const timeoutMs = 180000;
    const start = Date.now();
    let resultFound = false;
    let resultContent = "";

    console.log(`Waiting for result file ${resultFilePath} (max 180s)...`);
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(resultFilePath)) {
        try {
          const content = fs.readFileSync(resultFilePath, "utf8");
          if (content.includes("- **Status**:") && content.includes("- **Finished At**:")) {
            resultFound = true;
            resultContent = content;
            break;
          }
        } catch {
          // File might be being written
        }
      }
      if (workerProcess.exitCode !== null) {
        throw new Error(`Worker process exited prematurely with code ${workerProcess.exitCode}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!resultFound) {
      throw new Error(`Timeout after ${timeoutMs}ms waiting for ${resultFilePath}`);
    }

    const elapsedMs = Date.now() - start;
    console.log(`\nResult file received in ${elapsedMs}ms:`);
    console.log("-------------------------------------------------");
    console.log(resultContent);
    console.log("-------------------------------------------------\n");

    // 5. Assertions on result file
    assert.ok(
      resultContent.includes("- **Status**: completed"),
      `Task status must be completed, but received:\n${resultContent}`
    );
    assert.ok(
      resultContent.includes("- **Exit Code**: 0"),
      `Task Exit Code must be 0, but received:\n${resultContent}`
    );
    console.log("✓ Result assertions passed: Status is completed, Exit Code is 0.");

    // 6. Assertions on file created by codex in workdir
    const helloTxtPath = path.join(WORKDIR, "hello.txt");
    assert.ok(
      fs.existsSync(helloTxtPath),
      `Expected ${helloTxtPath} to exist in workdir, but it was not found.`
    );
    const helloContent = fs.readFileSync(helloTxtPath, "utf8").trim();
    assert.equal(
      helloContent,
      "WRITE_OK",
      `Expected hello.txt content to equal "WRITE_OK", but got: "${helloContent}"`
    );
    console.log(`✓ Workdir file assertion passed: hello.txt exists and contains "${helloContent}".\n`);

    // 7. Stop worker cleanly
    console.log("[Worker] Terminating worker process...");
    workerProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    if (workerProcess.exitCode === null) {
      workerProcess.kill("SIGKILL");
    }

    // 8. Assert no .tmp files remain in results/
    const resultFiles = fs.readdirSync(resultsDir);
    const tmpFiles = resultFiles.filter((f) => f.endsWith(".tmp"));
    assert.equal(
      tmpFiles.length,
      0,
      `Expected 0 .tmp files in results directory, but found: ${tmpFiles.join(", ")}`
    );
    console.log("✓ Atomic write assertion passed: No leftover .tmp files in results directory.\n");

    console.log("=================================================");
    console.log("Codex Write E2E test passed successfully!");
    console.log("=================================================");
  } catch (err: any) {
    console.error(`\n[ERROR] E2E Codex Write test failed: ${err?.message || String(err)}\n`);
    if (fs.existsSync(workerLogPath)) {
      console.error("--- Content of worker.log ---");
      console.error(fs.readFileSync(workerLogPath, "utf8"));
      console.error("--- End of worker.log ---\n");
    }
    if (fs.existsSync(WORKDIR)) {
      console.error("--- Files in workdir ---");
      console.error(fs.readdirSync(WORKDIR));
      console.error("--- End of files in workdir ---\n");
    }
    try {
      workerProcess.kill("SIGKILL");
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

runE2ECodexWriteTest();
