import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgySdkStreamParser,
  AgySdkActivityUpdate,
  isStrictAgyQuotaError,
  MAX_SDK_BUFFER_BYTES,
} from "../src/agy-sdk-stream.js";
import { processTaskFile } from "../src/worker.js";
import { readStatus } from "../src/status.js";
import { AgentRegistry } from "../src/agents.js";

async function runUnitTests() {
  console.log("=== Running agy-sdk Stream Unit & Mock Worker Tests ===");

  // 1. Parser: conversationId ONLY bound from `init`, unknown events tolerated
  {
    const updates: AgySdkActivityUpdate[] = [];
    const emittedEvents: Record<string, any>[] = [];
    const parser = new AgySdkStreamParser({
      onActivity: (u) => updates.push(u),
      onEvent: (_ev, compactLine) => emittedEvents.push(JSON.parse(compactLine)),
    });

    // Feed a step_update BEFORE init: should NOT bind conversationId
    parser.feedChunk(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "spoofed-before-init",
          step_index: 0,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "pre-",
        },
      }) + "\n"
    );
    assert.strictEqual(
      parser.getConversationId(),
      null,
      "conversationId must NOT be bound from step_update before init"
    );

    const streamLines = [
      "non-json-banner-line",
      JSON.stringify({
        event: "init",
        conversation_id: "conv-unit-001",
        init: { cwd: "/tmp", permission_mode: "always-proceed", future_field: 123 },
      }),
      JSON.stringify({
        event: "future_unknown_event_v2",
        conversation_id: "other-conv-id",
        nested: { foo: "bar" },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "other-conv-id",
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
          conversation_id: "other-conv-id",
          status: "SUCCESS",
          response: "SDK_OK_42\n",
          duration_seconds: 1.23,
        },
      }),
    ];

    const readable = parser.feedChunk(streamLines.join("\n") + "\n");
    assert.strictEqual(
      parser.getConversationId(),
      "conv-unit-001",
      "conversationId must stay bound strictly to init.conversation_id"
    );
    assert.strictEqual(parser.getCleanOutput().trim(), "SDK_OK_42");
    assert.ok(readable.includes("[sdk:tool] run_command (ACTIVE)"));
    const sources = updates.map((u) => u.source);
    assert.ok(sources.includes("sdk_init"));
    assert.ok(sources.includes("sdk_future_unknown_event_v2"), "Should tolerate unknown future event");
    assert.ok(sources.includes("sdk_thinking"));
    assert.ok(sources.includes("sdk_tool:run_command"));
    assert.ok(sources.includes("sdk_response"));
    assert.ok(sources.includes("sdk_result"));

    // Verify events.jsonl sanitization: pure text_delta / thinking_delta frames are skipped
    const stepEvents = emittedEvents.filter((e) => e.event === "step_update");
    assert.strictEqual(
      stepEvents.length,
      1,
      "Pure text_delta and thinking_delta frames should be skipped in events.jsonl"
    );
    assert.strictEqual(stepEvents[0].step_update?.step_type, "tool_call");
    console.log("✅ [1/5] Parser init-only conversationId binding & events.jsonl delta stripping verified");
  }

  // 2. Memory bounds: textBuffer capped at 1MB, remainder > 1MB dropped
  {
    const parser = new AgySdkStreamParser();
    // Feed > 1.2MB without newline -> remainder should be dropped
    const hugeNoNewline = "x".repeat(MAX_SDK_BUFFER_BYTES + 200 * 1024);
    parser.feedChunk(hugeNoNewline);
    // Followed by a valid init event on a new line
    parser.feedChunk(
      "\n" +
        JSON.stringify({
          event: "init",
          conversation_id: "conv-after-huge-remainder",
        }) +
        "\n"
    );
    assert.strictEqual(
      parser.getConversationId(),
      "conv-after-huge-remainder",
      "Parser should recover cleanly after dropping >1MB remainder"
    );

    // Feed 1.5MB of text_delta chunks -> getCleanOutput() capped at <= 1MB
    const chunkStr = "A".repeat(128 * 1024);
    for (let i = 0; i < 12; i++) {
      parser.feedChunk(
        JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: i + 1,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: chunkStr,
          },
        }) + "\n"
      );
    }
    const cleanLen = Buffer.byteLength(parser.getCleanOutput(), "utf8");
    assert.ok(
      cleanLen <= MAX_SDK_BUFFER_BYTES,
      `Expected textBuffer <= ${MAX_SDK_BUFFER_BYTES} bytes, got ${cleanLen}`
    );
    console.log(`✅ [2/5] Memory caps verified (cleanOutput=${cleanLen} bytes <= 1MB, >1MB remainder dropped)`);
  }

  // 3. Narrow isQuotaError: bare "429" and generic "rate limit" do NOT match
  {
    assert.strictEqual(
      isStrictAgyQuotaError(1, "HTTP 429 Too Many Requests: transient rate limit reached, retry in 2s"),
      false,
      "Bare 429 and transient rate limit must NOT be classified as quota exhaustion"
    );
    assert.strictEqual(
      isStrictAgyQuotaError(1, "Error on line 429: rate limit check failed in test"),
      false,
      "Line number 429 or 'rate limit' text must NOT be classified as quota exhaustion"
    );
    assert.strictEqual(
      isStrictAgyQuotaError(3, ""),
      false,
      "exitCode 3 with empty text must NOT be classified as quota exhaustion"
    );
    assert.strictEqual(
      isStrictAgyQuotaError(3, "Connection reset by peer"),
      false,
      "exitCode 3 without quota wording must NOT be classified as quota exhaustion"
    );
    assert.strictEqual(
      isStrictAgyQuotaError(1, "RESOURCE_EXHAUSTED: You have exhausted your capacity on this model."),
      true,
      "RESOURCE_EXHAUSTED must be recognized as quota exhaustion"
    );
    assert.strictEqual(
      isStrictAgyQuotaError(3, "Individual quota reached for this billing cycle."),
      true,
      "exitCode 3 with non-empty quota text must be recognized as quota exhaustion"
    );
    console.log("✅ [3/5] Strict isQuotaError unit checks passed (bare 429 / rate limit rejected)");
  }

  // Setup isolated test bridge root for mock worker tests
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-agy-sdk-unit-"));
  const tasksDir = path.join(tmpRoot, "tasks");
  const resultsDir = path.join(tmpRoot, "results");
  const logsDir = path.join(tmpRoot, "logs");
  const statusDir = path.join(tmpRoot, "status");
  const controlDir = path.join(tmpRoot, "control");
  for (const d of [tasksDir, resultsDir, logsDir, statusDir, controlDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const processedMap: Record<string, string> = {};

  // 4. Worker test: bare 429 / rate limit fails normally (NOT paused_quota), while RESOURCE_EXHAUSTED -> paused_quota
  {
    const rateLimitScript = path.join(tmpRoot, "mock-agy-ratelimit.sh");
    fs.writeFileSync(
      rateLimitScript,
      `#!/usr/bin/env bash
echo '{"event":"init","conversation_id":"conv-ratelimit-429","init":{"cwd":"/tmp","permission_mode":"always-proceed"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-ratelimit-429","step_index":1,"state":"ERROR","step_type":"agent_response","error_message":"HTTP 429: Rate limit reached per minute, please retry shortly."}}'
echo '{"event":"result","result":{"conversation_id":"conv-ratelimit-429","status":"ERROR","finished_reason":"error","error":"HTTP 429: Rate limit reached per minute"}}'
exit 1
`,
      { mode: 0o755 }
    );

    const quotaScript = path.join(tmpRoot, "mock-agy-quota.sh");
    fs.writeFileSync(
      quotaScript,
      `#!/usr/bin/env bash
echo '{"event":"init","conversation_id":"conv-quota-888","init":{"cwd":"/tmp","permission_mode":"always-proceed"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-quota-888","step_index":1,"state":"ERROR","step_type":"agent_response","error_message":"RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Quota will reset at 2026-11-01T08:00:00Z"}}'
echo '{"event":"result","result":{"conversation_id":"conv-quota-888","status":"ERROR","finished_reason":"error","error":"RESOURCE_EXHAUSTED: You have exhausted your capacity on this model."}}'
exit 1
`,
      { mode: 0o755 }
    );

    const registry: AgentRegistry = {
      "agy-sdk-mock": {
        command: rateLimitScript,
        args: ["--output-format", "stream-json"],
        input: "stdin",
      },
    };

    const task429 = "task_agy_sdk_429_transient";
    fs.writeFileSync(
      path.join(tasksDir, `${task429}.md`),
      `# Task ${task429}\n- **Agent**: agy-sdk-mock\n- **Notify**: false\n\n## Prompt\nTest 429 rate limit.\n`,
      "utf8"
    );
    await processTaskFile(`${task429}.md`, tasksDir, resultsDir, processedMap, registry, 60000, tmpRoot);
    const st429 = readStatus(tmpRoot, task429);
    assert.strictEqual(
      st429?.state,
      "failed",
      `Expected transient 429 / rate limit to be 'failed', got '${st429?.state}'`
    );

    // Now test explicit RESOURCE_EXHAUSTED -> paused_quota
    registry["agy-sdk-mock"].command = quotaScript;
    const taskQuota = "task_agy_sdk_quota_strict";
    fs.writeFileSync(
      path.join(tasksDir, `${taskQuota}.md`),
      `# Task ${taskQuota}\n- **Agent**: agy-sdk-mock\n- **Notify**: false\n\n## Prompt\nTest strict quota.\n`,
      "utf8"
    );
    await processTaskFile(`${taskQuota}.md`, tasksDir, resultsDir, processedMap, registry, 60000, tmpRoot);
    const stQuota = readStatus(tmpRoot, taskQuota);
    assert.strictEqual(
      stQuota?.state,
      "paused_quota",
      `Expected RESOURCE_EXHAUSTED to be 'paused_quota', got '${stQuota?.state}'`
    );
    assert.strictEqual(stQuota?.sessionId, "conv-quota-888");
    console.log("✅ [4/5] Worker quota vs transient 429/rate-limit classification verified");
  }

  // 5. Event-only stuck detection: CPU continuously burns after `init` without new events -> triggers `stuck`
  {
    const cpuBurnScript = path.join(tmpRoot, "mock-agy-cpuburn.sh");
    fs.writeFileSync(
      cpuBurnScript,
      `#!/usr/bin/env bash
echo '{"event":"init","conversation_id":"conv-cpuburn-777","init":{"cwd":"/tmp","permission_mode":"always-proceed"}}'
# Burn CPU in a busy loop for ~3 seconds without emitting any stream-json events
node -e 'const end = Date.now() + 3200; let x = 0; while (Date.now() < end) { x += Math.sqrt(Math.random()); }'
echo '{"event":"result","result":{"conversation_id":"conv-cpuburn-777","status":"SUCCESS","response":"DONE_AFTER_CPU_BURN"}}'
`,
      { mode: 0o755 }
    );

    const cpuRegistry: AgentRegistry = {
      "agy-sdk-mock": {
        command: cpuBurnScript,
        args: ["--output-format", "stream-json"],
        input: "stdin",
      },
    };

    const prevSdkStuckMs = process.env.AGENT_BRIDGE_SDK_STUCK_MS;
    const prevNotify = process.env.AGENT_BRIDGE_NOTIFY;
    process.env.AGENT_BRIDGE_SDK_STUCK_MS = "1200";
    process.env.AGENT_BRIDGE_NOTIFY = "0";

    const taskCpuStuck = "task_agy_sdk_cpuburn_stuck";
    fs.writeFileSync(
      path.join(tasksDir, `${taskCpuStuck}.md`),
      `# Task ${taskCpuStuck}\n- **Agent**: agy-sdk-mock\n- **Notify**: true\n- **Notify On**: stuck,completed\n\n## Prompt\nTest CPU burn without SDK events.\n`,
      "utf8"
    );

    let observedStuckWarnLog = false;
    let observedCpuActivitySource = false;
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      const s = String(chunk);
      if (s.includes(`Task ${taskCpuStuck} has produced no output or progress`)) {
        observedStuckWarnLog = true;
      }
      return origStderrWrite(chunk, ...args);
    }) as any;

    const checkTimer = setInterval(() => {
      const st = readStatus(tmpRoot, taskCpuStuck);
      if (st?.activity_source === "cpu" || st?.activity_source === "workdir" || st?.activity_source === "session_log") {
        observedCpuActivitySource = true;
      }
    }, 200);

    await processTaskFile(`${taskCpuStuck}.md`, tasksDir, resultsDir, processedMap, cpuRegistry, 60000, tmpRoot);
    clearInterval(checkTimer);
    process.stderr.write = origStderrWrite;

    if (prevSdkStuckMs === undefined) delete process.env.AGENT_BRIDGE_SDK_STUCK_MS;
    else process.env.AGENT_BRIDGE_SDK_STUCK_MS = prevSdkStuckMs;
    if (prevNotify === undefined) delete process.env.AGENT_BRIDGE_NOTIFY;
    else process.env.AGENT_BRIDGE_NOTIFY = prevNotify;

    assert.strictEqual(
      observedCpuActivitySource,
      false,
      "stream-json mode must NEVER report cpu/workdir/session_log as activity_source"
    );
    assert.strictEqual(
      observedStuckWarnLog,
      true,
      "Worker must trigger stuck warning when no stream-json events arrive even if child CPU is burning"
    );
    console.log("✅ [5/6] Event-only stuck detection verified (CPU busy loop without events -> triggers stuck)");
  }

  // 6. Status write throttling: rapid token streaming writes status at most once per throttle window
  {
    const floodScript = path.join(tmpRoot, "mock-agy-flood.sh");
    fs.writeFileSync(
      floodScript,
      `#!/usr/bin/env bash
node -e '
  console.log(JSON.stringify({ event: "init", conversation_id: "conv-flood-100" }));
  for (let i = 1; i <= 50; i++) {
    console.log(JSON.stringify({
      event: "step_update",
      step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "token_" + i + " " }
    }));
  }
  console.log(JSON.stringify({ event: "result", result: { conversation_id: "conv-flood-100", status: "SUCCESS", response: "FLOOD_DONE" } }));
'
`,
      { mode: 0o755 }
    );

    const floodRegistry: AgentRegistry = {
      "agy-sdk-mock": {
        command: floodScript,
        args: ["--output-format", "stream-json"],
        input: "stdin",
      },
    };

    const taskFlood = "task_agy_sdk_status_throttle";
    fs.writeFileSync(
      path.join(tasksDir, `${taskFlood}.md`),
      `# Task ${taskFlood}\n- **Agent**: agy-sdk-mock\n- **Notify**: false\n\n## Prompt\nTest status write throttling.\n`,
      "utf8"
    );

    let statusWriteCount = 0;
    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = ((file: any, data: any, options?: any) => {
      if (typeof file === "string" && file.endsWith(`${taskFlood}.json.tmp`)) {
        statusWriteCount++;
      }
      return origWriteFileSync(file, data, options);
    }) as any;

    try {
      await processTaskFile(`${taskFlood}.md`, tasksDir, resultsDir, processedMap, floodRegistry, 60000, tmpRoot);
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }

    // 50 text_delta events in <1s with 5s throttle should NOT produce 50 status writes (expected ~5-6 writes total: start, spawn, init, first delta, result, final)
    assert.ok(
      statusWriteCount <= 10,
      `Expected status writes to be throttled (<= 10 writes for 50 rapid token deltas), got ${statusWriteCount}`
    );
    const eventsContent = fs.readFileSync(path.join(logsDir, `${taskFlood}.events.jsonl`), "utf8").trim().split("\n");
    assert.strictEqual(
      eventsContent.length,
      2,
      `Expected events.jsonl to only contain init + result (skipping 50 pure text_delta frames), got ${eventsContent.length}`
    );
    console.log(`✅ [6/6] Status write throttling (${statusWriteCount} writes for 50 tokens) & events.jsonl compaction (${eventsContent.length} lines) verified`);
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}

  console.log("=== All agy-sdk unit & mock worker tests passed! ===");
}

runUnitTests().catch((err) => {
  console.error("Unit test failed:", err);
  process.exit(1);
});
