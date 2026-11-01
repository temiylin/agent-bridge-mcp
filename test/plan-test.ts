import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPlan,
  getPlan,
  updatePlan,
  listPlans,
  setPlanStepStatus,
  archivePlan,
  formatPlanPromptPrefix,
  recordTaskResultInPlan,
  getPlanFilePath,
  getPlanArchiveDir,
} from "../src/plans.js";
import { createBridgeMcpServer } from "../src/server.js";
import { processTaskFile } from "../src/worker.js";
import { startHttpServer } from "../src/http-server.js";
import { writeStatus } from "../src/status.js";
import { sendCompletionCallback } from "../src/callback.js";

async function runTests() {
  console.log("=== Running Multi-Step Execution Plans (feat/plans) Test Suite ===");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-plan-test-"));
  const tasksDir = path.join(tmpRoot, "tasks");
  const resultsDir = path.join(tmpRoot, "results");
  const logsDir = path.join(tmpRoot, "logs");
  const statusDir = path.join(tmpRoot, "status");
  const plansDir = path.join(tmpRoot, "plans");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(statusDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });

  const registry = {
    codex: {
      command: process.execPath,
      args: ["-e", "console.log('mock agent done')"],
      input: "arg" as const,
    },
    agy: {
      command: process.execPath,
      args: ["-e", "console.log('mock agent done')"],
      input: "arg" as const,
    },
  };

  // agents.json
  fs.writeFileSync(path.join(tmpRoot, "agents.json"), JSON.stringify(registry, null, 2), "utf8");

  // Initialize MCP server & client
  const bridgeServer = createBridgeMcpServer(tmpRoot);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridgeServer.server.connect(serverTransport);
  const mcpClient = new Client({ name: "plan-test-client", version: "1.0.0" });
  await mcpClient.connect(clientTransport);

  try {
    // =========================================================================
    // 1. Plan creation, update, and automatic version increment
    // =========================================================================
    console.log("1. Testing createPlan, updatePlan, version increments & summaries...");
    const plan1 = createPlan(tmpRoot, {
      id: "plan_auth_refactor",
      title: "Auth Refactor Plan",
      project_id: "vision_hub",
      context: "Refactoring authentication to use JWT and refresh tokens.",
      steps: [
        { id: "step-1", title: "DB Schema", detail: "Add refresh_tokens table", status: "todo" },
        { id: "step-2", title: "API Endpoints", detail: "Implement /auth/refresh", status: "todo" },
      ],
    });

    assert.equal(plan1.id, "plan_auth_refactor");
    assert.equal(plan1.version, 1, "Initial plan version must be 1");
    assert.equal(plan1.steps.length, 2);
    assert.equal(plan1.steps[0].status, "todo");
    assert.deepEqual(plan1.steps[0].task_ids, []);

    // Fetch via getPlan
    const fetched1 = getPlan(tmpRoot, "plan_auth_refactor");
    assert.ok(fetched1);
    assert.equal(fetched1.title, "Auth Refactor Plan");

    // updatePlan increments version
    const updatedPlan = updatePlan(tmpRoot, "plan_auth_refactor", {
      context: "Updated context: Added redis session requirement.",
      steps: [
        { id: "step-1", title: "DB Schema Updated", detail: "Add refresh_tokens & redis session", status: "todo" },
        { id: "step-2", title: "API Endpoints", detail: "Implement /auth/refresh", status: "todo" },
        { id: "step-3", title: "Frontend Hook", detail: "Use token refresh interceptor", status: "todo" },
      ],
    });

    assert.equal(updatedPlan.version, 2, "Plan version must increment to 2 on update");
    assert.equal(updatedPlan.steps.length, 3);
    assert.equal(updatedPlan.context, "Updated context: Added redis session requirement.");

    // listPlans summary check
    const summaries = listPlans(tmpRoot, { projectId: "vision_hub" });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, "plan_auth_refactor");
    assert.equal(summaries[0].version, 2);
    assert.equal(summaries[0].total_steps, 3);
    assert.equal(summaries[0].completed_steps, 0);
    assert.equal(summaries[0].status_summary.todo, 3);

    // Filter by different project returns empty
    const otherProjSummaries = listPlans(tmpRoot, { projectId: "non_existent_project" });
    assert.equal(otherProjSummaries.length, 0);

    // =========================================================================
    // 2. Corrupt file write rejection + .bak retention
    // =========================================================================
    console.log("2. Testing corrupt plan file rejection and .bak backup preservation...");
    const corruptPlanId = "plan_corrupt_test";
    const corruptPlanFile = getPlanFilePath(tmpRoot, corruptPlanId);
    const corruptBakFile = `${corruptPlanFile}.bak`;

    // First create a valid plan
    createPlan(tmpRoot, {
      id: corruptPlanId,
      title: "Corrupt Test Plan",
      steps: [{ id: "step-1", title: "Initial Step" }],
    });
    assert.ok(fs.existsSync(corruptPlanFile));

    // Now corrupt the JSON file
    const originalCorruptContent = "{ invalid_json_syntax: true, ";
    fs.writeFileSync(corruptPlanFile, originalCorruptContent, "utf8");

    // Any attempt to update or set status inside lock must throw and refuse to overwrite
    assert.throws(
      () => {
        updatePlan(tmpRoot, corruptPlanId, { title: "Attempted Overwrite" });
      },
      /Failed to parse plan file|Invalid plan file/,
      "Must throw on unparseable plan file"
    );

    // Content of corrupt file must remain untouched
    const afterAttempt = fs.readFileSync(corruptPlanFile, "utf8");
    assert.equal(afterAttempt, originalCorruptContent, "Corrupt file must NOT be overwritten");

    // =========================================================================
    // 3. Non-existent plan or step rejection
    // =========================================================================
    console.log("3. Testing non-existent plan/step errors via MCP tools...");

    // Send task with non-existent plan
    const resBadPlan = (await mcpClient.callTool({
      name: "send_task",
      arguments: {
        prompt: "Run task",
        plan_id: "plan_does_not_exist",
        step_id: "step-1",
      },
    })) as any;
    assert.ok(resBadPlan.isError, "send_task must return isError for non-existent plan");
    assert.match(resBadPlan.content[0].text, /Plan "plan_does_not_exist" not found/);

    // Send task with existing plan but missing step_id
    const resMissingStepArg = (await mcpClient.callTool({
      name: "send_task",
      arguments: {
        prompt: "Run task",
        plan_id: "plan_auth_refactor",
      },
    })) as any;
    assert.ok(resMissingStepArg.isError);
    assert.match(resMissingStepArg.content[0].text, /step_id is required/);

    // Send task with existing plan but invalid step_id
    const resBadStep = (await mcpClient.callTool({
      name: "send_task",
      arguments: {
        prompt: "Run task",
        plan_id: "plan_auth_refactor",
        step_id: "step-999-missing",
      },
    })) as any;
    assert.ok(resBadStep.isError);
    assert.match(resBadStep.content[0].text, /Step "step-999-missing" not found/);

    // Send task with step_id but without plan_id
    const resStepWithoutPlan = (await mcpClient.callTool({
      name: "send_task",
      arguments: {
        prompt: "Run task",
        step_id: "step-1",
      },
    })) as any;
    assert.ok(resStepWithoutPlan.isError);
    assert.match(resStepWithoutPlan.content[0].text, /step_id cannot be specified without plan_id/);

    // Enqueue task validation
    const resEnqueueBadPlan = (await mcpClient.callTool({
      name: "enqueue_task",
      arguments: {
        session_id: "session_123",
        prompt: "Run queue task",
        plan_id: "plan_does_not_exist",
        step_id: "step-1",
      },
    })) as any;
    assert.ok(resEnqueueBadPlan.isError);
    assert.match(resEnqueueBadPlan.content[0].text, /Plan "plan_does_not_exist" not found/);

    // =========================================================================
    // 4. Prompt prefix formatting & >4000 char context truncation
    // =========================================================================
    console.log("4. Testing prompt prefix formatting and >4000 chars context truncation...");
    const planShort = {
      id: "plan_short",
      title: "Short Context Plan",
      version: 1,
      context: "This is a short background context.",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      steps: [{ id: "step-1", title: "Step 1", detail: "Detail for step 1", status: "todo" as const, task_ids: [], pr_urls: [] }],
    };
    const prefixShort = formatPlanPromptPrefix(tmpRoot, planShort, planShort.steps[0]);
    assert.ok(prefixShort.startsWith("# Plan: Short Context Plan (Step: Step 1)"));
    assert.ok(prefixShort.includes("This is a short background context."));
    assert.ok(prefixShort.includes("## Current Step: Step 1\nDetail for step 1"));

    // Long context (> 4000 characters)
    const longContext = "A".repeat(5000);
    const planLong = {
      id: "plan_long",
      title: "Long Context Plan",
      version: 1,
      context: longContext,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      steps: [{ id: "step-1", title: "Step 1", detail: "Step 1 details", status: "todo" as const, task_ids: [], pr_urls: [] }],
    };
    const prefixLong = formatPlanPromptPrefix(tmpRoot, planLong, planLong.steps[0]);
    assert.ok(prefixLong.includes("[Context truncated due to length. For the complete plan context and details, read the full plan file at:"));
    assert.ok(prefixLong.includes(getPlanFilePath(tmpRoot, "plan_long")));
    assert.ok(!prefixLong.includes("A".repeat(4500)), "Context in prompt must be truncated to 4000 chars");

    // =========================================================================
    // 5. Task dispatch and automatic completion writeback (done / failed / preserves skipped)
    // =========================================================================
    console.log("5. Testing task dispatch, status recording, and completion writeback...");

    const testPlanId = "plan_lifecycle";
    createPlan(tmpRoot, {
      id: testPlanId,
      title: "Lifecycle Plan",
      steps: [
        { id: "step-1", title: "Step 1 (Success)", detail: "Should complete successfully" },
        { id: "step-2", title: "Step 2 (Failure)", detail: "Should fail" },
        { id: "step-3", title: "Step 3 (Skipped)", detail: "Manually skipped", status: "skipped" },
      ],
    });

    // 5a: Dispatch task for step-1
    const sendTaskRes = (await mcpClient.callTool({
      name: "send_task",
      arguments: {
        agent: "codex",
        title: "Execute Step 1",
        prompt: "Perform DB migration",
        plan_id: testPlanId,
        step_id: "step-1",
      },
    })) as any;
    assert.ok(!sendTaskRes.isError);
    const taskId1 = sendTaskRes.content[0].text.match(/task_id:\s*([^\r\n]+)/)![1].trim();
    assert.ok(taskId1);

    // Verify task file has plan headers
    const taskContent1 = fs.readFileSync(path.join(tasksDir, `${taskId1}.md`), "utf8");
    assert.ok(taskContent1.includes(`- **Plan ID**: ${testPlanId}`));
    assert.ok(taskContent1.includes(`- **Plan Step ID**: step-1`));
    assert.ok(taskContent1.includes(`- **Plan Version**: 1`));
    assert.ok(taskContent1.includes(`- **Plan Title**: Lifecycle Plan`));
    assert.ok(taskContent1.includes(`# Plan: Lifecycle Plan (Step: Step 1 (Success))`));

    // Verify step status is marked in_progress on dispatch and task_id appended
    let curPlan = getPlan(tmpRoot, testPlanId)!;
    const s1 = curPlan.steps.find((s) => s.id === "step-1")!;
    assert.equal(s1.status, "in_progress", "Step must be in_progress after dispatch");
    assert.ok(s1.task_ids.includes(taskId1), "Step must include dispatched taskId");

    // Verify status file includes plan metadata
    const st1 = JSON.parse(fs.readFileSync(path.join(statusDir, `${taskId1}.json`), "utf8"));
    assert.equal(st1.plan_id, testPlanId);
    assert.equal(st1.step_id, "step-1");
    assert.equal(st1.plan_title, "Lifecycle Plan");

    // Query status via get_task_status tool
    const getStatusRes = (await mcpClient.callTool({
      name: "get_task_status",
      arguments: { task_id: taskId1 },
    })) as any;
    const queriedStatus1 = JSON.parse(getStatusRes.content[0].text);
    assert.equal(queriedStatus1.plan_id, testPlanId);
    assert.equal(queriedStatus1.step_id, "step-1");
    assert.equal(queriedStatus1.plan_title, "Lifecycle Plan");

    // Simulate task completion with report.json containing outcome: ready and pr_url
    const prUrl1 = "https://github.com/myorg/myrepo/pull/101";
    const reportDir1 = path.join(tmpRoot, "reports", taskId1);
    fs.mkdirSync(reportDir1, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir1, "report.json"),
      JSON.stringify({
        outcome: "ready",
        pr_url: prUrl1,
        question: null,
        summary: "Step 1 finished successfully.",
      })
    );

    // Run worker processTaskFile
    const processedMap: Record<string, string> = {};
    await processTaskFile(`${taskId1}.md`, tasksDir, resultsDir, processedMap, registry, 30000, tmpRoot);

    // Check plan writeback: step-1 must now be "done", with taskId and prUrl
    curPlan = getPlan(tmpRoot, testPlanId)!;
    const s1Done = curPlan.steps.find((s) => s.id === "step-1")!;
    assert.equal(s1Done.status, "done", "Successful task must update step status to done");
    assert.ok(s1Done.task_ids.includes(taskId1));
    assert.ok(s1Done.pr_urls.includes(prUrl1));

    // 5b: Dispatch task for step-2 and simulate failure
    const sendTaskRes2 = (await mcpClient.callTool({
      name: "send_task",
      arguments: {
        agent: "codex",
        title: "Execute Step 2",
        prompt: "Run failing task",
        plan_id: testPlanId,
        step_id: "step-2",
      },
    })) as any;
    const taskId2 = sendTaskRes2.content[0].text.match(/task_id:\s*([^\r\n]+)/)![1].trim();

    // Simulate task failure in report.json
    const reportDir2 = path.join(tmpRoot, "reports", taskId2);
    fs.mkdirSync(reportDir2, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir2, "report.json"),
      JSON.stringify({
        outcome: "failed",
        pr_url: null,
        question: null,
        summary: "Unit tests failed with exit code 1",
      })
    );

    await processTaskFile(`${taskId2}.md`, tasksDir, resultsDir, processedMap, registry, 30000, tmpRoot);

    // Check plan writeback: step-2 must now be "failed"
    curPlan = getPlan(tmpRoot, testPlanId)!;
    const s2Failed = curPlan.steps.find((s) => s.id === "step-2")!;
    assert.equal(s2Failed.status, "failed", "Failed task must update step status to failed");
    assert.ok(s2Failed.task_ids.includes(taskId2));

    // 5c: Preserving "skipped" status
    // Step 3 was explicitly skipped. Even if a result with state completed is reported for step 3,
    // recordTaskResultInPlan must NEVER overwrite 'skipped'.
    recordTaskResultInPlan(tmpRoot, {
      planId: testPlanId,
      stepId: "step-3",
      taskId: "task_random_999",
      state: "completed",
      prUrl: "https://github.com/myorg/myrepo/pull/103",
    });

    curPlan = getPlan(tmpRoot, testPlanId)!;
    const s3Skipped = curPlan.steps.find((s) => s.id === "step-3")!;
    assert.equal(s3Skipped.status, "skipped", "Task result must NOT overwrite manually set skipped status");
    assert.ok(s3Skipped.task_ids.includes("task_random_999"));
    assert.ok(s3Skipped.pr_urls.includes("https://github.com/myorg/myrepo/pull/103"));

    // =========================================================================
    // 6. Non-plan task backward compatibility
    // =========================================================================
    console.log("6. Testing backward compatibility when plan_id is omitted...");
    const sendLegacyRes = (await mcpClient.callTool({
      name: "send_task",
      arguments: {
        agent: "codex",
        title: "Legacy Task Without Plan",
        prompt: "Just do regular work without a plan",
      },
    })) as any;
    assert.ok(!sendLegacyRes.isError);
    const legacyTaskId = sendLegacyRes.content[0].text.match(/task_id:\s*([^\r\n]+)/)![1].trim();
    const legacyTaskContent = fs.readFileSync(path.join(tasksDir, `${legacyTaskId}.md`), "utf8");
    assert.ok(!legacyTaskContent.includes("**Plan ID**"), "Legacy task must not contain Plan ID header");
    assert.ok(!legacyTaskContent.includes("# Plan:"), "Legacy task must not contain plan prompt prefix");

    const legacyStatus = JSON.parse(fs.readFileSync(path.join(statusDir, `${legacyTaskId}.json`), "utf8"));
    assert.equal(legacyStatus.plan_id, undefined);
    assert.equal(legacyStatus.step_id, undefined);

    // =========================================================================
    // 7. Archive plan: refuse when active/running tasks exist, allow when done
    // =========================================================================
    console.log("7. Testing archive_plan refusals on active tasks & successful archive...");
    const activeTestPlanId = "plan_archive_check";
    createPlan(tmpRoot, {
      id: activeTestPlanId,
      title: "Archive Check Plan",
      steps: [{ id: "step-1", title: "Step 1" }],
    });

    // Write a running status file associated with activeTestPlanId
    const activeTaskId = "task_running_for_plan";
    writeStatus(tmpRoot, activeTaskId, {
      state: "running",
      plan_id: activeTestPlanId,
      step_id: "step-1",
      startedAt: new Date().toISOString(),
    });

    // Attempt to archive -> must refuse!
    const archiveRefuseRes = archivePlan(tmpRoot, activeTestPlanId);
    assert.equal(archiveRefuseRes.success, false);
    assert.match(archiveRefuseRes.error!, /Cannot archive plan.*currently running/);

    // Now mark task completed
    writeStatus(tmpRoot, activeTaskId, {
      state: "completed",
      plan_id: activeTestPlanId,
      step_id: "step-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    // Archiving should now succeed
    const archiveSuccessRes = archivePlan(tmpRoot, activeTestPlanId);
    assert.equal(archiveSuccessRes.success, true);
    assert.ok(!fs.existsSync(getPlanFilePath(tmpRoot, activeTestPlanId)), "Active plan file should be moved");
    assert.ok(
      fs.existsSync(path.join(getPlanArchiveDir(tmpRoot), `${activeTestPlanId}.json`)),
      "Archived plan file must exist under archive directory"
    );

    // =========================================================================
    // 8. Output extensions: list_tasks_summary, list_recent_tasks & callback
    // =========================================================================
    console.log("8. Testing output extensions in list_tasks_summary, list_recent_tasks & callback...");

    // list_tasks_summary
    const listSummaryRes = (await mcpClient.callTool({
      name: "list_tasks_summary",
      arguments: { plan_id: testPlanId },
    })) as any;
    const summariesList = JSON.parse(listSummaryRes.content[0].text);
    assert.ok(Array.isArray(summariesList));
    assert.ok(summariesList.length >= 2);
    for (const item of summariesList) {
      assert.equal(item.plan_id, testPlanId);
      assert.ok(item.step_id);
      assert.equal(item.plan_title, "Lifecycle Plan");
    }

    // list_recent_tasks
    const recentRes = (await mcpClient.callTool({
      name: "list_recent_tasks",
      arguments: { plan_id: testPlanId },
    })) as any;
    const recentTasks = JSON.parse(recentRes.content[0].text);
    assert.ok(Array.isArray(recentTasks));
    assert.ok(recentTasks.length >= 2);
    for (const item of recentTasks) {
      assert.equal(item.plan_id, testPlanId);
      assert.ok(item.step_id);
      assert.equal(item.plan_title, "Lifecycle Plan");
    }

    // Callback payload receives plan fields
    let receivedPayload: any = null;
    const dummyServer = http.createServer((req, res) => {
      let b = "";
      req.on("data", (chunk) => (b += chunk));
      req.on("end", () => {
        try {
          receivedPayload = JSON.parse(b);
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => dummyServer.listen(0, "127.0.0.1", () => resolve()));
    const dummyPort = (dummyServer.address() as any).port;

    await sendCompletionCallback({
      url: `http://127.0.0.1:${dummyPort}/cb`,
      taskId: taskId1,
      agent: "codex",
      status: "completed",
      exitCode: 0,
      durationSeconds: 10,
      resultPath: path.join(resultsDir, `${taskId1}.md`),
      logPath: path.join(logsDir, `${taskId1}.out`),
      planId: testPlanId,
      stepId: "step-1",
      planTitle: "Lifecycle Plan",
    });

    assert.ok(receivedPayload);
    assert.equal(receivedPayload.task_id, taskId1);
    assert.equal(receivedPayload.plan_id, testPlanId);
    assert.equal(receivedPayload.step_id, "step-1");
    assert.equal(receivedPayload.plan_title, "Lifecycle Plan");
    dummyServer.close();

    // =========================================================================
    // 9. HTTP REST API /api/plans
    // =========================================================================
    console.log("9. Testing HTTP REST /api/plans (GET, POST create/update/archive)...");
    const httpHandle = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      customRootDir: tmpRoot,
    });
    const baseHttp = `http://127.0.0.1:${httpHandle.port}`;

    try {
      // 9a: GET /api/plans
      const getRes = await fetch(`${baseHttp}/api/plans`);
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as any;
      assert.equal(getBody.success, true);
      assert.ok(Array.isArray(getBody.plans));

      // 9b: POST /api/plans action=create
      const postCreateRes = await fetch(`${baseHttp}/api/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          id: "plan_http_test",
          title: "HTTP Created Plan",
          context: "Created via REST API",
          steps: [{ id: "step-1", title: "API Step 1" }],
        }),
      });
      assert.equal(postCreateRes.status, 200);
      const postCreateBody = (await postCreateRes.json()) as any;
      assert.equal(postCreateBody.success, true);
      assert.equal(postCreateBody.plan.id, "plan_http_test");
      assert.equal(postCreateBody.plan.version, 1);

      // 9c: GET /api/plans?id=plan_http_test
      const getDetailRes = await fetch(`${baseHttp}/api/plans?id=plan_http_test`);
      assert.equal(getDetailRes.status, 200);
      const getDetailBody = (await getDetailRes.json()) as any;
      assert.equal(getDetailBody.success, true);
      assert.equal(getDetailBody.plan.title, "HTTP Created Plan");

      // 9d: POST /api/plans action=update
      const postUpdateRes = await fetch(`${baseHttp}/api/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: "plan_http_test",
          title: "HTTP Created Plan (Updated)",
        }),
      });
      assert.equal(postUpdateRes.status, 200);
      const postUpdateBody = (await postUpdateRes.json()) as any;
      assert.equal(postUpdateBody.success, true);
      assert.equal(postUpdateBody.plan.title, "HTTP Created Plan (Updated)");
      assert.equal(postUpdateBody.plan.version, 2);

      // 9e: POST /api/plans action=archive
      const postArchiveRes = await fetch(`${baseHttp}/api/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "archive",
          id: "plan_http_test",
        }),
      });
      assert.equal(postArchiveRes.status, 200);
      const postArchiveBody = (await postArchiveRes.json()) as any;
      assert.equal(postArchiveBody.success, true);
    } finally {
      await httpHandle.close();
    }

    console.log("=== All Multi-Step Execution Plans (feat/plans) Tests Passed Successfully! ===");
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
