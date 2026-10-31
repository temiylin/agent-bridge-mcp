import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startHttpServer } from "../src/http-server.js";
import { renderDashboardHtml } from "../src/dashboard-html.js";
import { writeStatus } from "../src/status.js";

const TEST_ROOT = "/tmp/agent-bridge-dashboard-tabs-test";
const TEST_PORT = 38089;

async function runDashboardTabsTests() {
  console.log("=================================================");
  console.log("  Dashboard 4 Ops Tabs & REST APIs Smoke Test");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // 1. Verify renderDashboardHtml() contains all 4 new tab IDs
  console.log("[Test 1] Checking dashboard HTML for all 4 tab IDs...");
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="tab-recent-tasks"'), "HTML must include id='tab-recent-tasks'");
  assert.ok(html.includes('id="tab-requirements"'), "HTML must include id='tab-requirements'");
  assert.ok(html.includes('id="tab-queue"'), "HTML must include id='tab-queue'");
  assert.ok(html.includes('id="tab-pool"'), "HTML must include id='tab-pool'");
  assert.ok(html.includes('id="modal-init-profile"'), "HTML must include cockpit account picker modal");
  assert.ok(html.includes("confirmInitProfileFromAccount"), "HTML must include confirmInitProfileFromAccount");
  assert.ok(html.includes("function switchTab"), "HTML must keep switchTab helper");
  assert.ok(!html.includes('prompt("请输入新 Profile 别名'), "Init must not prompt for alias text input");
  console.log("✓ Assertion passed: All 4 new tab IDs verified in dashboard HTML.");

  // 2. Start HTTP server
  console.log("\n[Test 2] Starting test HTTP server on port " + TEST_PORT + "...");
  const handle = await startHttpServer({
    port: TEST_PORT,
    host: "127.0.0.1",
    customRootDir: TEST_ROOT,
  });

  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    // 3. Test /api/recent-tasks
    console.log("[Test 3] Testing GET /api/recent-tasks...");
    writeStatus(TEST_ROOT, "task-test-001", {
      state: "completed",
      agent: "agy",
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
    });

    const recentResp = await fetch(`${baseUrl}/api/recent-tasks`);
    assert.equal(recentResp.status, 200);
    const recentData = await recentResp.json();
    assert.equal(recentData.success, true);
    assert.ok(Array.isArray(recentData.tasks));
    assert.ok(recentData.tasks.some((t: any) => t.taskId === "task-test-001"));
    console.log("✓ Assertion passed: /api/recent-tasks returned recent tasks list.");

    // 4. Test /api/requirements (POST create, GET list, POST dispatch, POST delete)
    console.log("[Test 4] Testing /api/requirements (CRUD & dispatch)...");
    const createReqResp = await fetch(`${baseUrl}/api/requirements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        title: "Test Requirement Feature",
        project: "test-project",
        topic: "topic-auth",
        tags: ["feature", "test"],
        raw_text: "Please implement user authentication with password reset.",
      }),
    });
    assert.equal(createReqResp.status, 200);
    const createReqData = await createReqResp.json();
    assert.equal(createReqData.success, true);
    const reqId = createReqData.requirement.id;
    assert.ok(reqId);

    // List requirements
    const listReqResp = await fetch(`${baseUrl}/api/requirements`);
    assert.equal(listReqResp.status, 200);
    const listReqData = await listReqResp.json();
    assert.ok(listReqData.requirements.some((r: any) => r.id === reqId));

    // Dispatch requirement
    const dispatchReqResp = await fetch(`${baseUrl}/api/requirements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "dispatch",
        id: reqId,
        agent: "agy",
      }),
    });
    assert.equal(dispatchReqResp.status, 200);
    const dispatchReqData = await dispatchReqResp.json();
    assert.equal(dispatchReqData.success, true);
    assert.ok(dispatchReqData.taskId);
    console.log("✓ Assertion passed: /api/requirements created and dispatched requirement taskId:", dispatchReqData.taskId);

    // 5. Test /api/queue (GET list, POST pause, POST resume)
    console.log("[Test 5] Testing /api/queue...");
    const queueListResp = await fetch(`${baseUrl}/api/queue`);
    assert.equal(queueListResp.status, 200);
    const queueListData = await queueListResp.json();
    assert.equal(queueListData.success, true);

    const pauseQueueResp = await fetch(`${baseUrl}/api/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "pause",
        session_id: "topic-auth",
        reason: "Test pause",
      }),
    });
    assert.equal(pauseQueueResp.status, 200);

    const resumeQueueResp = await fetch(`${baseUrl}/api/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "resume",
        session_id: "topic-auth",
      }),
    });
    assert.equal(resumeQueueResp.status, 200);
    console.log("✓ Assertion passed: /api/queue pause and resume operations succeeded.");

    // 6. Test /api/pool (POST init, GET list, POST pause, POST resume, POST bind_email)
    console.log("[Test 6] Testing /api/pool...");
    const initPoolResp = await fetch(`${baseUrl}/api/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "init",
        alias: "test-profile-1",
        email: "user-test@example.com",
      }),
    });
    assert.equal(initPoolResp.status, 200);
    const initPoolData = await initPoolResp.json();
    assert.equal(initPoolData.success, true);
    assert.ok(initPoolData.loginCommand.includes("HOME="));

    const poolListResp = await fetch(`${baseUrl}/api/pool`);
    assert.equal(poolListResp.status, 200);
    const poolListData = await poolListResp.json();
    assert.equal(poolListData.success, true);
    assert.ok(poolListData.profiles.some((p: any) => p.alias === "test-profile-1"));

    const pausePoolResp = await fetch(`${baseUrl}/api/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "pause",
        alias: "test-profile-1",
      }),
    });
    assert.equal(pausePoolResp.status, 200);

    const resumePoolResp = await fetch(`${baseUrl}/api/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "resume",
        alias: "test-profile-1",
      }),
    });
    assert.equal(resumePoolResp.status, 200);
    console.log("✓ Assertion passed: /api/pool CRUD operations verified.");

    // 6b. email-only init + duplicate email rejection
    console.log("[Test 6b] Testing /api/pool email-only init and conflict rejection...");
    const emailInitResp = await fetch(`${baseUrl}/api/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "init",
        email: "picker-user@example.com",
      }),
    });
    assert.equal(emailInitResp.status, 200);
    const emailInitData = await emailInitResp.json();
    assert.equal(emailInitData.success, true);
    assert.equal(emailInitData.profile.alias, "picker-user");
    assert.ok(emailInitData.loginCommand.includes("HOME="));

    const dupEmailResp = await fetch(`${baseUrl}/api/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "init",
        email: "picker-user@example.com",
      }),
    });
    assert.equal(dupEmailResp.status, 400);
    const dupEmailData = await dupEmailResp.json();
    assert.equal(dupEmailData.success, false);
    assert.ok(String(dupEmailData.error || "").includes("already bound"));
    console.log("✓ Assertion passed: email-only init and duplicate email rejection verified.");

  } finally {
    await handle.close();
  }

  console.log("=================================================");
  console.log("  All Dashboard 4 Tabs & API Tests Passed! 🎉     ");
  console.log("=================================================");
}

runDashboardTabsTests().catch((err) => {
  console.error("Dashboard tabs test failed:", err);
  process.exit(1);
});
