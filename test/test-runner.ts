import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function runTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp Comprehensive Test Runner");
  console.log("=================================================");

  // Determine root dir (default or env)
  const rootDir = process.env.AGENT_BRIDGE_ROOT
    ? path.resolve(process.env.AGENT_BRIDGE_ROOT.replace(/^~(?=$|\/|\\)/, os.homedir()))
    : path.join(os.homedir(), "agent-bridge");

  console.log(`Using AGENT_BRIDGE_ROOT: ${rootDir}\n`);

  // Ensure agents.json exists in rootDir for MCP server send_task validation
  const agentsJsonPath = path.join(rootDir, "agents.json");
  if (!fs.existsSync(agentsJsonPath)) {
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      agentsJsonPath,
      JSON.stringify(
        {
          codex: { command: "codex", args: ["exec"], input: "arg" },
        },
        null,
        2
      ),
      "utf8"
    );
  }

  // Initialize transport to start the server process
  const serverPath = path.resolve("dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: rootDir,
    },
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  console.log("[Setup] Connecting to agent-bridge-mcp server via stdio...");
  await client.connect(transport);
  console.log("[Setup] Connected successfully!\n");

  // Step 0: List available tools
  console.log("-------------------------------------------------");
  console.log("[Test 0] Listing registered tools");
  console.log("-------------------------------------------------");
  const toolsResult = await client.listTools();
  console.log("Available tools:", JSON.stringify(toolsResult.tools.map(t => ({ name: t.name, description: t.description })), null, 2));

  // Assertions for Test 0
  const expectedTools = new Set([
    "send_task",
    "read_result",
    "get_task_status",
    "cancel_task",
    "read_task_output",
    "read_result_page",
    "wait_task",
    "repo_status",
    "worker_alive_summary",
    "list_tasks_summary",
    "agent_registry_summary",
    "device_info",
    "check_port",
    "list_directory",
    "read_file",
    "read_multiple_files",
    "write_file",
    "edit_block",
    "search_files",
    "search_code",
    "tail_file",
    "move_file",
    "create_directory",
    "execute_command",
    "inspect_project_directories",
    "get_file_info",
    "list_models",
    "git_diff",
    "git_check_fast_forward",
    "git_log",
    "git_fetch",
    "git_push",
    "pr_list",
    "pr_view",
    "pr_diff",
    "pr_checks",
    "pr_create",
    "pr_review",
    "pr_merge",
    "save_requirement",
    "list_requirements",
    "get_requirement",
    "update_requirement",
    "merge_requirements",
    "archive_requirement",
    "delete_requirement",
    "dispatch_requirement",
    "enqueue_task",
    "list_queue",
    "reorder_queue",
    "update_queue_item",
    "cancel_queue_item",
    "pause_queue",
    "resume_queue",
  ]);
  const actualTools = new Set(toolsResult.tools.map((t) => t.name));
  assert.deepStrictEqual(
    [...actualTools].sort(),
    [...expectedTools].sort(),
    "Tool set must match expected ops-enabled set"
  );
  assert.ok(toolsResult.tools.some(t => t.name === "send_task"), "Expected send_task tool to be registered");
  assert.ok(toolsResult.tools.some(t => t.name === "read_result"), "Expected read_result tool to be registered");
  console.log("✓ Assertion passed: Both send_task and read_result tools are registered.");

  // Step 1: send_task
  console.log("\n-------------------------------------------------");
  console.log("[Test 1] Calling send_task");
  console.log("-------------------------------------------------");
  const promptText = "Analyze the database slow query log and provide optimization suggestions.";
  const titleText = "Database Performance Analysis";

  console.log("Arguments passed to send_task:");
  console.log(JSON.stringify({ title: titleText, prompt: promptText }, null, 2));

  const sendResult = await client.callTool({
    name: "send_task",
    arguments: {
      title: titleText,
      prompt: promptText,
    },
  });

  console.log("\nServer output from send_task:");
  console.log(JSON.stringify(sendResult, null, 2));

  // Assertions for Test 1
  assert.ok(!sendResult.isError, "send_task should succeed without error");
  assert.ok(Array.isArray(sendResult.content) && sendResult.content.length > 0, "send_task should return non-empty content");

  const responseText = (sendResult.content as Array<{ type: string; text: string }>)[0].text;
  const taskIdMatch = responseText.match(/task_id:\s*([^\s\n]+)/);
  const pathMatch = responseText.match(/path:\s*([^\s\n]+)/);

  assert.ok(taskIdMatch && taskIdMatch[1], `Failed to extract task_id from response: ${responseText}`);
  assert.ok(pathMatch && pathMatch[1], `Failed to extract path from response: ${responseText}`);

  const taskId = taskIdMatch[1];
  const taskFilePath = pathMatch[1];

  console.log(`\nGenerated task_id: ${taskId}`);
  console.log(`Generated task file path: ${taskFilePath}`);

  assert.ok(fs.existsSync(taskFilePath), `Expected task file to exist on disk at "${taskFilePath}"`);

  console.log("\n--- Content of generated tasks file on disk ---");
  const taskFileContent = fs.readFileSync(taskFilePath, "utf8");
  console.log(taskFileContent);
  console.log("--- End of tasks file content ---");

  assert.ok(taskFileContent.includes(titleText), "Task file must contain title in header");
  assert.ok(taskFileContent.includes(taskId), "Task file must contain taskId in header");
  assert.ok(taskFileContent.includes(promptText), "Task file must contain prompt body");
  console.log("✓ Assertion passed: send_task response structure and on-disk file content verified.");

  // Step 2: read_result on newly created task (should be pending)
  console.log("\n-------------------------------------------------");
  console.log("[Test 2] Calling read_result BEFORE result file exists (should be pending, not crash)");
  console.log("-------------------------------------------------");
  const pendingResult = await client.callTool({
    name: "read_result",
    arguments: {
      task_id: taskId,
    },
  });
  console.log("Server output for pending task:");
  console.log(JSON.stringify(pendingResult, null, 2));

  // Assertions for Test 2
  assert.ok(!pendingResult.isError, "read_result before result file exists should not return isError");
  const pendingText = (pendingResult.content as Array<{ type: string; text: string }>)[0].text;
  assert.ok(pendingText.includes("Pending"), "read_result response must describe pending status");
  assert.ok(pendingText.includes(taskId), "read_result response must reference the task_id");
  console.log("✓ Assertion passed: read_result returned pending status without crashing.");

  // Step 3: Manually create results/<task_id>.md and call read_result
  console.log("\n-------------------------------------------------");
  console.log("[Test 3] Manually creating results/<task_id>.md and calling read_result");
  console.log("-------------------------------------------------");
  const resultsDir = path.join(rootDir, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultFilePath = path.join(resultsDir, `${taskId}.md`);

  const mockResultContent = `# Execution Result for ${taskId}

- **Status**: Completed
- **Execution Agent**: Local Query Analyzer Agent
- **Finished At**: ${new Date().toISOString()}

## Summary of Findings
1. Index missing on \`orders.created_at\`.
2. Add compound index: \`CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);\`.
3. Observed query time dropped from 1200ms to 4ms.
`;

  console.log(`Writing mock result to: ${resultFilePath}`);
  fs.writeFileSync(resultFilePath, mockResultContent, "utf8");

  const completedResult = await client.callTool({
    name: "read_result",
    arguments: {
      task_id: taskId,
    },
  });

  console.log("\nServer output for completed task:");
  console.log(JSON.stringify(completedResult, null, 2));

  // Assertions for Test 3
  assert.ok(!completedResult.isError, "read_result for existing result should succeed");
  const completedText = (completedResult.content as Array<{ type: string; text: string }>)[0].text;
  assert.equal(completedText, mockResultContent, "read_result must return exact content of the result file");
  console.log("✓ Assertion passed: read_result returned exact result file content.");

  // Step 4: Calling read_result on non-existent task_id
  console.log("\n-------------------------------------------------");
  console.log("[Test 4] Calling read_result for a non-existent task_id (should be pending, not crash)");
  console.log("-------------------------------------------------");
  const nonExistentTaskId = "task_nonexistent_999999";
  const nonExistentResult = await client.callTool({
    name: "read_result",
    arguments: {
      task_id: nonExistentTaskId,
    },
  });
  console.log(`Server output for non-existent task_id (${nonExistentTaskId}):`);
  console.log(JSON.stringify(nonExistentResult, null, 2));

  // Assertions for Test 4
  assert.ok(!nonExistentResult.isError, "read_result for non-existent task should not crash or error");
  const nonExistentText = (nonExistentResult.content as Array<{ type: string; text: string }>)[0].text;
  assert.ok(nonExistentText.includes("Pending"), "read_result response must describe pending status for non-existent task");
  assert.ok(nonExistentText.includes(nonExistentTaskId), "read_result response must reference non-existent task ID");
  console.log("✓ Assertion passed: read_result gracefully handled non-existent task_id.");

  // Step 5: Calling read_result with path traversal string ../etc/passwd
  console.log("\n-------------------------------------------------");
  console.log("[Test 5] Calling read_result with path traversal payload: ../etc/passwd (should be rejected)");
  console.log("-------------------------------------------------");
  const traversalPayload = "../etc/passwd";
  const rejectedResult = await client.callTool({
    name: "read_result",
    arguments: {
      task_id: traversalPayload,
    },
  });
  console.log(`Server output for payload "${traversalPayload}":`);
  console.log(JSON.stringify(rejectedResult, null, 2));

  // Assertions for Test 5
  assert.equal(rejectedResult.isError, true, "read_result must set isError: true when malicious task_id is passed");
  const rejectedText = (rejectedResult.content as Array<{ type: string; text: string }>)[0].text;
  assert.ok(rejectedText.includes("Invalid task_id"), "Error message must state task_id is invalid");
  assert.ok(rejectedText.includes("path traversal"), "Error message must mention path traversal prevention");
  console.log("✓ Assertion passed: Path traversal attempt was strictly rejected with isError: true.");

  // Step 6: list_models tool
  console.log("\n-------------------------------------------------");
  console.log("[Test 6] Calling list_models");
  console.log("-------------------------------------------------");
  const modelsResult = await client.callTool({
    name: "list_models",
    arguments: {},
  });
  assert.ok(!modelsResult.isError, "list_models must succeed without error");
  const modelsJson = JSON.parse((modelsResult.content as Array<{ type: string; text: string }>)[0].text);
  assert.ok(modelsJson.codex, "list_models must include codex report");
  assert.ok(Array.isArray(modelsJson.codex.models), "codex must list models array");
  assert.ok(Array.isArray(modelsJson.codex.supportedReasoningEfforts), "codex must list supportedReasoningEfforts");
  console.log("Codex models count:", modelsJson.codex.models.length);
  console.log("Codex current default:", JSON.stringify(modelsJson.codex.currentDefault));
  console.log("✓ Assertion passed: list_models returned valid agent models report.");

  // Step 7: send_task with custom model and reasoning_effort
  console.log("\n-------------------------------------------------");
  console.log("[Test 7] Calling send_task with custom model and reasoning_effort");
  console.log("-------------------------------------------------");
  const advancedSendResult = await client.callTool({
    name: "send_task",
    arguments: {
      prompt: "Refactor database queries using compound index",
      title: "Custom Model Task",
      model: "gpt-6.1-sol",
      reasoning_effort: "high",
    },
  });
  assert.ok(!advancedSendResult.isError, "send_task with model and reasoning_effort must succeed");
  const advancedText = (advancedSendResult.content as Array<{ type: string; text: string }>)[0].text;
  assert.ok(advancedText.includes("model: gpt-6.1-sol"), "Response must mention model");
  assert.ok(advancedText.includes("reasoning_effort: high"), "Response must mention reasoning_effort");

  const advTaskIdMatch = advancedText.match(/task_id:\s*([^\s\r\n]+)/);
  assert.ok(advTaskIdMatch, "Must parse task_id from response");
  const advTaskId = advTaskIdMatch[1];
  const advTaskFilePath = path.join(rootDir, "tasks", `${advTaskId}.md`);
  const advTaskContent = fs.readFileSync(advTaskFilePath, "utf8");
  assert.ok(advTaskContent.includes("- **Model**: gpt-6.1-sol"), "Task file must contain Model header");
  assert.ok(advTaskContent.includes("- **Reasoning Effort**: high"), "Task file must contain Reasoning Effort header");
  console.log("✓ Assertion passed: send_task with model and reasoning_effort verified on disk.");

  // Clean up
  console.log("\n-------------------------------------------------");
  console.log("[Cleanup] Closing client connection");
  console.log("-------------------------------------------------");
  await client.close();
  console.log("All assertions passed successfully!");
}

runTests().catch((err) => {
  console.error("Test runner encountered an error:", err);
  process.exit(1);
});
