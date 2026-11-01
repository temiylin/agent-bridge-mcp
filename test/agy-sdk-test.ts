import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processTaskFile } from "../src/worker.js";
import { readStatus } from "../src/status.js";
import { AgentRegistry } from "../src/agents.js";

async function runLiveTests() {
  if (process.env.AGY_LIVE_TEST !== "1") {
    console.log("Skipping live agy-sdk tests (set AGY_LIVE_TEST=1 to run against real agy CLI).");
    return;
  }

  const testAccount = process.env.AGY_TEST_ACCOUNT?.trim();
  const accountLine = testAccount ? `- **Account**: ${testAccount}\n` : "";

  console.log("=== Running agy-sdk Live Real CLI Verification (AGY_LIVE_TEST=1) ===");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-agy-sdk-live-"));
  const tasksDir = path.join(tmpRoot, "tasks");
  const resultsDir = path.join(tmpRoot, "results");
  const logsDir = path.join(tmpRoot, "logs");
  const statusDir = path.join(tmpRoot, "status");
  const controlDir = path.join(tmpRoot, "control");
  for (const d of [tasksDir, resultsDir, logsDir, statusDir, controlDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const registry: AgentRegistry = {
    "agy-sdk": {
      command: "agy",
      args: ["--dangerously-skip-permissions", "--output-format", "stream-json"],
      input: "stdin",
    },
  };
  fs.writeFileSync(path.join(tmpRoot, "agents.json"), JSON.stringify(registry, null, 2), "utf8");

  const processedMap: Record<string, string> = {};

  // Scenario 1: Real `agy` session continuation (`--continue` / `session_id` -> `--conversation`)
  {
    const sessionKey = "sess_continue_verify_01";
    const task1 = "task_agy_sdk_turn1";
    const task1Md = `# Task ${task1}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
${accountLine}- **Session ID**: ${sessionKey}
- **Notify**: false

## Prompt
Remember the secret codeword: PINEAPPLE_991. Reply with only: ACK_TURN_1 (do not run tools).
`;
    fs.writeFileSync(path.join(tasksDir, `${task1}.md`), task1Md, "utf8");
    await processTaskFile(`${task1}.md`, tasksDir, resultsDir, processedMap, registry, 60000, tmpRoot);

    const st1 = readStatus(tmpRoot, task1);
    assert.strictEqual(st1?.state, "completed", `Turn 1 failed: ${st1?.reason}`);
    const convId1 = st1?.sessionId;
    assert.ok(convId1 && convId1.length > 10, `Expected real conversationId on Turn 1, got ${convId1}`);

    const task2 = "task_agy_sdk_turn2";
    const task2Md = `# Task ${task2}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
${accountLine}- **Session ID**: ${sessionKey}
- **Continue Session**: true
- **Notify**: false

## Prompt
What was the secret codeword I told you in the previous turn? Reply with ONLY the codeword.
`;
    fs.writeFileSync(path.join(tasksDir, `${task2}.md`), task2Md, "utf8");
    await processTaskFile(`${task2}.md`, tasksDir, resultsDir, processedMap, registry, 60000, tmpRoot);

    const st2 = readStatus(tmpRoot, task2);
    assert.strictEqual(st2?.state, "completed", `Turn 2 failed: ${st2?.reason}`);
    assert.strictEqual(st2?.sessionId, convId1, "Turn 2 should preserve the exact same conversation_id");
    const res2 = fs.readFileSync(path.join(resultsDir, `${task2}.md`), "utf8");
    assert.ok(res2.includes("PINEAPPLE_991"), `Turn 2 should recall PINEAPPLE_991 from Turn 1, got:\n${res2}`);
    console.log(`✅ [Live 1/2] Real agy session continuation (--conversation) verified: convId=${convId1}`);
  }

  // Scenario 2: Real `agy` Cancellation (`cancel_task`) -> `cancelled` without reverting to `running`
  {
    const taskCancel = "task_agy_sdk_cancel_03";
    const taskCancelMd = `# Task ${taskCancel}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
${accountLine}- **Notify**: false

## Prompt
Write a 2000-word detailed essay about distributed consensus algorithms.
`;
    fs.writeFileSync(path.join(tasksDir, `${taskCancel}.md`), taskCancelMd, "utf8");

    setTimeout(() => {
      fs.writeFileSync(path.join(controlDir, `${taskCancel}.cancel`), "cancel", "utf8");
      const cur = readStatus(tmpRoot, taskCancel);
      if (cur) {
        fs.writeFileSync(
          path.join(statusDir, `${taskCancel}.json`),
          JSON.stringify({ ...cur, state: "cancelled", reason: "cancelled by request" }, null, 2),
          "utf8"
        );
      }
    }, 1200);

    await processTaskFile(`${taskCancel}.md`, tasksDir, resultsDir, processedMap, registry, 60000, tmpRoot);

    const stCancel = readStatus(tmpRoot, taskCancel);
    assert.strictEqual(stCancel?.state, "cancelled", `Expected cancelled state, got ${stCancel?.state}`);
    assert.strictEqual(stCancel?.activity_source, "cancelled");
    const resCancel = fs.readFileSync(path.join(resultsDir, `${taskCancel}.md`), "utf8");
    assert.ok(resCancel.includes("cancelled (cancelled by request)"));
    console.log(`✅ [Live 2/2] Real agy cancellation verified: terminal state=${stCancel?.state}`);
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}

runLiveTests().catch((err) => {
  console.error("Live test failed:", err);
  process.exit(1);
});
