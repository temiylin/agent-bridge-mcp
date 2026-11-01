import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgeMcpServer } from "../src/server.js";
import { readStatus } from "../src/status.js";
import { getPlan } from "../src/plans.js";

async function runTaskPrLinkageTests() {
  console.log("=================================================");
  console.log("      Task PR Linkage & Integration Tests        ");
  console.log("=================================================");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-task-pr-test-"));
  const registry = {
    codex: {
      command: process.execPath,
      args: ["-e", "console.log('mock codex done')"],
      input: "arg" as const,
    },
  };
  fs.writeFileSync(path.join(tmpRoot, "agents.json"), JSON.stringify(registry, null, 2), "utf8");

  const instance = createBridgeMcpServer(tmpRoot);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    instance.server.connect(serverTransport),
  ]);

  try {
    // 1. send_task with pr_url
    console.log("\n[Test 1] Testing send_task with pr_url parameter...");
    const sendRes: any = await client.callTool({
      name: "send_task",
      arguments: {
        agent: "codex",
        prompt: "Review PR diff and suggest improvements",
        pr_url: "https://github.com/temiylin/vision_hub/pull/88",
      },
    });
    assert.ok(!sendRes.isError, "send_task should succeed");
    const sendText = sendRes.content[0].text;
    assert.ok(sendText.includes("pr_url: https://github.com/temiylin/vision_hub/pull/88"));
    const taskIdMatch = sendText.match(/task_id:\s*([^\r\n]+)/);
    assert.ok(taskIdMatch);
    const taskId1 = taskIdMatch[1].trim();

    const taskFile1 = fs.readFileSync(path.join(tmpRoot, "tasks", `${taskId1}.md`), "utf8");
    assert.ok(taskFile1.includes("- **PR URL**: https://github.com/temiylin/vision_hub/pull/88"));

    const status1 = readStatus(tmpRoot, taskId1);
    assert.ok(status1);
    assert.equal(status1.pr_url, "https://github.com/temiylin/vision_hub/pull/88");
    assert.deepEqual(status1.pr_urls, ["https://github.com/temiylin/vision_hub/pull/88"]);
    console.log("✓ Test 1 passed: send_task recorded pr_url in task file and initial status.");

    // 2. send_task with both plan_id, step_id, and pr_url
    console.log("\n[Test 2] Testing send_task with plan step and pr_url...");
    const planRes: any = await client.callTool({
      name: "create_plan",
      arguments: {
        id: "plan_pr_test",
        title: "PR Feature Plan",
        steps: [
          { id: "step-pr-1", title: "Review Initial PR", detail: "Check review comments" },
        ],
      },
    });
    assert.ok(!planRes.isError);

    const sendPlanRes: any = await client.callTool({
      name: "send_task",
      arguments: {
        agent: "codex",
        plan_id: "plan_pr_test",
        step_id: "step-pr-1",
        prompt: "Check step PR review",
        pr_url: "https://github.com/temiylin/vision_hub/pull/99",
      },
    });
    assert.ok(!sendPlanRes.isError);

    const updatedPlan1 = getPlan(tmpRoot, "plan_pr_test");
    const step1 = updatedPlan1.steps.find((s) => s.id === "step-pr-1");
    assert.ok(step1);
    assert.ok(step1.pr_urls.includes("https://github.com/temiylin/vision_hub/pull/99"));
    console.log("✓ Test 2 passed: plan step pr_urls automatically updated on send_task.");

    // 3. enqueue_task with pr_url and check list_queue
    console.log("\n[Test 3] Testing enqueue_task with pr_url and list_queue...");
    const enqRes: any = await client.callTool({
      name: "enqueue_task",
      arguments: {
        session_id: "sess_pr_queue",
        prompt: "Queued PR task",
        options: {
          pr_url: "https://github.com/temiylin/vision_hub/pull/105",
        },
      },
    });
    assert.ok(!enqRes.isError);

    const listQueueRes: any = await client.callTool({
      name: "list_queue",
      arguments: {
        session_id: "sess_pr_queue",
      },
    });
    assert.ok(!listQueueRes.isError);
    const queueList = JSON.parse(listQueueRes.content[0].text);
    assert.equal(queueList.length, 1);
    assert.equal(queueList[0].pr_url, "https://github.com/temiylin/vision_hub/pull/105");
    console.log("✓ Test 3 passed: enqueue_task stores pr_url and list_queue displays it.");

    // 4. attach_pr_to_task tool on existing task
    console.log("\n[Test 4] Testing attach_pr_to_task tool on an existing task...");
    const sendRes4: any = await client.callTool({
      name: "send_task",
      arguments: {
        agent: "codex",
        prompt: "Task initially without PR",
        plan_id: "plan_pr_test",
        step_id: "step-pr-1",
      },
    });
    assert.ok(!sendRes4.isError);
    const taskId4 = sendRes4.content[0].text.match(/task_id:\s*([^\r\n]+)/)![1].trim();

    // Now call attach_pr_to_task
    const attachRes: any = await client.callTool({
      name: "attach_pr_to_task",
      arguments: {
        task_id: taskId4,
        pr_url: "https://github.com/temiylin/vision_hub/pull/200",
      },
    });
    assert.ok(!attachRes.isError);
    const attachOutput = JSON.parse(attachRes.content[0].text);
    assert.equal(attachOutput.success, true);
    assert.equal(attachOutput.task_id, taskId4);
    assert.equal(attachOutput.pr_url, "https://github.com/temiylin/vision_hub/pull/200");
    assert.equal(attachOutput.plan_updated, true);

    const status4 = readStatus(tmpRoot, taskId4);
    assert.ok(status4);
    assert.equal(status4.pr_url, "https://github.com/temiylin/vision_hub/pull/200");
    assert.ok(status4.pr_urls?.includes("https://github.com/temiylin/vision_hub/pull/200"));

    const taskFile4 = fs.readFileSync(path.join(tmpRoot, "tasks", `${taskId4}.md`), "utf8");
    assert.ok(taskFile4.includes("- **PR URL**: https://github.com/temiylin/vision_hub/pull/200"));

    const planAfterAttach = getPlan(tmpRoot, "plan_pr_test");
    const stepAfter = planAfterAttach.steps.find((s) => s.id === "step-pr-1");
    assert.ok(stepAfter?.pr_urls.includes("https://github.com/temiylin/vision_hub/pull/200"));
    console.log("✓ Test 4 passed: attach_pr_to_task updated task status, task markdown, and plan step.");

    // 5. save_requirement with pr_url and dispatch_requirement
    console.log("\n[Test 5] Testing save_requirement with pr_url and dispatch_requirement...");
    const saveReqRes: any = await client.callTool({
      name: "save_requirement",
      arguments: {
        project: "vision_hub",
        title: "PR Bugfix Requirement",
        raw_text: "Fix broken button reported in PR",
        pr_url: "https://github.com/temiylin/vision_hub/pull/300",
      },
    });
    assert.ok(!saveReqRes.isError);
    const reqJson = JSON.parse(saveReqRes.content[0].text);

    const dispReqRes: any = await client.callTool({
      name: "dispatch_requirement",
      arguments: {
        id: reqJson.id,
      },
    });
    assert.ok(!dispReqRes.isError);
    const dispJson = JSON.parse(dispReqRes.content[0].text);
    assert.equal(dispJson.pr_url, "https://github.com/temiylin/vision_hub/pull/300");

    const reqTaskStatus = readStatus(tmpRoot, dispJson.task_id);
    assert.ok(reqTaskStatus);
    assert.equal(reqTaskStatus.pr_url, "https://github.com/temiylin/vision_hub/pull/300");
    console.log("✓ Test 5 passed: save_requirement and dispatch_requirement cleanly propagate pr_url.");

    console.log("\n🎉 ALL TASK PR LINKAGE TESTS PASSED!");
  } finally {
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTaskPrLinkageTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
