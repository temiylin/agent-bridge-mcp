import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgeMcpServer } from "../src/server.js";
import { startHttpServer } from "../src/http-server.js";
import { writeStatus } from "../src/status.js";

function initTestGitRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["branch", "-M", "develop"], { cwd: dir, stdio: "ignore" });
}

async function runTests() {
  console.log("=================================================");
  console.log("   Project Configuration Management Test Suite   ");
  console.log("=================================================\n");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ab-proj-cfg-test-"));
  const repoDir = path.join(tmpRoot, "vision_hub");
  const legacyRepoDir = path.join(tmpRoot, "legacy_repo");
  const nonGitDir = path.join(tmpRoot, "not_a_git_repo");
  fs.mkdirSync(nonGitDir, { recursive: true });

  initTestGitRepo(repoDir);
  initTestGitRepo(legacyRepoDir);

  // Configure remotes in vision_hub:
  // origin -> Gitee (should be forbidden by URL!)
  // github -> GitHub (allowed push remote)
  spawnSync("git", ["remote", "add", "origin", "https://gitee.com/org/vision_hub.git"], { cwd: repoDir });
  spawnSync("git", ["remote", "add", "github", "https://github.com/org/vision_hub.git"], { cwd: repoDir });

  // Configure agents.json with a fast mock agent so send_task can run quickly
  fs.writeFileSync(
    path.join(tmpRoot, "agents.json"),
    JSON.stringify(
      {
        "mock-agent": {
          command: process.execPath,
          args: ["-e", "console.log('mock agent done')"],
          input: "stdin",
        },
        "override-agent": {
          command: process.execPath,
          args: ["-e", "console.log('override agent done')"],
          input: "stdin",
        },
      },
      null,
      2
    ),
    "utf8"
  );

  // Set secret in process.env to verify it is NEVER exposed in list_projects or GET /api/projects
  process.env.VISION_HUB_SECRET_TOKEN = "super_secret_token_value_999";

  const bridgeInstance = createBridgeMcpServer(tmpRoot);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "proj-test-client", version: "1.0.0" }, { capabilities: {} });

  await bridgeInstance.server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // ------------------------------------------------------------------
    // 1. Path Validation on add_project
    // ------------------------------------------------------------------
    console.log("[Test 1] Validating repo_path on add_project...");
    const nonExistentRes = await client.callTool({
      name: "add_project",
      arguments: {
        id: "bad_proj",
        repo_path: path.join(tmpRoot, "does_not_exist"),
      },
    });
    assert.strictEqual(nonExistentRes.isError, true, "Non-existent repo_path must fail");

    const nonGitRes = await client.callTool({
      name: "add_project",
      arguments: {
        id: "bad_proj_2",
        repo_path: nonGitDir,
      },
    });
    assert.strictEqual(nonGitRes.isError, true, "Non-git directory must fail");

    // ------------------------------------------------------------------
    // 2. Callback Headers Secret Protection
    // ------------------------------------------------------------------
    console.log("[Test 2] Enforcing env-var-only callback_headers...");
    const rawSecretRes = await client.callTool({
      name: "add_project",
      arguments: {
        id: "bad_secret_proj",
        repo_path: repoDir,
        callback_headers: {
          Authorization: "Bearer raw_secret_token_literal_123",
        },
      },
    });
    assert.strictEqual(rawSecretRes.isError, true, "Raw secret with spaces/Bearer must be rejected");

    // Valid add_project
    const addRes = await client.callTool({
      name: "add_project",
      arguments: {
        id: "vision_hub",
        name: "Vision Hub",
        repo_path: repoDir,
        repo: "org/vision_hub",
        default_base_branch: "develop",
        push_remote: "github",
        forbidden_remotes: ["gitee.com"],
        default_agent: "mock-agent",
        default_model: "gemini-2.5-pro",
        default_account: "pool_acc_1",
        default_timeout_seconds: 1200,
        callback_url: "http://127.0.0.1:9999/webhook",
        callback_headers: {
          Authorization: "$VISION_HUB_SECRET_TOKEN",
        },
        verify_pr: {
          test_commands: ["pnpm build", "pytest"],
          timeout_seconds: 300,
        },
      },
    });
    assert.ok(!addRes.isError, `add_project should succeed: ${JSON.stringify(addRes.content)}`);

    // Verify list_projects never exposes the secret value from process.env
    const listRes = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    const listText = (listRes.content as any)[0].text;
    assert.ok(!listText.includes("super_secret_token_value_999"), "Secret value must never be exposed in list_projects");
    const listData = JSON.parse(listText);
    const vhProj = listData.projects.find((p: any) => p.id === "vision_hub");
    assert.ok(vhProj, "vision_hub must be listed");
    assert.strictEqual(vhProj.callback_headers.Authorization, "$VISION_HUB_SECRET_TOKEN");
    assert.strictEqual(vhProj.path_valid, true);
    console.log("✓ Test 1 & 2 passed: Path validation & callback env-var sanitization verified.");

    // ------------------------------------------------------------------
    // 3. URL-based forbidden_remotes in git_push (without touching .git/config)
    // ------------------------------------------------------------------
    console.log("[Test 3] Testing URL-based forbidden_remotes in git_push...");
    const gitConfigBefore = fs.readFileSync(path.join(repoDir, ".git", "config"), "utf8");
    const hooksExistBefore = fs.existsSync(path.join(repoDir, ".git", "hooks", "pre-push"));

    // Attempt to push to "origin" (whose URL is https://gitee.com/org/vision_hub.git)
    const pushOriginRes = await client.callTool({
      name: "git_push",
      arguments: {
        repo_path: repoDir,
        project_id: "vision_hub",
        remote: "origin",
        refspec: "develop",
      },
    });
    assert.strictEqual(pushOriginRes.isError, true, "Push to origin (gitee.com URL) must be blocked");
    const pushErrText = (pushOriginRes.content as any)[0].text;
    assert.ok(
      pushErrText.includes("https://gitee.com/org/vision_hub.git") && pushErrText.includes("forbidden by project"),
      `Expected URL-based forbidden_remotes error, got: ${pushErrText}`
    );

    // Ensure main repo's .git/config and hooks were NOT modified
    const gitConfigAfter = fs.readFileSync(path.join(repoDir, ".git", "config"), "utf8");
    const hooksExistAfter = fs.existsSync(path.join(repoDir, ".git", "hooks", "pre-push"));
    assert.strictEqual(gitConfigAfter, gitConfigBefore, ".git/config in main repo must NEVER be modified");
    assert.strictEqual(hooksExistAfter, hooksExistBefore, "pre-push hook must NEVER be installed in main repo");
    console.log("✓ Test 3 passed: URL-based forbidden_remotes blocked push to Gitee without touching .git/config.");

    // ------------------------------------------------------------------
    // 4. Dispatching with project_id & Single-Task Override & Legacy paths[0]
    // ------------------------------------------------------------------
    console.log("[Test 4] Testing send_task with project_id defaults, overrides, and legacy paths[0]...");
    // Add a legacy project directly to projects.json using only paths: [legacyRepoDir]
    const projectsJsonPath = path.join(tmpRoot, "projects.json");
    const rawCfg = JSON.parse(fs.readFileSync(projectsJsonPath, "utf8"));
    rawCfg.projects["legacy_proj"] = {
      name: "Legacy Project",
      paths: [legacyRepoDir],
      default_agent: "mock-agent",
    };
    fs.writeFileSync(projectsJsonPath, JSON.stringify(rawCfg, null, 2), "utf8");

    // 4a. send_task with project_id="vision_hub" and no work_dir/agent/model
    const sendDefaultRes = await client.callTool({
      name: "send_task",
      arguments: {
        project_id: "vision_hub",
        title: "Test Project Defaults",
        prompt: "Fix bug in vision_hub",
      },
    });
    assert.ok(!sendDefaultRes.isError, `send_task with project_id should succeed: ${JSON.stringify(sendDefaultRes.content)}`);
    const sendText = (sendDefaultRes.content as any)[0].text;
    const taskIdMatch = sendText.match(/task_id:\s*([^\s\n]+)/);
    assert.ok(taskIdMatch, "task_id should be returned");
    const taskId1 = taskIdMatch[1];

    const task1Md = fs.readFileSync(path.join(tmpRoot, "tasks", `${taskId1}.md`), "utf8");
    const realRepoDir = fs.realpathSync(repoDir);
    assert.ok(task1Md.includes(`- **Project ID**: vision_hub`));
    assert.ok(task1Md.includes(`- **Project Name**: Vision Hub`));
    assert.ok(task1Md.includes(`- **Project Dir**: ${realRepoDir}`) || task1Md.includes(`- **Project Dir**: ${repoDir}`));
    assert.ok(task1Md.includes(`- **Agent**: mock-agent`));
    assert.ok(task1Md.includes(`- **Model**: gemini-2.5-pro`));
    assert.ok(task1Md.includes(`- **Account**: pool_acc_1`));
    assert.ok(task1Md.includes(`- **Hard Timeout Seconds**: 1200`));
    assert.ok(task1Md.includes(`- **Callback URL**: http://127.0.0.1:9999/webhook`));
    assert.ok(task1Md.includes(`"$VISION_HUB_SECRET_TOKEN"`));
    assert.ok(task1Md.includes("[Project Git Constraints"), "Prompt should include Project Git Constraints note");

    // 4b. Single-task override
    const sendOverrideRes = await client.callTool({
      name: "send_task",
      arguments: {
        project_id: "vision_hub",
        title: "Test Overrides",
        prompt: "Override defaults",
        agent: "override-agent",
        model: "gpt-5",
        timeout_seconds: 300,
      },
    });
    assert.ok(!sendOverrideRes.isError);
    const taskId2 = (sendOverrideRes.content as any)[0].text.match(/task_id:\s*([^\s\n]+)/)[1];
    const task2Md = fs.readFileSync(path.join(tmpRoot, "tasks", `${taskId2}.md`), "utf8");
    assert.ok(task2Md.includes(`- **Agent**: override-agent`));
    assert.ok(task2Md.includes(`- **Model**: gpt-5`));
    assert.ok(task2Md.includes(`- **Hard Timeout Seconds**: 300`));

    // 4c. Legacy paths[0] compatibility
    const sendLegacyRes = await client.callTool({
      name: "send_task",
      arguments: {
        project_id: "legacy_proj",
        title: "Test Legacy paths[0]",
        prompt: "Run in legacy repo",
      },
    });
    assert.ok(!sendLegacyRes.isError, "Legacy paths[0] project must work without migration");
    const taskId3 = (sendLegacyRes.content as any)[0].text.match(/task_id:\s*([^\s\n]+)/)[1];
    const task3Md = fs.readFileSync(path.join(tmpRoot, "tasks", `${taskId3}.md`), "utf8");
    assert.ok(task3Md.includes(`- **Project Dir**: ${legacyRepoDir}`));
    console.log("✓ Test 4 passed: Project defaults, single-task overrides, and legacy paths[0] verified.");

    // ------------------------------------------------------------------
    // 5. Task Status & Project Filtering
    // ------------------------------------------------------------------
    console.log("[Test 5] Testing project name in get_task_status, list_tasks_summary, and list_recent_tasks...");
    const statusRes = await client.callTool({
      name: "get_task_status",
      arguments: { task_id: taskId1 },
    });
    const statusData = JSON.parse((statusRes.content as any)[0].text);
    assert.strictEqual(statusData.projectId, "vision_hub");
    assert.strictEqual(statusData.projectName, "Vision Hub");

    const summaryRes = await client.callTool({
      name: "list_tasks_summary",
      arguments: { project_id: "vision_hub" },
    });
    const summaryData = JSON.parse((summaryRes.content as any)[0].text);
    const summaryTasks = Array.isArray(summaryData) ? summaryData : summaryData.tasks;
    assert.ok(summaryTasks.some((t: any) => t.taskId === taskId1));
    assert.ok(!summaryTasks.some((t: any) => t.taskId === taskId3), "legacy_proj task must be filtered out");

    const recentRes = await client.callTool({
      name: "list_recent_tasks",
      arguments: { project: "vision_hub" },
    });
    const recentData = JSON.parse((recentRes.content as any)[0].text);
    const recentTasks = Array.isArray(recentData) ? recentData : recentData.tasks;
    assert.ok(recentTasks.some((t: any) => t.taskId === taskId1));
    assert.ok(!recentTasks.some((t: any) => t.taskId === taskId3));
    console.log("✓ Test 5 passed: Task status and project filtering verified.");

    // ------------------------------------------------------------------
    // 6. Pre-deletion Active Task Check on remove_project
    // ------------------------------------------------------------------
    console.log("[Test 6] Testing pre-deletion active task check on remove_project...");
    // Simulate an active running task for vision_hub (with live current process PID so reconcile keeps it running)
    const activeTaskId = "20261101-120000-000-activevh";
    writeStatus(tmpRoot, activeTaskId, {
      taskId: activeTaskId,
      state: "running",
      pid: process.pid,
      projectId: "vision_hub",
      projectName: "Vision Hub",
      workDir: repoDir,
    });

    const removeWhileRunningRes = await client.callTool({
      name: "remove_project",
      arguments: { id: "vision_hub" },
    });
    assert.strictEqual(removeWhileRunningRes.isError, true, "remove_project must refuse when task is running");
    assert.ok((removeWhileRunningRes.content as any)[0].text.includes(activeTaskId));

    // Mark active task as completed and mark task1, task2, task3 as completed
    writeStatus(tmpRoot, activeTaskId, { taskId: activeTaskId, state: "completed", projectId: "vision_hub" });
    writeStatus(tmpRoot, taskId1, { taskId: taskId1, state: "completed", projectId: "vision_hub" });
    writeStatus(tmpRoot, taskId2, { taskId: taskId2, state: "completed", projectId: "vision_hub" });
    writeStatus(tmpRoot, taskId3, { taskId: taskId3, state: "completed", projectId: "legacy_proj" });

    // Wait briefly for any spawned background workers from send_task to settle, then ensure all status files are completed
    await new Promise((r) => setTimeout(r, 400));
    writeStatus(tmpRoot, taskId1, { taskId: taskId1, state: "completed", projectId: "vision_hub" });
    writeStatus(tmpRoot, taskId2, { taskId: taskId2, state: "completed", projectId: "vision_hub" });
    writeStatus(tmpRoot, taskId3, { taskId: taskId3, state: "completed", projectId: "legacy_proj" });

    // Also test path moved check before removing: if repo_path disappears, send_task must reject
    const movedRepoDir = path.join(tmpRoot, "legacy_repo_moved");
    fs.renameSync(legacyRepoDir, movedRepoDir);
    const sendMovedRes = await client.callTool({
      name: "send_task",
      arguments: {
        project_id: "legacy_proj",
        title: "Should fail because repo moved",
        prompt: "Test moved repo",
      },
    });
    assert.strictEqual(sendMovedRes.isError, true, "send_task must re-validate repo_path and fail if moved");
    fs.renameSync(movedRepoDir, legacyRepoDir);

    // Now remove legacy_proj (no active tasks)
    const removeOkRes = await client.callTool({
      name: "remove_project",
      arguments: { id: "legacy_proj" },
    });
    assert.ok(!removeOkRes.isError, `remove_project should succeed once no active tasks: ${JSON.stringify(removeOkRes.content)}`);
    console.log("✓ Test 6 passed: Pre-deletion check and dispatch-time path re-validation verified.");

    // ------------------------------------------------------------------
    // 7. HTTP /api/projects Security & DNS Rebinding Protection
    // ------------------------------------------------------------------
    console.log("[Test 7] Testing /api/projects HTTP endpoints & DNS rebinding / Origin / Content-Type guards...");
    const httpHandle = await startHttpServer({ port: 0, host: "127.0.0.1", customRootDir: tmpRoot });
    const baseUrl = `http://127.0.0.1:${httpHandle.port}`;

    try {
      // 7a. DNS Rebinding Host Header check -> 403
      const dnsRebindRes = await fetch(`${baseUrl}/api/projects`, {
        headers: { Host: "evil.attacker.com" },
      });
      // Note: Node's fetch (undici) may ignore forbidden Host header overrides, so test with http.request as well
      const rawHostStatus = await new Promise<number>((resolve, reject) => {
        import("node:http").then(({ default: http }) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: httpHandle.port,
              path: "/api/projects",
              method: "GET",
              headers: { Host: "evil.rebind.com" },
            },
            (res) => resolve(res.statusCode || 0)
          );
          req.on("error", reject);
          req.end();
        });
      });
      assert.strictEqual(rawHostStatus, 403, "Invalid Host header must be rejected with 403");

      // 7b. Cross-Origin POST -> 403
      const crossOriginRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ action: "remove", project_id: "vision_hub" }),
      });
      assert.strictEqual(crossOriginRes.status, 403, "Cross-Origin POST to /api/projects must be rejected with 403");

      // 7c. Wrong Content-Type POST -> 415
      const badContentTypeRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({ action: "remove", project_id: "vision_hub" }),
      });
      assert.strictEqual(badContentTypeRes.status, 415, "Non-JSON Content-Type on POST /api/projects must return 415");

      // 7d. Valid GET /api/projects (sanitizes secrets)
      const getProjsRes = await fetch(`${baseUrl}/api/projects`);
      assert.strictEqual(getProjsRes.status, 200);
      const getProjsBody = await getProjsRes.text();
      assert.ok(!getProjsBody.includes("super_secret_token_value_999"), "GET /api/projects must never leak secret values");

      // 7e. Valid POST /api/projects (update)
      const updateHttpRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: "vision_hub",
          default_timeout_seconds: 2400,
        }),
      });
      assert.strictEqual(updateHttpRes.status, 200);
      const updateData = await updateHttpRes.json();
      assert.strictEqual(updateData.success, true);
      assert.strictEqual(updateData.project.default_timeout_seconds, 2400);
      console.log("✓ Test 7 passed: /api/projects security & CRUD verified.");
    } finally {
      await httpHandle.close();
    }

    console.log("\n🎉 ALL PROJECT CONFIG MANAGEMENT TESTS PASSED!");
  } finally {
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("❌ Project config test failed:", err);
  process.exit(1);
});
