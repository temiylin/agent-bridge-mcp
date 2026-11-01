import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgySdkStreamParser, AgySdkActivityUpdate } from "../src/agy-sdk-stream.js";
import { processTaskFile } from "../src/worker.js";
import { readStatus } from "../src/status.js";
import { AgentRegistry } from "../src/agents.js";

async function runTests() {
  console.log("=== Running agy-sdk Stream & 4-Scenario Real Verification ===");

  // 0. Unit test AgySdkStreamParser fault tolerance (unknown events, malformed lines, future schema changes)
  {
    const updates: AgySdkActivityUpdate[] = [];
    const parser = new AgySdkStreamParser({
      onActivity: (u) => updates.push(u),
    });

    const streamLines = [
      "non-json-banner-line",
      JSON.stringify({
        event: "init",
        conversation_id: "conv-unit-001",
        init: { cwd: "/tmp", permission_mode: "always-proceed", future_field: 123 },
      }),
      JSON.stringify({
        event: "future_unknown_event_v2",
        conversation_id: "conv-unit-001",
        nested: { foo: "bar" },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-unit-001",
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          thinking_delta: "Thinking...",
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-unit-001",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool_call",
          tool_info: { name: "run_command", parameters: { CommandLine: "ls" } },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-unit-001",
          step_index: 3,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "SDK_OK_42",
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-unit-001",
          status: "SUCCESS",
          response: "SDK_OK_42\n",
          duration_seconds: 1.23,
        },
      }),
    ];

    const readable = parser.feedChunk(streamLines.join("\n") + "\n");
    assert.strictEqual(parser.getConversationId(), "conv-unit-001");
    assert.strictEqual(parser.getCleanOutput().trim(), "SDK_OK_42");
    assert.ok(readable.includes("[sdk:tool] run_command (ACTIVE)"));
    const sources = updates.map((u) => u.source);
    assert.ok(sources.includes("sdk_init"));
    assert.ok(sources.includes("sdk_future_unknown_event_v2"), "Should tolerate unknown future event");
    assert.ok(sources.includes("sdk_thinking"));
    assert.ok(sources.includes("sdk_tool:run_command"));
    assert.ok(sources.includes("sdk_response"));
    assert.ok(sources.includes("sdk_result"));
    console.log("✅ [Unit] AgySdkStreamParser fault tolerance & unknown event handling passed");
  }

  // Setup isolated test bridge root
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-agy-sdk-test-"));
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

  // =========================================================================
  // Scenario 1: Real `agy` session continuation (`--continue` / `session_id` -> `--resume`)
  // =========================================================================
  {
    const sessionKey = "sess_continue_verify_01";
    const task1 = "task_agy_sdk_turn1";
    const task1Md = `# Task ${task1}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
- **Account**: 634401641@qq.com
- **Session ID**: ${sessionKey}
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

    // Turn 2: Resume the same session via Session ID -> worker injects `--conversation <convId1>`
    const task2 = "task_agy_sdk_turn2";
    const task2Md = `# Task ${task2}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
- **Account**: 634401641@qq.com
- **Session ID**: ${sessionKey}
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
    console.log(`✅ [Scenario 1/4] Real agy session continuation (--conversation / --continue) verified: convId=${convId1}`);
  }

  // =========================================================================
  // Scenario 2: Real `agy` Cancellation (`cancel_task`) -> `cancelled` without reverting to `running`
  // =========================================================================
  {
    const taskCancel = "task_agy_sdk_cancel_03";
    const taskCancelMd = `# Task ${taskCancel}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
- **Account**: 634401641@qq.com
- **Notify**: false

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
    console.log(`✅ [Scenario 2/4] Real agy cancellation verified: terminal state=${stCancel?.state} (never reverted to running)`);
  }

  // =========================================================================
  // Scenario 4: Long Silence / No Events -> Stuck Detection Fires Accurately
  // =========================================================================
  {
    const hangScript = path.join(tmpRoot, "mock-agy-hang.sh");
    fs.writeFileSync(
      hangScript,
      `#!/usr/bin/env bash
echo '{"event":"init","conversation_id":"conv-hang-999","init":{"cwd":"/tmp","permission_mode":"always-proceed"}}'
sleep 5
echo '{"event":"result","result":{"conversation_id":"conv-hang-999","status":"SUCCESS","response":"DONE_AFTER_HANG"}}'
`,
      { mode: 0o755 }
    );

    const hangRegistry: AgentRegistry = {
      ...registry,
      "agy-sdk": {
        command: hangScript,
        args: ["--output-format", "stream-json"],
        input: "stdin",
      },
    };

    const prevStuckMs = process.env.AGENT_BRIDGE_STUCK_MS;
    const prevNotify = process.env.AGENT_BRIDGE_NOTIFY;
    process.env.AGENT_BRIDGE_STUCK_MS = "1500";
    process.env.AGENT_BRIDGE_NOTIFY = "0";

    const taskHang = "task_agy_sdk_hang_04";
    const taskHangMd = `# Task ${taskHang}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
- **Notify**: true
- **Notify On**: stuck,completed

## Prompt
Test long silence stuck detection.
`;
    fs.writeFileSync(path.join(tasksDir, `${taskHang}.md`), taskHangMd, "utf8");

    let observedIdleDuringHang = false;
    let observedStuckWarnLog = false;
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      const s = String(chunk);
      if (s.includes(`Task ${taskHang} has produced no output or progress`)) {
        observedStuckWarnLog = true;
      }
      return origStderrWrite(chunk, ...args);
    }) as any;

    const checkTimer = setInterval(() => {
      const st = readStatus(tmpRoot, taskHang);
      if (st && st.state === "running" && st.idle_seconds !== undefined && st.idle_seconds >= 1) {
        observedIdleDuringHang = true;
      }
    }, 300);

    await processTaskFile(`${taskHang}.md`, tasksDir, resultsDir, processedMap, hangRegistry, 60000, tmpRoot);
    clearInterval(checkTimer);
    process.stderr.write = origStderrWrite;

    if (prevStuckMs === undefined) delete process.env.AGENT_BRIDGE_STUCK_MS;
    else process.env.AGENT_BRIDGE_STUCK_MS = prevStuckMs;
    if (prevNotify === undefined) delete process.env.AGENT_BRIDGE_NOTIFY;
    else process.env.AGENT_BRIDGE_NOTIFY = prevNotify;

    assert.strictEqual(
      observedStuckWarnLog,
      true,
      "Worker should emit stuck warning when no stream-json events arrive"
    );
    assert.strictEqual(observedIdleDuringHang, true, "Status should report idle_seconds >= 1 during silent hang");
    console.log(`✅ [Scenario 4/4] Long silence / no events stuck detection verified`);
  }

  // =========================================================================
  // Scenario 2: Quota Exhaustion -> `paused_quota` + stashed session context (run last so it doesn't pause the active test account)
  // =========================================================================
  {
    const quotaScript = path.join(tmpRoot, "mock-agy-quota.sh");
    fs.writeFileSync(
      quotaScript,
      `#!/usr/bin/env bash
echo '{"event":"init","conversation_id":"conv-quota-888","init":{"cwd":"/tmp","permission_mode":"always-proceed"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-quota-888","step_index":1,"state":"ERROR","step_type":"agent_response","error_message":"RESOURCE_EXHAUSTED: You have exhausted your capacity on this model (429). Quota will reset at 2026-11-01T08:00:00Z"}}'
echo '{"event":"result","result":{"conversation_id":"conv-quota-888","status":"ERROR","finished_reason":"error","error":"RESOURCE_EXHAUSTED: You have exhausted your capacity on this model (429)."}}'
exit 1
`,
      { mode: 0o755 }
    );

    const quotaRegistry: AgentRegistry = {
      ...registry,
      "agy-sdk": {
        command: quotaScript,
        args: ["--output-format", "stream-json"],
        input: "stdin",
      },
    };

    const taskQuota = "task_agy_sdk_quota_02";
    const taskQuotaMd = `# Task ${taskQuota}
- **Agent**: agy-sdk
- **Model**: gemini-3.8-flash-low
- **Notify**: false

## Prompt
Run quota test.
`;
    fs.writeFileSync(path.join(tasksDir, `${taskQuota}.md`), taskQuotaMd, "utf8");
    await processTaskFile(`${taskQuota}.md`, tasksDir, resultsDir, processedMap, quotaRegistry, 60000, tmpRoot);

    const stQuota = readStatus(tmpRoot, taskQuota);
    assert.strictEqual(stQuota?.state, "paused_quota", `Expected paused_quota, got ${stQuota?.state} (${stQuota?.reason})`);
    assert.strictEqual(stQuota?.sessionId, "conv-quota-888", "Should preserve conversation_id from init event on quota pause");
    assert.strictEqual(stQuota?.activity_source, "sdk_error");
    console.log(`✅ [Scenario 2/4] Quota exhaustion verified: state=${stQuota?.state}, sessionId=${stQuota?.sessionId}`);
  }

  console.log("=== All 4 agy-sdk real & fault-tolerance scenarios passed! ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
