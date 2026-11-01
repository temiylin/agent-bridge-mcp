import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startHttpServer } from "../src/http-server.js";
import { resolveTaskAgent, loadRoutingConfig, saveRoutingConfig } from "../src/routing.js";
import { saveAgents } from "../src/agents.js";

const TEST_ROOT = "/tmp/agent-bridge-dashboard-test";
const TEST_PORT = 38085;

async function runDashboardTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp Local Web Dashboard Test");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // 1. Prepare agents.json
  saveAgents(TEST_ROOT, {
    codex: {
      command: "codex",
      args: ["exec"],
      input: "stdin",
    },
    agy: {
      command: "agy",
      args: ["-p"],
      input: "stdin",
    },
  });

  // 2. Prepare routing.json with explicit scenarios
  saveRoutingConfig(TEST_ROOT, {
    defaultAgent: "codex",
    instructions: "后端走 codex，前端走 agy",
    rules: [
      {
        id: "rule_backend",
        scenario: "后端及数据库服务",
        keywords: ["后端", "api", "database", "数据库", "mysql"],
        agent: "codex",
        description: "后端及数据层",
      },
      {
        id: "rule_frontend",
        scenario: "前端与界面交互",
        keywords: ["前端", "ui", "界面", "vue", "react", "css"],
        agent: "agy",
        description: "前端界面与组件",
      },
    ],
  });

  // 3. Test resolveTaskAgent logic
  console.log("[Test 1] Testing smart routing resolution (resolveTaskAgent)...");
  const r1 = resolveTaskAgent(TEST_ROOT, "请帮我写一个 Vue 前端登录组件");
  assert.equal(r1.agent, "agy", "Prompt with 'Vue 前端' must route to agy");
  assert.ok(r1.reason.includes("前端与界面交互"));
  console.log("✓ Assertion passed: Frontend prompt routed to agy:", r1);

  const r2 = resolveTaskAgent(TEST_ROOT, "请优化后端 API 接口与 MySQL 数据库查询");
  assert.equal(r2.agent, "codex", "Prompt with '后端 API MySQL 数据库' must route to codex");
  assert.ok(r2.reason.includes("后端及数据库服务"));
  console.log("✓ Assertion passed: Backend prompt routed to codex:", r2);

  const r3 = resolveTaskAgent(TEST_ROOT, "今天天气怎么样");
  assert.equal(r3.agent, "codex", "Generic prompt must route to defaultAgent (codex)");
  console.log("✓ Assertion passed: Generic prompt routed to defaultAgent:", r3);

  const r4 = resolveTaskAgent(TEST_ROOT, "任何内容", "agy");
  assert.equal(r4.agent, "agy", "Explicitly requested agent overrides smart rules");
  console.log("✓ Assertion passed: Explicit agent respected:", r4);

  // 4. Start HTTP Server and test Dashboard Web endpoints
  console.log("\n[Test 2] Starting HTTP Server on port " + TEST_PORT + "...");
  const serverHandle = await startHttpServer({
    port: TEST_PORT,
    host: "127.0.0.1",
    customRootDir: TEST_ROOT,
  });

  try {
    const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    // Test GET / with text/html -> Returns HTML Dashboard (React SPA or fallback)
    console.log("[Test 3] Fetching GET / with Accept: text/html...");
    const htmlResp = await fetch(`${baseUrl}/`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    assert.equal(htmlResp.status, 200);
    assert.ok(htmlResp.headers.get("content-type")?.includes("text/html"));
    const htmlText = await htmlResp.text();
    assert.ok(
      htmlText.includes("Agent Bridge") || htmlText.includes("agent-bridge"),
      "HTML must contain Agent Bridge title"
    );
    console.log("✓ Assertion passed: HTML dashboard served successfully on /.");

    // Test GET /dashboard -> Returns HTML Dashboard
    console.log("[Test 4] Fetching GET /dashboard...");
    const dashResp = await fetch(`${baseUrl}/dashboard`);
    assert.equal(dashResp.status, 200);
    assert.ok(dashResp.headers.get("content-type")?.includes("text/html"));
    console.log("✓ Assertion passed: /dashboard returns HTML.");

    // Test GET /api/config -> Returns JSON
    console.log("[Test 5] Fetching GET /api/config...");
    const cfgResp = await fetch(`${baseUrl}/api/config`);
    assert.equal(cfgResp.status, 200);
    const cfgJson = await cfgResp.json();
    assert.ok(cfgJson.agents && cfgJson.agents.codex);
    assert.equal(cfgJson.routing.defaultAgent, "codex");
    assert.equal(cfgJson.routing.rules.length, 2);
    console.log("✓ Assertion passed: /api/config returned valid configuration.");

    // Test POST /api/config -> Updates routing instructions
    console.log("[Test 6] Testing POST /api/config update...");
    const updateResp = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agents: cfgJson.agents,
        routing: {
          defaultAgent: "agy",
          instructions: "全部优先走 agy",
          rules: [
            {
              id: "rule_custom",
              scenario: "自定义全栈场景",
              keywords: ["全栈", "fullstack"],
              agent: "agy",
            },
          ],
        },
      }),
    });
    assert.equal(updateResp.status, 200);
    const updateJson = await updateResp.json();
    assert.equal(updateJson.success, true);

    // Verify on disk
    const reloaded = loadRoutingConfig(TEST_ROOT);
    assert.equal(reloaded.defaultAgent, "agy");
    assert.equal(reloaded.instructions, "全部优先走 agy");
    assert.equal(reloaded.rules.length, 1);
    console.log("✓ Assertion passed: POST /api/config successfully updated routing.json on disk.");

    // Test POST /api/test-agent
    console.log("[Test 7] Testing POST /api/test-agent with 'node' command...");
    const testAgentResp = await fetch(`${baseUrl}/api/test-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "node" }),
    });
    assert.equal(testAgentResp.status, 200);
    const testAgentJson = await testAgentResp.json();
    assert.equal(testAgentJson.available, true);
    console.log("✓ Assertion passed: /api/test-agent successfully probed executable path.");

    // Test GET /api/system
    console.log("[Test 8] Testing GET /api/system...");
    const sysResp = await fetch(`${baseUrl}/api/system`);
    assert.equal(sysResp.status, 200);
    const sysJson = await sysResp.json();
    assert.ok(sysJson.platform);
    assert.ok(sysJson.cores > 0);
    console.log("✓ Assertion passed: /api/system returned live host specifications.");

  } finally {
    await serverHandle.close();
  }

  console.log("=================================================");
  console.log("  All Local Web Dashboard Tests Passed! 🎉      ");
  console.log("=================================================");
}

runDashboardTests().catch((err) => {
  console.error("Dashboard test failed:", err);
  process.exit(1);
});
