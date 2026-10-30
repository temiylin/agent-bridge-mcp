import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  resolveSessionId,
  recordSession,
  extractSessionIdFromOutput,
  loadSessions
} from "../src/sessions.js";

const TEST_DIR = "/tmp/agent-bridge-session-test";

function runSessionTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp Session Isolation & Continuity");
  console.log("=================================================");

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // 1. Raw UUID passthrough
  const rawUuid = "01a186a0-6d19-7e92-b3d7-f27e5f096e32";
  const resolvedDirect = resolveSessionId(TEST_DIR, rawUuid);
  assert.equal(resolvedDirect, rawUuid, "UUID should be resolved directly");
  console.log("✓ Test 1: Raw UUID resolved directly without mapping.");

  // 2. Unmapped alias returns undefined (first turn of fresh session)
  const unmapped = resolveSessionId(TEST_DIR, "vision_backend");
  assert.equal(unmapped, undefined, "Unmapped alias must return undefined initially");
  console.log("✓ Test 2: Unmapped alias returns undefined for first turn.");

  // 3. Extract session ID from Codex stdout
  const mockCodexStdout = `OpenAI Codex v0.162.1
--------
workdir: /code/my-project
model: gpt-6.1-terra
session id: 01a186a0-6d19-7e92-b3d7-f27e5f096e32
--------
Task completed successfully.`;
  const extracted = extractSessionIdFromOutput(mockCodexStdout);
  assert.equal(extracted, "01a186a0-6d19-7e92-b3d7-f27e5f096e32");
  console.log("✓ Test 3: Session ID successfully extracted from Codex stdout.");

  // 4. Record session mapping for vision_backend
  recordSession(TEST_DIR, "vision_backend", extracted!);
  const resolvedAlias = resolveSessionId(TEST_DIR, "vision_backend");
  assert.equal(resolvedAlias, "01a186a0-6d19-7e92-b3d7-f27e5f096e32");
  console.log("✓ Test 4: Alias 'vision_backend' successfully mapped and resolved.");

  // 5. Test parallel multi-session isolation
  const mockVueStdout = `OpenAI Codex v0.162.1
session id: e78b9901-4433-2211-aa99-123456789abc
All Vue components updated.`;
  const extractedVue = extractSessionIdFromOutput(mockVueStdout);
  recordSession(TEST_DIR, "vue_frontend", extractedVue!);

  // Verify both sessions coexist independently
  const backendSession = resolveSessionId(TEST_DIR, "vision_backend");
  const frontendSession = resolveSessionId(TEST_DIR, "vue_frontend");
  assert.equal(backendSession, "01a186a0-6d19-7e92-b3d7-f27e5f096e32");
  assert.equal(frontendSession, "e78b9901-4433-2211-aa99-123456789abc");
  assert.notEqual(backendSession, frontendSession);
  console.log("✓ Test 5: Parallel sessions ('vision_backend' & 'vue_frontend') isolated without collision.");

  console.log("\n=================================================");
  console.log("  All Session Isolation Tests Passed! 🎉        ");
  console.log("=================================================\n");
}

runSessionTests();
