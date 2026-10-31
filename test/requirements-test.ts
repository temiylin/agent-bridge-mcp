import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  writeRequirement,
  getRequirement,
  listRequirements,
  deleteRequirement,
  generateRequirementId,
  RequirementRecord,
} from "../src/requirements.js";
import { createBridgeMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_ROOT = "/tmp/agent-bridge-requirements-test";

async function runRequirementsTests() {
  console.log("=================================================");
  console.log("  Requirements Backlog Storage & MCP Tools Test");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // 1. Direct storage test: write & read & atomic tmp check
  console.log("\n[Test 1] Direct storage write & get");
  const id1 = generateRequirementId();
  const req1: RequirementRecord = {
    id: id1,
    project: "payment-service",
    topic: "sess_checkout_123",
    session_id: "sess_checkout_123",
    title: "Implement Stripe Webhook Idempotency",
    raw_text: "Need to check idempotency key before applying credit to account balance.",
    tags: ["stripe", "webhook", "billing"],
    status: "draft",
    created_at: new Date().toISOString(),
  };

  writeRequirement(TEST_ROOT, req1);
  const readBack = getRequirement(TEST_ROOT, id1);
  assert.ok(readBack, "Requirement should be read back successfully");
  assert.equal(readBack?.id, id1);
  assert.equal(readBack?.title, req1.title);
  assert.equal(readBack?.raw_text, req1.raw_text);
  assert.deepEqual(readBack?.tags, ["stripe", "webhook", "billing"]);
  console.log("✓ Test 1 passed: Requirement written and read back accurately.");

  // Check no leftover .tmp files
  const reqDir = path.join(TEST_ROOT, "requirements");
  const tmpFiles = fs.readdirSync(reqDir).filter((f) => f.endsWith(".tmp"));
  assert.equal(tmpFiles.length, 0, "No .tmp residual files should remain");
  console.log("✓ Test 1.1 passed: 0 .tmp files found.");

  // 2. listRequirements filter tests
  console.log("\n[Test 2] listRequirements compact filtering");
  const id2 = generateRequirementId();
  writeRequirement(TEST_ROOT, {
    id: id2,
    project: "payment-service",
    topic: "sess_checkout_123",
    title: "Add refund retry backoff",
    raw_text: "Exponential backoff up to 3 times",
    status: "dispatched",
    created_at: new Date(Date.now() + 1000).toISOString(),
  });

  const id3 = generateRequirementId();
  writeRequirement(TEST_ROOT, {
    id: id3,
    project: "auth-service",
    topic: "sess_oauth_456",
    title: "Support Passkeys",
    raw_text: "WebAuthn passkeys for login",
    status: "draft",
    created_at: new Date(Date.now() + 2000).toISOString(),
  });

  const listAll = listRequirements(TEST_ROOT);
  assert.equal(listAll.length, 3);
  // Must NOT include full raw_text
  assert.equal((listAll[0] as any).raw_text, undefined, "listRequirements must omit raw_text");

  const paymentList = listRequirements(TEST_ROOT, { project: "payment-service" });
  assert.equal(paymentList.length, 2);

  const draftPaymentList = listRequirements(TEST_ROOT, { project: "payment-service", status: "draft" });
  assert.equal(draftPaymentList.length, 1);
  assert.equal(draftPaymentList[0].id, id1);
  console.log("✓ Test 2 passed: Compact list and filtering work properly.");

  // 3. MCP tool tests: save_requirement, update_requirement, merge_requirements, archive_requirement, delete_requirement, dispatch_requirement
  console.log("\n[Test 3] MCP Tools via inMemory transport");
  const instance = createBridgeMcpServer(TEST_ROOT);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    instance.server.connect(serverTransport),
  ]);

  // Call save_requirement
  const saveRes = await client.callTool({
    name: "save_requirement",
    arguments: {
      project: "inventory-svc",
      session_id: "sess_inv_1",
      title: "Stock reservation timeout",
      raw_text: "Release held stock if order not paid within 15 minutes.",
      tags: ["inventory", "reservation"],
    },
  });
  assert.ok(!saveRes.isError);
  const savedData = JSON.parse((saveRes.content as any)[0].text);
  assert.ok(savedData.id);
  assert.equal(savedData.status, "draft");
  console.log(`✓ save_requirement MCP tool returned: id=${savedData.id}, status=${savedData.status}`);

  // Call update_requirement
  const updateRes = await client.callTool({
    name: "update_requirement",
    arguments: {
      id: savedData.id,
      title: "Stock reservation timeout (10 mins)",
      raw_text: "Release held stock if order not paid within 10 minutes.",
    },
  });
  assert.ok(!updateRes.isError);
  const updatedReq = getRequirement(TEST_ROOT, savedData.id);
  assert.equal(updatedReq?.title, "Stock reservation timeout (10 mins)");
  assert.equal(updatedReq?.raw_text, "Release held stock if order not paid within 10 minutes.");
  console.log("✓ update_requirement MCP tool updated record accurately.");

  // Call merge_requirements
  const saveRes2 = await client.callTool({
    name: "save_requirement",
    arguments: {
      project: "inventory-svc",
      session_id: "sess_inv_1",
      title: "Stock alert webhook",
      raw_text: "Notify Slack when stock falls below 5 units.",
    },
  });
  const savedData2 = JSON.parse((saveRes2.content as any)[0].text);

  const mergeRes = await client.callTool({
    name: "merge_requirements",
    arguments: {
      ids: [savedData.id, savedData2.id],
      title: "Consolidated Inventory Reservation & Alerts",
    },
  });
  assert.ok(!mergeRes.isError);
  const mergedData = JSON.parse((mergeRes.content as any)[0].text);
  assert.ok(mergedData.id);
  assert.equal(mergedData.status, "draft");

  // Check source records marked as "merged" with merged_into pointer
  const src1 = getRequirement(TEST_ROOT, savedData.id);
  const src2 = getRequirement(TEST_ROOT, savedData2.id);
  assert.equal(src1?.status, "merged");
  assert.equal(src1?.merged_into, mergedData.id);
  assert.equal(src2?.status, "merged");
  assert.equal(src2?.merged_into, mergedData.id);
  console.log("✓ merge_requirements created merged requirement and updated source pointers.");

  // Call archive_requirement
  const archiveRes = await client.callTool({
    name: "archive_requirement",
    arguments: { id: id1 },
  });
  assert.ok(!archiveRes.isError);
  const archivedReq = getRequirement(TEST_ROOT, id1);
  assert.equal(archivedReq?.status, "archived");
  console.log("✓ archive_requirement marked status as archived.");

  // Call delete_requirement
  const delRes = await client.callTool({
    name: "delete_requirement",
    arguments: { id: id1 },
  });
  assert.ok(!delRes.isError);
  assert.equal(getRequirement(TEST_ROOT, id1), null);
  console.log("✓ delete_requirement removed requirement file.");

  // Call dispatch_requirement
  const dispatchRes = await client.callTool({
    name: "dispatch_requirement",
    arguments: {
      id: mergedData.id,
    },
  });
  assert.ok(!dispatchRes.isError);
  const dispData = JSON.parse((dispatchRes.content as any)[0].text);
  assert.equal(dispData.status, "dispatched");
  assert.ok(dispData.task_id);

  // Check requirement record status on disk
  const dispReq = getRequirement(TEST_ROOT, mergedData.id);
  assert.equal(dispReq?.status, "dispatched");
  assert.equal(dispReq?.task_id, dispData.task_id);
  assert.ok(dispReq?.dispatched_at);

  // Check task file generated on disk in tasks/
  const taskFilePath = path.join(TEST_ROOT, "tasks", `${dispData.task_id}.md`);
  assert.ok(fs.existsSync(taskFilePath), "Task file should be generated in tasks/");
  const taskContent = fs.readFileSync(taskFilePath, "utf8");
  assert.ok(taskContent.includes("Consolidated Inventory Reservation & Alerts"));
  assert.ok(taskContent.includes("- **Session ID**: sess_inv_1"));
  console.log(`✓ dispatch_requirement dispatched task ${dispData.task_id} with session_id re-used.`);

  await client.close();
  console.log("\n=================================================");
  console.log("  All Requirements tests passed successfully!   ");
  console.log("=================================================\n");
}

runRequirementsTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
