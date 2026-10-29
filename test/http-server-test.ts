import { startHttpServer } from "../src/http-server.js";
import assert from "node:assert";

async function runHttpTest() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp HTTP/SSE Server Test");
  console.log("=================================================");

  const testPort = 38199;
  const testHost = "127.0.0.1";
  const customRootDir = "/tmp/agent-bridge-http-test";

  console.log(`[Setup] Starting HTTP server on http://${testHost}:${testPort}/mcp...`);
  const handle = await startHttpServer({
    port: testPort,
    host: testHost,
    customRootDir,
  });

  try {
    // 1. Health check test
    console.log("\n[Test 1] Testing GET /health");
    const healthResp = await fetch(`http://${testHost}:${testPort}/health`);
    assert.strictEqual(healthResp.status, 200, "Health check should return 200");
    const healthJson = await healthResp.json();
    console.log("Health check response:", JSON.stringify(healthJson, null, 2));
    assert.strictEqual(healthJson.status, "online");
    assert.strictEqual(healthJson.service, "agent-bridge-mcp");
    console.log("✓ Assertion passed: Health check response verified.");

    // 2. CORS test
    console.log("\n[Test 2] Testing OPTIONS /mcp for CORS");
    const corsResp = await fetch(`http://${testHost}:${testPort}/mcp`, {
      method: "OPTIONS",
    });
    assert.strictEqual(corsResp.status, 204, "OPTIONS should return 204");
    assert.strictEqual(corsResp.headers.get("access-control-allow-origin"), "*");
    console.log("✓ Assertion passed: CORS headers verified.");

    // 3. MCP initialize test
    console.log("\n[Test 3] Testing POST /mcp (initialize)");
    const initResp = await fetch(`http://${testHost}:${testPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chatgpt-test-client", version: "1.0.0" },
        },
      }),
    });

    assert.strictEqual(initResp.status, 200, "Initialize should return 200");
    const sessionId = initResp.headers.get("mcp-session-id");
    assert.ok(sessionId, "Initialize response must contain mcp-session-id");
    const initBody = await initResp.text();
    console.log("Initialize Body (SSE preview):", initBody.trim());
    assert.ok(initBody.includes("agent-bridge-mcp"), "Initialize response must include server name");
    console.log(`✓ Assertion passed: Initialized with session ID: ${sessionId}`);

    // 4. Initialized notification
    console.log("\n[Test 4] Testing POST /mcp (notifications/initialized)");
    await fetch(`http://${testHost}:${testPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });
    console.log("✓ Initialized notification delivered.");

    // 5. tools/list test
    console.log("\n[Test 5] Testing POST /mcp (tools/list)");
    const listResp = await fetch(`http://${testHost}:${testPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    assert.strictEqual(listResp.status, 200, "tools/list should return 200");
    const listBody = await listResp.text();
    console.log("tools/list Body (SSE preview):", listBody.slice(0, 300) + "...");
    assert.ok(listBody.includes("device_info"), "tools/list must include device_info");
    assert.ok(listBody.includes("repo_status"), "tools/list must include repo_status");
    assert.ok(listBody.includes("send_task"), "tools/list must include send_task");
    console.log("✓ Assertion passed: All tools listed over HTTP/SSE transport.");

    // 6. tools/call test for device_info
    console.log("\n[Test 6] Testing POST /mcp (tools/call: device_info)");
    const callResp = await fetch(`http://${testHost}:${testPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "device_info",
          arguments: {},
        },
      }),
    });

    assert.strictEqual(callResp.status, 200, "tools/call should return 200");
    const callBody = await callResp.text();
    console.log("device_info result:\n", callBody);
    assert.ok(callBody.includes("arm64") || callBody.includes("architecture"), "Result must contain CPU/Hardware info");
    assert.ok(callBody.includes("totalBytes"), "Result must contain memory/disk totalBytes info");
    console.log("✓ Assertion passed: device_info called successfully over HTTP/SSE!");

    // 7. Test Accept: application/json (standard client probe without text/event-stream)
    console.log("\n[Test 7] Testing POST /mcp with standard Accept: application/json (like ChatGPT probe)");
    const chatgptProbeResp = await fetch(`http://${testHost}:${testPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 701,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chatgpt-validator", version: "1.0.0" },
        },
      }),
    });
    assert.strictEqual(chatgptProbeResp.status, 200, "Must return 200 even with Accept: application/json");
    const probeJson = await chatgptProbeResp.json();
    assert.strictEqual(probeJson.id, 701);
    assert.ok(probeJson.result?.capabilities?.tools, "Must advertise tools capability");
    console.log("✓ Assertion passed: Accept: application/json normalized and accepted, tools capability advertised.");

    // 8. Test Stateless tools/list (no session ID provided at all)
    console.log("\n[Test 8] Testing POST /mcp stateless tools/list (no session ID)");
    const statelessListResp = await fetch(`http://${testHost}:${testPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 801,
        method: "tools/list",
        params: {},
      }),
    });
    assert.strictEqual(statelessListResp.status, 200, "Stateless tools/list must return 200");
    const statelessListJson = await statelessListResp.json();
    assert.strictEqual(statelessListJson.id, 801);
    assert.ok(Array.isArray(statelessListJson.result?.tools), "Tools list must be returned");
    assert.strictEqual(statelessListJson.result.tools.length, 17, "Must return all 17 tools");
    console.log(`✓ Assertion passed: Stateless tools/list succeeded, returned ${statelessListJson.result.tools.length} tools.`);

    // 9. Test Classic SSE transport (/sse)
    console.log("\n[Test 9] Testing GET /sse (Classic SSE transport)");
    const sseResp = await fetch(`http://${testHost}:${testPort}/sse`);
    assert.strictEqual(sseResp.status, 200, "GET /sse must return 200");
    assert.ok(sseResp.headers.get("content-type")?.includes("text/event-stream"), "SSE must return text/event-stream");
    
    // Read the endpoint event
    const reader = sseResp.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      const chunk = await reader.read();
      const sseText = decoder.decode(chunk.value);
      assert.ok(sseText.includes("event: endpoint"), "SSE stream must emit endpoint event");
      console.log("✓ Assertion passed: Classic SSE transport emitted endpoint event.");
      await reader.cancel();
    }
  } finally {
    console.log("\n[Cleanup] Closing HTTP server...");
    await handle.close();
    console.log("✓ HTTP server stopped.");
  }

  console.log("\n=================================================");
  console.log("  All HTTP Server Tests Passed Successfully! 🎉");
  console.log("=================================================");
}

runHttpTest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
