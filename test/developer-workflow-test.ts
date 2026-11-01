import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGitTools } from "../src/git-tools.js";
import { registerProjectTools, addProject } from "../src/project-tools.js";
import { registerRequirementsTools } from "../src/requirements-tools.js";
import { registerPlanTools } from "../src/plan-tools.js";
import { registerQueueTools } from "../src/queue-tools.js";
import { writeStatus, readStatus, formatPreviousTaskContext } from "../src/status.js";
import { dispatchTaskDirect } from "../src/queue-dispatcher.js";
import { createPlan } from "../src/plans.js";
import { writeRequirement, generateRequirementId } from "../src/requirements.js";

async function main() {
  console.log("=== Testing High-Leverage Developer Capabilities & Workflows ===");

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-dev-workflow-test-"));
  const dummyRepo = path.join(testDir, "repo");
  fs.mkdirSync(dummyRepo, { recursive: true });

  // Init git repo
  spawnSync("git", ["init", "-b", "main"], { cwd: dummyRepo });
  spawnSync("git", ["config", "user.name", "Tester"], { cwd: dummyRepo });
  spawnSync("git", ["config", "user.email", "test@test.local"], { cwd: dummyRepo });
  fs.writeFileSync(path.join(dummyRepo, "README.md"), "# Test Repo\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: dummyRepo });
  spawnSync("git", ["commit", "-m", "Initial commit"], { cwd: dummyRepo });

  const dummyLogger: any = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const server = new McpServer({ name: "dev-workflow-test", version: "1.0.0" });
  registerGitTools(server, testDir, dummyLogger);
  registerProjectTools(server, testDir, dummyLogger);
  registerPlanTools(server, testDir, dummyLogger);
  registerRequirementsTools(server, testDir, dummyLogger);
  registerQueueTools(server, testDir, dummyLogger);

  // 1. Setup a project
  console.log("1. Setting up project...");
  addProject(testDir, {
    id: "dev-core",
    name: "Developer Core",
    repo_path: dummyRepo,
    default_base_branch: "main",
  });

  // 2. Test git_branches
  console.log("2. Testing git_branches...");
  const gitBranchesTool = (server as any)._registeredTools?.["git_branches"];
  assert.ok(gitBranchesTool, "git_branches must be registered");
  const branchesRes = await gitBranchesTool.handler({ project_id: "dev-core" });
  assert.strictEqual(branchesRes.isError, undefined);
  const branchesData = JSON.parse(branchesRes.content[0].text);
  assert.strictEqual(branchesData.success, true);
  assert.strictEqual(branchesData.current_branch, "main");
  assert.ok(branchesData.local_branches.some((b: any) => b.name === "main" && b.is_current));
  console.log("✓ git_branches correctly lists branches and current branch");

  // 3. Test git_create_branch
  console.log("3. Testing git_create_branch...");
  const gitCreateBranchTool = (server as any)._registeredTools?.["git_create_branch"];
  assert.ok(gitCreateBranchTool, "git_create_branch must be registered");

  // Create feat/new-feature
  const createRes1 = await gitCreateBranchTool.handler({
    project_id: "dev-core",
    branch: "feat/new-feature",
    checkout: true,
  });
  assert.strictEqual(createRes1.isError, undefined);
  const createData1 = JSON.parse(createRes1.content[0].text);
  assert.strictEqual(createData1.success, true);
  assert.strictEqual(createData1.branch, "feat/new-feature");
  assert.strictEqual(createData1.checked_out, true);

  // Verify duplicate branch name fails safely
  const createRes2 = await gitCreateBranchTool.handler({
    project_id: "dev-core",
    branch: "feat/new-feature",
  });
  assert.strictEqual(createRes2.isError, true);
  assert.ok(createRes2.content[0].text.includes("already exists"));

  // Verify invalid branch name fails safely
  const createRes3 = await gitCreateBranchTool.handler({
    project_id: "dev-core",
    branch: "invalid branch with spaces",
  });
  assert.strictEqual(createRes3.isError, true);
  assert.ok(createRes3.content[0].text.includes("Invalid branch name"));
  console.log("✓ git_create_branch safely creates branches and guards against duplicates/invalid names");

  // 4. Test project_summary
  console.log("4. Testing project_summary...");
  // Create an active plan
  const plan = createPlan(testDir, {
    project_id: "dev-core",
    title: "Auth Migration Plan",
    steps: [
      { id: "s1", title: "Step 1", detail: "Schema" },
      { id: "s2", title: "Step 2", detail: "API" },
    ],
  });

  // Create a draft requirement
  writeRequirement(testDir, {
    id: generateRequirementId(),
    title: "Add OAuth2 support",
    description: "Support Google and GitHub logins",
    project: "dev-core",
    status: "draft",
    pr_url: "https://github.com/org/repo/pull/42",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Write a dirty file to dummy repo
  fs.writeFileSync(path.join(dummyRepo, "dirty.txt"), "hello", "utf8");

  const projectSummaryTool = (server as any)._registeredTools?.["project_summary"];
  assert.ok(projectSummaryTool, "project_summary must be registered");
  const summaryRes = await projectSummaryTool.handler({ project_id: "dev-core" });
  assert.strictEqual(summaryRes.isError, undefined);
  const summaryData = JSON.parse(summaryRes.content[0].text);
  assert.strictEqual(summaryData.success, true);
  assert.strictEqual(summaryData.project.id, "dev-core");
  assert.strictEqual(summaryData.git.is_clean, false);
  assert.strictEqual(summaryData.git.untracked, 1);
  assert.strictEqual(summaryData.plans.total_plans, 1);
  assert.strictEqual(summaryData.requirements.draft_count, 1);
  console.log("✓ project_summary collates git, plans, requirements, and tasks in 1 turn");

  // 5. Test formatPreviousTaskContext and Task Chaining
  console.log("5. Testing Task Chaining (previous_task_id)...");
  const prevTaskId = "task_20261101_000000_1111";
  writeStatus(testDir, prevTaskId, {
    state: "completed",
    outcome: "ready",
    projectId: "dev-core",
    pr_url: "https://github.com/org/repo/pull/101",
    report: {
      outcome: "ready",
      summary: "Refactored JWT handler and passed unit tests",
      pr_url: "https://github.com/org/repo/pull/101",
      question: null,
    },
  });

  const ctx = formatPreviousTaskContext(testDir, prevTaskId);
  assert.strictEqual(ctx.status?.state, "completed");
  assert.strictEqual(ctx.prUrl, "https://github.com/org/repo/pull/101");
  assert.strictEqual(ctx.projectId, "dev-core");
  assert.ok(ctx.prefix.includes("Refactored JWT handler"));
  assert.ok(ctx.prefix.includes("https://github.com/org/repo/pull/101"));

  // Dispatch a chained task via dispatchTaskDirect
  const dispatchRes = dispatchTaskDirect(testDir, {
    prompt: "Write integration tests for the JWT handler",
    previous_task_id: prevTaskId,
  });

  assert.ok(dispatchRes.taskId);
  const newTaskContent = fs.readFileSync(dispatchRes.taskFilePath, "utf8");
  assert.ok(newTaskContent.includes(`- **Previous Task ID**: ${prevTaskId}`));
  assert.ok(newTaskContent.includes("- **PR URL**: https://github.com/org/repo/pull/101"));
  assert.ok(newTaskContent.includes("- **Project ID**: dev-core"));
  assert.ok(newTaskContent.includes("[Context from Previous Task: task_20261101_000000_1111]"));

  const newStatus = readStatus(testDir, dispatchRes.taskId);
  assert.strictEqual(newStatus?.previousTaskId, prevTaskId);
  assert.strictEqual(newStatus?.pr_url, "https://github.com/org/repo/pull/101");
  assert.strictEqual(newStatus?.projectId, "dev-core");
  console.log("✓ Task chaining seamlessly propagates context, PR URL, and project linkage");

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log("\n=== ALL DEVELOPER WORKFLOW TESTS PASSED! ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
