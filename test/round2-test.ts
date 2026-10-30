import assert from "node:assert";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseTestCounts } from "../src/pr-verifier.js";
import { restartService } from "../src/service-manager.js";
import { listProjectTasks } from "../src/project-tasks.js";
import { listAccountsFromCockpitStorage, switchAgentAccount } from "../src/account-manager.js";
import { parseTaskFile } from "../src/worker.js";

async function runTests() {
  console.log("=== Round 2 Capabilities Test Suite ===");

  // 1. Test parseTestCounts
  console.log("[Test 1] Testing parseTestCounts...");
  const sampleLog = `
TAP version 13
# Subtest: src/math.test.ts
ok 1 - add works
not ok 2 - divide by zero throws
  ---
  error: "division by zero"
  ...
# Subtest: src/user.test.ts
ok 3 - auth user
not ok 4 - timeout on token
1..4
# tests 4
# pass 2
# fail 2
`;
  const result = parseTestCounts(sampleLog);
  assert.strictEqual(result.passed, 2);
  assert.strictEqual(result.failed, 2);
  assert.strictEqual(result.failingCases.length, 2);
  assert.strictEqual(result.failingCases[0], "divide by zero throws");
  assert.strictEqual(result.failingCases[1], "timeout on token");
  console.log("✓ parseTestCounts passed.");

  // 2. Test restart_service with mock HTTP server
  console.log("\n[Test 2] Testing restartService with mock server...");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "round2-test-"));
  const projectsConfig = {
    projects: {
      "test-app": {
        name: "test-app",
        repo_path: tempDir,
        services: {
          web: {
            command: "node -e 'const http=require(\"http\"); const server=http.createServer((req,res)=>{res.writeHead(200);res.end(\"ok\");}); server.listen(18972);'",
            port: 18972,
            health_url: "http://127.0.0.1:18972/health",
            health_timeout_sec: 5
          }
        }
      }
    }
  };
  await fs.writeFile(path.join(tempDir, "projects.json"), JSON.stringify(projectsConfig, null, 2));

  const restartResult = await restartService(tempDir, "test-app", "web");
  console.log("Restart result:", restartResult);
  assert.strictEqual(restartResult.success, true);
  assert.strictEqual(restartResult.httpStatus, 200);

  // Clean up mock web process
  if (restartResult.pid) {
    try {
      process.kill(restartResult.pid, "SIGKILL");
    } catch {}
  }
  console.log("✓ restartService passed.");

  // 3. Test listProjectTasks
  console.log("\n[Test 3] Testing listProjectTasks...");
  const tasksDir = path.join(tempDir, "tasks");
  const statusDir = path.join(tempDir, "status");
  const logsDir = path.join(tempDir, "logs");
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.mkdir(statusDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  const taskId = "task_test_12345";
  const taskContent = `# Test Task
- **Task ID**: ${taskId}
- **Project ID**: test-project
- **Agent**: antigravity

---

## Prompt
Do something`;
  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), taskContent);
  await fs.writeFile(
    path.join(statusDir, `${taskId}.json`),
    JSON.stringify({
      taskId,
      state: "running",
      agent: "antigravity",
      startedAt: new Date(Date.now() - 10000).toISOString()
    })
  );
  await fs.writeFile(path.join(logsDir, `${taskId}.out`), "Step 1\nStep 2\nFinished step 2 successfully");

  const runningTasks = listProjectTasks(tempDir, "test-project");
  assert.strictEqual(runningTasks.length, 1);
  assert.strictEqual(runningTasks[0].taskId, taskId);
  assert.strictEqual(runningTasks[0].project, "test-project");
  assert.strictEqual(runningTasks[0].lastOutputLine, "Finished step 2 successfully");
  assert.ok(runningTasks[0].elapsedSeconds >= 9);
  console.log("✓ listProjectTasks passed.");

  // 4. Test parseTaskFile for task chains (on_success)
  console.log("\n[Test 4] Testing parseTaskFile with on_success chain...");
  const chainedTaskContent = `# Chained Task
- **Task ID**: task_chain_root
- **Agent**: codex
- **On Success**: [{"prompt":"Run follow-up step","agent":"codex","title":"Follow-up 1"}]

---

## Prompt
Initial task prompt
`;
  const parsed = parseTaskFile(chainedTaskContent);
  assert.strictEqual(parsed.agentName, "codex");
  assert.ok(Array.isArray(parsed.onSuccess));
  assert.strictEqual(parsed.onSuccess.length, 1);
  assert.strictEqual(parsed.onSuccess[0].prompt, "Run follow-up step");
  console.log("✓ parseTaskFile with on_success passed.");

  // 5. Test Cockpit account list
  console.log("\n[Test 5] Testing Cockpit account reader...");
  const accounts = await listAccountsFromCockpitStorage();
  console.log(`Discovered ${accounts.length} cockpit accounts.`);
  assert.ok(Array.isArray(accounts));
  for (const acc of accounts) {
    // Assert tokens are NOT present in account object
    assert.strictEqual((acc as any).access_token, undefined);
    assert.strictEqual((acc as any).refresh_token, undefined);
    assert.strictEqual((acc as any).ciphertext, undefined);
    assert.ok(acc.email, "Account should have email");
    assert.ok(typeof acc.disabled === "boolean", "Account should have disabled boolean");
  }
  console.log("✓ Cockpit account reader passed (no tokens exposed).");

  // Clean up temp dir
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  console.log("\n=== All Round 2 Unit Tests Passed Successfully! ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
