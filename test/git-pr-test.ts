import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseTaskFile } from "../src/worker.js";

const TEST_ROOT = "/tmp/agent-bridge-git-pr-test";

async function runGitPrTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp Git & GitHub PR Tools Test");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, "results"), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(TEST_ROOT, "agents.json"),
    JSON.stringify({
      codex: {
        command: "codex",
        args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"],
        input: "stdin"
      },
      agy: {
        command: "agy",
        args: ["-p", "--dangerously-skip-permissions"],
        input: "stdin"
      }
    }, null, 2)
  );

  // 1. Test parseTaskFile with session continuity
  console.log("\n[Test 1] Testing parseTaskFile with Continue Session & Session ID...");
  const mockTaskFile = `# Rework PR Bugfix

- **Task ID**: task_continue_123
- **Agent**: codex
- **Model**: gpt-6.1-sol
- **Reasoning Effort**: high
- **Continue Session**: true
- **Session ID**: thread_abc_xyz_789
- **Created At**: 2026-10-29T07:00:00.000Z

---

## Prompt

Please fix the P1 review comment on the same branch.
`;

  const parsed = parseTaskFile(mockTaskFile);
  assert.equal(parsed.agentName, "codex");
  assert.equal(parsed.model, "gpt-6.1-sol");
  assert.equal(parsed.reasoningEffort, "high");
  assert.equal(parsed.continueSession, true, "continueSession must be true");
  assert.equal(parsed.sessionId, "thread_abc_xyz_789", "sessionId must be parsed");
  assert.ok(parsed.prompt.includes("Please fix the P1 review comment"));
  console.log("✓ Test 1 passed: parseTaskFile correctly parsed continueSession & sessionId.\n");

  // 2. Connect client via stdio to dist/index.js
  const serverPath = path.resolve("dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
      AGENT_BRIDGE_REPO: path.resolve("."),
    },
  });

  const client = new Client({ name: "git-pr-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // 3. Test git_log
    console.log("-------------------------------------------------");
    console.log("[Test 2] Calling git_log tool");
    console.log("-------------------------------------------------");
    const logResp = await client.callTool({
      name: "git_log",
      arguments: {
        max_count: 5,
      },
    });
    assert.equal(logResp.isError, undefined);
    const logData = JSON.parse((logResp.content as any)[0]?.text || "{}");
    assert.ok(Array.isArray(logData.commits));
    assert.ok(logData.commits.length > 0);
    assert.ok(logData.commits[0].hash);
    console.log(`✓ Test 2 passed: git_log returned ${logData.commits.length} commits.\n`);

    // 4. Test git_diff with stat: true
    console.log("-------------------------------------------------");
    console.log("[Test 3] Calling git_diff tool with stat: true");
    console.log("-------------------------------------------------");
    const diffResp = await client.callTool({
      name: "git_diff",
      arguments: {
        stat: true,
      },
    });
    assert.equal(diffResp.isError, undefined);
    const diffData = JSON.parse((diffResp.content as any)[0]?.text || "{}");
    assert.equal(diffData.stat, true);
    console.log("✓ Test 3 passed: git_diff stat query returned successfully.\n");

    // 5. Test git_check_fast_forward
    console.log("-------------------------------------------------");
    console.log("[Test 4] Calling git_check_fast_forward tool");
    console.log("-------------------------------------------------");
    const ffResp = await client.callTool({
      name: "git_check_fast_forward",
      arguments: {
        base: "HEAD~1",
        head: "HEAD",
      },
    });
    assert.equal(ffResp.isError, undefined);
    const ffData = JSON.parse((ffResp.content as any)[0]?.text || "{}");
    assert.equal(ffData.can_fast_forward, true, "HEAD~1 must be ancestor of HEAD");
    console.log("✓ Test 4 passed: git_check_fast_forward ancestor verification succeeded.\n");

    // 6. Test pr_list with --repo
    console.log("-------------------------------------------------");
    console.log("[Test 5] Calling pr_list tool");
    console.log("-------------------------------------------------");
    const prListResp = await client.callTool({
      name: "pr_list",
      arguments: {
        repo: "temiylin/agent-bridge-mcp",
        state: "all",
        limit: 5,
      },
    });
    assert.equal(prListResp.isError, undefined);
    const prListData = JSON.parse((prListResp.content as any)[0]?.text || "{}");
    assert.ok(Array.isArray(prListData.pull_requests));
    console.log(`✓ Test 5 passed: pr_list returned pull_requests array (count=${prListData.count}).\n`);

    // 7. Test send_task with continue_session: true
    console.log("-------------------------------------------------");
    console.log("[Test 6] Calling send_task with continue_session: true");
    console.log("-------------------------------------------------");
    const sendResp = await client.callTool({
      name: "send_task",
      arguments: {
        prompt: "Review fixes for previous turn",
        title: "Continue Turn Task",
        continue_session: true,
        session_id: "thread_123_456",
      },
    });
    assert.equal(sendResp.isError, undefined);
    const sendText = (sendResp.content as any)[0]?.text || "";
    const taskIdMatch = sendText.match(/task_id:\s*([^\s\n]+)/);
    assert.ok(taskIdMatch);
    const taskId = taskIdMatch[1];
    const taskContent = fs.readFileSync(path.join(TEST_ROOT, "tasks", `${taskId}.md`), "utf8");
    assert.ok(taskContent.includes("- **Continue Session**: true"));
    assert.ok(taskContent.includes("- **Session ID**: thread_123_456"));
    console.log("✓ Test 6 passed: send_task recorded continue_session & session_id onto disk.\n");

  } finally {
    await client.close();
  }

  console.log("=================================================");
  console.log("  All Git & GitHub PR Tests Passed! 🎉           ");
  console.log("=================================================");
}

runGitPrTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
