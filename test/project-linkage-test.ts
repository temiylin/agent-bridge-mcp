import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createBridgeMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function runProjectLinkageTests() {
  console.log("=================================================");
  console.log("  Project Linkage & Auto-Inheritance Test Suite  ");
  console.log("=================================================");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-proj-link-test-"));
  const dummyGitRepo = path.join(tmpRoot, "linked_repo");
  fs.mkdirSync(dummyGitRepo, { recursive: true });
  execSync("git init -b main", { cwd: dummyGitRepo });
  execSync("git config user.name 'TestUser'", { cwd: dummyGitRepo });
  execSync("git config user.email 'test@example.com'", { cwd: dummyGitRepo });
  execSync("git commit --allow-empty -m 'Initial commit'", { cwd: dummyGitRepo });

  const registry = {
    codex: {
      command: process.execPath,
      args: ["-e", "console.log('mock codex done')"],
      input: "arg" as const,
    },
    agy: {
      command: process.execPath,
      args: ["-e", "console.log('mock agy done')"],
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

  const realRepoPath = fs.realpathSync(dummyGitRepo);

  try {
    // 1. Register a test project in projects.json
    console.log("\n[Test 1] Registering test project 'link_project'...");
    const addProjRes: any = await client.callTool({
      name: "add_project",
      arguments: {
        id: "link_project",
        name: "Linked Project Workspace",
        repo_path: dummyGitRepo,
        default_base_branch: "main",
        push_remote: "github",
        forbidden_remotes: ["gitee.com"],
        default_agent: "codex",
        default_timeout_seconds: 450,
      },
    });
    assert.ok(!addProjRes.isError, "add_project should succeed");
    console.log("✓ Test 1 passed: Project registered successfully.");

    // 2. Create an execution plan bound to 'link_project'
    console.log("\n[Test 2] Creating plan 'plan_with_project' bound to 'link_project'...");
    const createPlanRes: any = await client.callTool({
      name: "create_plan",
      arguments: {
        id: "plan_with_project",
        project_id: "link_project",
        title: "Database Refactor Plan",
        context: "# Refactor Context\nMigrate SQL tables.",
        steps: [
          { id: "step-1", title: "Step One Schema", detail: "Update migrations" },
          { id: "step-2", title: "Step Two Seeding", detail: "Seed demo records" },
        ],
      },
    });
    assert.ok(!createPlanRes.isError, "create_plan should succeed");
    console.log("✓ Test 2 passed: Plan created with project_id.");

    // 3. Dispatch task with plan_id + step_id WITHOUT passing project_id
    console.log("\n[Test 3] Testing send_task inheriting project_id from plan...");
    const sendRes: any = await client.callTool({
      name: "send_task",
      arguments: {
        plan_id: "plan_with_project",
        step_id: "step-1",
        prompt: "Please write the initial migration script.",
      },
    });
    assert.ok(!sendRes.isError, "send_task should succeed without error");
    const sendOutput = sendRes.content[0].text;
    const taskIdMatch = sendOutput.match(/task_id:\s*([^\r\n]+)/);
    assert.ok(taskIdMatch, "Must output task_id");
    const taskId = taskIdMatch[1].trim();

    const taskFileContent = fs.readFileSync(path.join(tmpRoot, "tasks", `${taskId}.md`), "utf8");
    assert.ok(taskFileContent.includes("- **Project ID**: link_project"), "Task must inherit Project ID from Plan");
    assert.ok(taskFileContent.includes("- **Project Name**: Linked Project Workspace"), "Task must inherit Project Name");
    assert.ok(taskFileContent.includes(`- **Project Dir**: ${realRepoPath}`), "Task must inherit repo_path");
    assert.ok(taskFileContent.includes("[Project Git Constraints (link_project)]"), "Task must inherit git constraints note");
    console.log("✓ Test 3 passed: send_task automatically inherited project_id and project defaults from plan!");

    // 4. Test enqueue_task inheriting project_id from plan
    console.log("\n[Test 4] Testing enqueue_task inheriting project_id from plan...");
    const enqRes: any = await client.callTool({
      name: "enqueue_task",
      arguments: {
        session_id: "sess_link_queue",
        prompt: "Second migration queued",
        options: {
          plan_id: "plan_with_project",
          step_id: "step-2",
        },
      },
    });
    assert.ok(!enqRes.isError, "enqueue_task should succeed");
    const enqJson = JSON.parse(enqRes.content[0].text);
    assert.ok(enqJson.id, "Must return queued item ID");

    // Check list_queue with project_id and plan_id filter
    const listQueueRes: any = await client.callTool({
      name: "list_queue",
      arguments: {
        project_id: "link_project",
      },
    });
    assert.ok(!listQueueRes.isError, "list_queue should succeed");
    const queueItems = JSON.parse(listQueueRes.content[0].text);
    assert.equal(queueItems.length, 1, "Must find exactly 1 queue item for link_project");
    assert.equal(queueItems[0].project_id, "link_project");
    assert.equal(queueItems[0].plan_id, "plan_with_project");
    assert.equal(queueItems[0].step_id, "step-2");
    console.log("✓ Test 4 passed: enqueue_task inherited project_id from plan and list_queue returns project_id/plan_id!");

    // 5. Test save_requirement with project_id, and dispatch_requirement propagating project_id
    console.log("\n[Test 5] Testing save_requirement with project_id and dispatching it...");
    const saveReqRes: any = await client.callTool({
      name: "save_requirement",
      arguments: {
        project_id: "link_project",
        session_id: "sess_req_link",
        title: "Requirement for linked project",
        raw_text: "Add audit logging to user logins.",
      },
    });
    assert.ok(!saveReqRes.isError, "save_requirement with project_id should succeed");
    const saveReqJson = JSON.parse(saveReqRes.content[0].text);
    assert.ok(saveReqJson.id);

    // List requirements with project_id filter
    const listReqRes: any = await client.callTool({
      name: "list_requirements",
      arguments: {
        project_id: "link_project",
      },
    });
    assert.ok(!listReqRes.isError);
    const reqList = JSON.parse(listReqRes.content[0].text);
    assert.ok(reqList.some((r: any) => r.id === saveReqJson.id));

    // Dispatch requirement
    const dispReqRes: any = await client.callTool({
      name: "dispatch_requirement",
      arguments: {
        id: saveReqJson.id,
      },
    });
    assert.ok(!dispReqRes.isError, "dispatch_requirement should succeed");
    const dispReqJson = JSON.parse(dispReqRes.content[0].text);
    assert.equal(dispReqJson.project_id, "link_project");
    assert.ok(dispReqJson.task_id);

    const reqTaskContent = fs.readFileSync(path.join(tmpRoot, "tasks", `${dispReqJson.task_id}.md`), "utf8");
    assert.ok(reqTaskContent.includes("- **Project ID**: link_project"), "Dispatched requirement task must carry project_id");
    assert.ok(reqTaskContent.includes(`- **Project Dir**: ${realRepoPath}`), "Dispatched requirement task must inherit repo_path");
    console.log("✓ Test 5 passed: save_requirement and dispatch_requirement fully link with project_id!");

    // 6. Test dispatch_requirement directly linking into a plan step
    console.log("\n[Test 6] Testing dispatch_requirement linked to plan_id and step_id...");
    const saveReqForPlan: any = await client.callTool({
      name: "save_requirement",
      arguments: {
        project_id: "link_project",
        title: "Requirement linked to step",
        raw_text: "Complete seeding schema",
      },
    });
    const reqPlanJson = JSON.parse(saveReqForPlan.content[0].text);

    const dispToPlanRes: any = await client.callTool({
      name: "dispatch_requirement",
      arguments: {
        id: reqPlanJson.id,
        options: {
          plan_id: "plan_with_project",
          step_id: "step-2",
        },
      },
    });
    assert.ok(!dispToPlanRes.isError, "dispatch_requirement to plan should succeed");
    const dispToPlanJson = JSON.parse(dispToPlanRes.content[0].text);
    assert.equal(dispToPlanJson.project_id, "link_project");
    assert.equal(dispToPlanJson.plan_id, "plan_with_project");
    assert.equal(dispToPlanJson.step_id, "step-2");

    const planTaskContent = fs.readFileSync(path.join(tmpRoot, "tasks", `${dispToPlanJson.task_id}.md`), "utf8");
    assert.ok(planTaskContent.includes("- **Plan ID**: plan_with_project"));
    assert.ok(planTaskContent.includes("- **Plan Step ID**: step-2"));
    assert.ok(planTaskContent.includes("- **Project ID**: link_project"));
    console.log("✓ Test 6 passed: dispatch_requirement successfully linked into plan step and inherited project!");

    console.log("\n🎉 ALL PROJECT LINKAGE & INHERITANCE TESTS PASSED!");
  } finally {
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runProjectLinkageTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
