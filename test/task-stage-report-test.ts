import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  deriveStage,
  parseAndValidateTaskReport,
  readOrFallbackTaskReport,
  getTaskReportDir,
  recordCallbackResult,
  computeSystemIssues,
} from "../src/task-stage.js";
import { createBridgeMcpServer } from "../src/server.js";
import { processTaskFile } from "../src/worker.js";
import { startHttpServer } from "../src/http-server.js";
import { ActionHomeView, buildHomePageViewModel } from "../web/src/components/ActionHomeView.js";
import { useAppStore } from "../web/src/stores/appStore.js";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.node.js";

async function runTests() {
  console.log("=== Running Task Stage, Report.json & Home Console Test Suite ===");

  // =========================================================================
  // 1. deriveStage: Every branch tested + strict priority ordering
  // =========================================================================
  console.log("1. Testing deriveStage across all 8 branches & priority order...");

  // Branch 1: needs_human/failed (failed/timeout 且无后续输入)
  assert.equal(
    deriveStage({ state: "failed", hasFollowUp: false }),
    "needs_human/failed",
    "failed without follow-up should be needs_human/failed"
  );
  assert.equal(
    deriveStage({ state: "failed", reason: "timeout" }),
    "needs_human/failed",
    "timeout without follow-up should be needs_human/failed"
  );
  assert.equal(
    deriveStage({ status: "timeout" }),
    "needs_human/failed",
    "status=timeout without follow-up should be needs_human/failed"
  );
  // Priority check: failed without follow-up beats question & review
  assert.equal(
    deriveStage({
      state: "failed",
      hasFollowUp: false,
      report: {
        outcome: "ready",
        pr_url: "https://github.com/org/repo/pull/1",
        question: "Should I retry?",
        summary: "failed",
      },
    }),
    "needs_human/failed",
    "needs_human/failed has highest priority over answer/review"
  );
  // When failed HAS follow-up input, it should NOT match needs_human/failed (falls through to done)
  assert.equal(
    deriveStage({ state: "failed", hasFollowUp: true }),
    "done",
    "failed with hasFollowUp=true should fall through to done"
  );

  // Branch 2: needs_human/quota (paused_quota)
  assert.equal(
    deriveStage({ state: "paused_quota" }),
    "needs_human/quota",
    "paused_quota should be needs_human/quota"
  );
  // Priority check: paused_quota beats question/review
  assert.equal(
    deriveStage({
      state: "paused_quota",
      report: {
        outcome: "ready",
        pr_url: "https://github.com/org/repo/pull/2",
        question: "Which account?",
        summary: "paused",
      },
    }),
    "needs_human/quota",
    "needs_human/quota beats answer and review"
  );

  // Branch 3: needs_human/stalled (suspected_stalled)
  assert.equal(
    deriveStage({ state: "suspected_stalled" }),
    "needs_human/stalled",
    "suspected_stalled should be needs_human/stalled"
  );
  // Priority check: suspected_stalled beats answer/review/working
  assert.equal(
    deriveStage({
      state: "suspected_stalled",
      status: "running",
      report: {
        outcome: "blocked",
        pr_url: null,
        question: "Stuck question?",
        summary: "stalled",
      },
    }),
    "needs_human/stalled",
    "needs_human/stalled beats answer and working"
  );

  // Branch 4: needs_human/answer (report.question 非空)
  assert.equal(
    deriveStage({
      state: "completed",
      report: {
        outcome: "blocked",
        pr_url: "https://github.com/org/repo/pull/3",
        question: "Should we use Redis or SQLite for caching?",
        summary: "Need architecture decision",
      },
    }),
    "needs_human/answer",
    "non-empty report.question should be needs_human/answer"
  );
  // Priority check: non-empty question beats needs_human/review even if outcome=ready & pr_url present
  assert.equal(
    deriveStage({
      state: "completed",
      report: {
        outcome: "ready",
        pr_url: "https://github.com/org/repo/pull/4",
        question: "Please confirm migration SQL before merge",
        summary: "PR ready with question",
      },
      pr_open: true,
    }),
    "needs_human/answer",
    "needs_human/answer beats needs_human/review"
  );

  // Branch 5: needs_human/review (outcome=ready 且有 pr_url 且 PR open)
  assert.equal(
    deriveStage({
      state: "completed",
      report: {
        outcome: "ready",
        pr_url: "https://github.com/org/repo/pull/42",
        question: null,
        summary: "Implemented feature and opened PR #42",
      },
      pr_open: true,
    }),
    "needs_human/review",
    "outcome=ready + pr_url + pr_open=true should be needs_human/review"
  );
  // When PR is closed or merged, it should NOT be needs_human/review -> falls through to done
  assert.equal(
    deriveStage({
      state: "completed",
      report: {
        outcome: "ready",
        pr_url: "https://github.com/org/repo/pull/42",
        question: null,
        summary: "Merged PR #42",
      },
      pr_open: false,
    }),
    "done",
    "outcome=ready + pr_url with pr_open=false should fall through to done"
  );
  assert.equal(
    deriveStage({
      state: "completed",
      outcome: "ready",
      pr_url: "https://github.com/org/repo/pull/42",
      pr_state: "merged",
    }),
    "done",
    "outcome=ready + pr_url with pr_state=merged should fall through to done"
  );

  // Branch 6: queued
  assert.equal(
    deriveStage({ state: "queued" }),
    "queued",
    "state=queued should be queued"
  );
  assert.equal(
    deriveStage({ status: "paused" }),
    "queued",
    "status=paused (queue paused) should be queued"
  );

  // Branch 7: working
  assert.equal(
    deriveStage({ state: "running" }),
    "working",
    "state=running should be working"
  );

  // Branch 8: done
  assert.equal(
    deriveStage({
      state: "completed",
      report: {
        outcome: "ready",
        pr_url: null,
        question: null,
        summary: "Completed task without PR",
      },
    }),
    "done",
    "completed without PR or question should be done"
  );
  assert.equal(
    deriveStage({ state: "cancelled" }),
    "done",
    "cancelled should be done"
  );

  console.log("   ✓ All 8 deriveStage branches and priority order verified.");

  // =========================================================================
  // 2. report.json: Valid / Missing / Invalid cases + End-to-End Worker & Callback
  // =========================================================================
  console.log("2. Testing report.json (valid / missing / invalid) and Worker + MCP + HTTP integration...");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stage-report-test-"));
  const tasksDir = path.join(tmpRoot, "tasks");
  const resultsDir = path.join(tmpRoot, "results");
  const logsDir = path.join(tmpRoot, "logs");
  const statusDir = path.join(tmpRoot, "status");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(statusDir, { recursive: true });

  // 2a. Unit validation of parseAndValidateTaskReport & readOrFallbackTaskReport
  const validDir = getTaskReportDir(tmpRoot, "unit_valid");
  fs.mkdirSync(validDir, { recursive: true });
  fs.writeFileSync(
    path.join(validDir, "report.json"),
    JSON.stringify({
      outcome: "ready",
      pr_url: "https://github.com/org/repo/pull/88",
      question: null,
      summary: "All tests pass and PR #88 is open.",
    }),
    "utf8"
  );
  const resValid = readOrFallbackTaskReport(validDir, {
    state: "completed",
    prUrl: null,
    summaryText: "fallback text",
  });
  assert.equal(resValid.report_source, "report_json");
  assert.equal(resValid.report.outcome, "ready");
  assert.equal(resValid.report.pr_url, "https://github.com/org/repo/pull/88");
  assert.equal(resValid.report.question, null);

  // Missing report.json -> fallback heuristic
  const missingDir = getTaskReportDir(tmpRoot, "unit_missing");
  const resMissing = readOrFallbackTaskReport(missingDir, {
    state: "completed",
    prUrl: "https://github.com/org/repo/pull/99",
    summaryText: "Heuristic summary from stdout",
  });
  assert.equal(resMissing.report_source, "heuristic");
  assert.equal(resMissing.report.outcome, "ready");
  assert.equal(resMissing.report.pr_url, "https://github.com/org/repo/pull/99");
  assert.equal(resMissing.report.summary, "Heuristic summary from stdout");

  // Invalid report.json (bad outcome / summary > 500 chars / malformed JSON) -> fallback heuristic
  const invalidDir = getTaskReportDir(tmpRoot, "unit_invalid");
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(
    path.join(invalidDir, "report.json"),
    JSON.stringify({
      outcome: "invalid_enum_value",
      pr_url: 12345,
      question: null,
      summary: "x".repeat(505),
    }),
    "utf8"
  );
  const resInvalid = readOrFallbackTaskReport(invalidDir, {
    state: "completed",
    prUrl: "https://github.com/org/repo/pull/100",
    summaryText: "Fallback after invalid schema",
  });
  assert.equal(resInvalid.report_source, "heuristic");
  assert.ok(resInvalid.validation_error);
  assert.equal(resInvalid.report.pr_url, "https://github.com/org/repo/pull/100");

  // Over-500-char summary rejected by parseAndValidateTaskReport
  const tooLongCheck = parseAndValidateTaskReport(
    JSON.stringify({
      outcome: "ready",
      pr_url: null,
      question: null,
      summary: "字".repeat(501),
    })
  );
  assert.equal(tooLongCheck.valid, false);

  // 2b. End-to-end Worker execution with mock agent scripts + callback receiver
  const receivedCallbacks: any[] = [];
  const cbServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        receivedCallbacks.push(JSON.parse(body));
      } catch {}
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => cbServer.listen(0, "127.0.0.1", () => resolve()));
  const cbPort = (cbServer.address() as any).port;
  const callbackUrl = `http://127.0.0.1:${cbPort}/cb`;

  // Create mock agent script that inspects prompt & writes $TASK_DIR/report.json depending on prompt instructions
  const mockAgentScript = path.join(tmpRoot, "mock-agent.mjs");
  fs.writeFileSync(
    mockAgentScript,
    `import fs from "node:fs";
import path from "node:path";

let prompt = process.argv.slice(2).join(" ");
const taskDir = process.env.TASK_DIR;

if (prompt.includes("CASE_VALID_REPORT")) {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "report.json"),
    JSON.stringify({
      outcome: "blocked",
      pr_url: "https://github.com/org/repo/pull/201",
      question: "Should we target develop or main?",
      summary: "Waiting for branch confirmation.",
    }),
    "utf8"
  );
  console.log("Agent wrote valid report.json");
} else if (prompt.includes("CASE_INVALID_REPORT")) {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "report.json"), "{corrupted json", "utf8");
  console.log("Created PR https://github.com/org/repo/pull/202 successfully.");
} else if (prompt.includes("CASE_MISSING_REPORT")) {
  console.log("Done work and opened https://github.com/org/repo/pull/203");
}
`,
    "utf8"
  );

  const registry = {
    "mock-agent": {
      command: process.execPath,
      args: [mockAgentScript],
      input: "arg" as const,
    },
  };
  fs.writeFileSync(path.join(tmpRoot, "agents.json"), JSON.stringify(registry, null, 2), "utf8");

  // Setup MCP Client to test send_task, get_task_status, list_tasks_summary, list_recent_tasks
  process.env.AGENT_BRIDGE_SKIP_MODEL_VALIDATION = "1";
  const mcpInstance = createBridgeMcpServer(tmpRoot);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await mcpInstance.server.connect(serverTransport);
  await client.connect(clientTransport);

  const processedMap: Record<string, string> = {};

  // Dispatch 3 tasks via send_task
  for (const label of ["CASE_VALID_REPORT", "CASE_INVALID_REPORT", "CASE_MISSING_REPORT"]) {
    const res = await client.callTool({
      name: "send_task",
      arguments: {
        prompt: `Run ${label}`,
        agent: "mock-agent",
        callback_url: callbackUrl,
      },
    });
    const text = (res.content as any)[0].text as string;
    const m = text.match(/task_id:\s*([^\s\r\n]+)/);
    assert.ok(m, `send_task should return task_id for ${label}`);
    const tid = m![1];

    // Verify prompt in tasks/<tid>.md ends with $TASK_DIR/report.json requirement
    const taskMd = fs.readFileSync(path.join(tasksDir, `${tid}.md`), "utf8");
    assert.ok(
      taskMd.includes("$TASK_DIR/report.json"),
      "Dispatched task file must instruct agent to write $TASK_DIR/report.json"
    );

    const ran = await processTaskFile(
      `${tid}.md`,
      tasksDir,
      resultsDir,
      processedMap,
      registry,
      30000,
      tmpRoot
    );
    assert.equal(ran, true);
  }

  // Wait briefly for async completion callbacks
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(receivedCallbacks.length, 3, "All 3 completion callbacks should be delivered");

  // Check callback payloads
  const cbValid = receivedCallbacks.find((c) => c.pr_url === "https://github.com/org/repo/pull/201");
  assert.ok(cbValid, "Callback for valid report.json should carry pr_url from report.json");
  assert.equal(cbValid.status, "completed");
  assert.equal(cbValid.outcome, "blocked");
  assert.equal(cbValid.question, "Should we target develop or main?");
  assert.equal(cbValid.stage, "needs_human/answer");

  const cbInvalid = receivedCallbacks.find((c) => c.pr_url === "https://github.com/org/repo/pull/202");
  assert.ok(cbInvalid, "Callback for invalid report.json should fallback to heuristic PR URL");
  assert.equal(cbInvalid.status, "completed");
  assert.equal(cbInvalid.outcome, "ready");
  assert.equal(cbInvalid.stage, "needs_human/review");

  const cbMissing = receivedCallbacks.find((c) => c.pr_url === "https://github.com/org/repo/pull/203");
  assert.ok(cbMissing, "Callback for missing report.json should fallback to heuristic PR URL");
  assert.equal(cbMissing.stage, "needs_human/review");

  // Verify get_task_status, list_tasks_summary, list_recent_tasks include stage & preserve legacy status/state
  const statusToolRes = await client.callTool({
    name: "get_task_status",
    arguments: { task_id: cbValid.task_id },
  });
  const statusJson = JSON.parse((statusToolRes.content as any)[0].text);
  assert.equal(statusJson.state, "completed", "Legacy state field preserved");
  assert.equal(statusJson.stage, "needs_human/answer");
  assert.equal(statusJson.report_source, "report_json");
  assert.equal(statusJson.question, "Should we target develop or main?");

  const statusInvalidRes = await client.callTool({
    name: "get_task_status",
    arguments: { task_id: cbInvalid.task_id },
  });
  const statusInvalidJson = JSON.parse((statusInvalidRes.content as any)[0].text);
  assert.equal(statusInvalidJson.report_source, "heuristic");
  assert.equal(statusInvalidJson.stage, "needs_human/review");

  const summaryToolRes = await client.callTool({
    name: "list_tasks_summary",
    arguments: { limit: 10 },
  });
  const summaryList = JSON.parse((summaryToolRes.content as any)[0].text);
  assert.equal(summaryList.length, 3);
  for (const item of summaryList) {
    assert.ok(item.stage, "list_tasks_summary item must include stage");
    assert.ok(item.state, "list_tasks_summary item must preserve legacy state");
  }

  const recentToolRes = await client.callTool({
    name: "list_recent_tasks",
    arguments: { limit: 10 },
  });
  const recentList = JSON.parse((recentToolRes.content as any)[0].text);
  assert.equal(recentList.length, 3);
  for (const item of recentList) {
    assert.ok(item.stage, "list_recent_tasks item must include stage");
    assert.ok(item.status, "list_recent_tasks item must preserve legacy status");
  }

  // Test HTTP /api/tasks endpoint
  const httpHandle = await startHttpServer({ port: 0, host: "127.0.0.1", customRootDir: tmpRoot });
  try {
    const apiRes = await fetch(`http://127.0.0.1:${httpHandle.port}/api/tasks`);
    assert.equal(apiRes.status, 200);
    const apiData = (await apiRes.json()) as any;
    assert.equal(apiData.success, true);
    assert.equal(apiData.tasks.length, 3);
    assert.ok(apiData.tasks.every((t: any) => typeof t.stage === "string" && typeof t.status === "string"));
  } finally {
    await httpHandle.close();
  }

  await cbServer.close();
  console.log("   ✓ report.json (valid / invalid / missing), callbacks, MCP tools & /api/tasks verified.");

  // =========================================================================
  // 3. Home Console View Model & Empty State ("没有需要你处理的事")
  // =========================================================================
  console.log("3. Testing Home Console empty state, system issues >=3 threshold & badge invariants...");

  // 3a. Healthy empty state: only "done" tasks and < 3 consecutive failures -> shows ONLY "没有需要你处理的事"
  const healthyVm = buildHomePageViewModel(
    [
      { taskId: "t_done_1", status: "completed", stage: "done" },
      { taskId: "t_done_2", status: "cancelled", stage: "done" },
    ],
    [
      {
        id: "callback_failures",
        kind: "callback",
        title: "Callback transient error",
        detail: "1 failure (< 3 threshold)",
        consecutiveFailures: 2,
      },
    ]
  );
  assert.equal(healthyVm.isHealthyEmpty, true, "Should be in healthy empty state when no needs_human, <3 issues, no working/queued");
  assert.equal(healthyVm.emptyStateText, "没有需要你处理的事");
  assert.equal(healthyVm.showSystemIssuesBlock, false, "System issues block must be hidden when failures < 3");
  assert.equal(healthyVm.needsHumanBadgeCount, healthyVm.needsHumanTasks.length);
  assert.equal(healthyVm.systemIssuesBadgeCount, healthyVm.visibleSystemIssues.length);
  assert.equal(healthyVm.workingBadgeCount, healthyVm.workingAndQueuedTasks.length);

  // 3b. Render actual React <ActionHomeView /> in healthy state -> must ONLY render "没有需要你处理的事"
  const emptyHtml = renderToStaticMarkup(
    React.createElement(ActionHomeView, {
      onOpenDetails: () => {},
      onOpenLogs: () => {},
      onOpenRetry: () => {},
      tasksOverride: [{ taskId: "t_done_1", status: "completed", stage: "done" }],
      systemIssuesOverride: [
        {
          id: "callback_failures",
          kind: "callback",
          title: "Callback transient error",
          detail: "2 failures (< 3 threshold)",
          consecutiveFailures: 2,
        },
      ],
    })
  );
  assert.ok(emptyHtml.includes("没有需要你处理的事"), "Empty state HTML must display '没有需要你处理的事'");
  assert.ok(!emptyHtml.includes("home-system-issues-section"), "System issues block must be hidden when healthy");

  // 3c. Active state: verify badge counts strictly equal list lengths & >=3 consecutive failures shown
  recordCallbackResult(tmpRoot, false, "HTTP 502 Bad Gateway");
  recordCallbackResult(tmpRoot, false, "HTTP 502 Bad Gateway");
  assert.equal(
    computeSystemIssues(tmpRoot).length,
    0,
    "2 consecutive callback failures must NOT trigger system issue"
  );
  recordCallbackResult(tmpRoot, false, "HTTP 502 Bad Gateway");
  const issuesAfter3 = computeSystemIssues(tmpRoot);
  assert.equal(
    issuesAfter3.length,
    1,
    "3 consecutive callback failures MUST trigger system issue"
  );
  assert.equal(issuesAfter3[0].id, "callback_failures");
  assert.equal(issuesAfter3[0].consecutiveFailures, 3);

  const activeTasksList = [
    { taskId: "t_fail", status: "failed", stage: "needs_human/failed" as const, reason: "Unit test failure" },
    { taskId: "t_rev", status: "completed", stage: "needs_human/review" as const, pr_url: "https://github.com/o/r/pull/1" },
    { taskId: "t_work", status: "running", stage: "working" as const },
    { taskId: "t_queue", status: "queued", stage: "queued" as const },
    { taskId: "t_done", status: "completed", stage: "done" as const },
  ];
  const activeVm = buildHomePageViewModel(activeTasksList, issuesAfter3);
  assert.equal(activeVm.isHealthyEmpty, false);
  assert.equal(activeVm.needsHumanTasks.length, 2);
  assert.equal(activeVm.needsHumanBadgeCount, activeVm.needsHumanTasks.length);
  assert.equal(activeVm.showSystemIssuesBlock, true);
  assert.equal(activeVm.visibleSystemIssues.length, 1);
  assert.equal(activeVm.systemIssuesBadgeCount, activeVm.visibleSystemIssues.length);
  assert.equal(activeVm.workingAndQueuedTasks.length, 2);
  assert.equal(activeVm.workingBadgeCount, activeVm.workingAndQueuedTasks.length);

  // Render actual React <ActionHomeView /> in active state
  const activeHtml = renderToStaticMarkup(
    React.createElement(ActionHomeView, {
      onOpenDetails: () => {},
      onOpenLogs: () => {},
      onOpenRetry: () => {},
      tasksOverride: activeTasksList,
      systemIssuesOverride: issuesAfter3,
    })
  );
  assert.ok(activeHtml.includes("home-needs-human-section"), "Must render 待处理 block");
  assert.ok(activeHtml.includes("home-system-issues-section"), "Must render 系统问题 block when >= 3 failures");
  assert.ok(activeHtml.includes("home-working-section"), "Must render 执行中 block");
  assert.ok(activeHtml.includes("打开 PR"), "Must render direct action button 打开 PR");
  assert.ok(activeHtml.includes("重试"), "Must render direct action button 重试");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("   ✓ Home Console empty state ('没有需要你处理的事'), >=3 system issue threshold & badge invariants verified.");
  console.log("=== ALL TASK STAGE & REPORT TESTS PASSED ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
