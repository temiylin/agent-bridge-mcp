import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_BASE = "/tmp/agent-bridge-repo-status-test";
const TEST_ROOT = path.join(TEST_BASE, "bridge-root");
const TEST_REPO = path.join(TEST_BASE, "repo");

function runGit(args: string[], cwd: string) {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  const res = spawnSync("git", args, {
    cwd,
    shell: false,
    timeout: 5000,
    maxBuffer: 256 * 1024,
    encoding: "utf8",
    env,
  });
  if (res.status !== 0) {
    throw new Error(`Git command failed: git ${args.join(" ")}\n${res.stderr || res.stdout}`);
  }
  return res;
}

async function runRepoStatusTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp repo_status Test Suite");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_BASE}\n`);

  // Reset test directories
  fs.rmSync(TEST_BASE, { recursive: true, force: true });
  fs.mkdirSync(TEST_BASE, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, "logs"), { recursive: true });
  fs.mkdirSync(TEST_REPO, { recursive: true });

  // Initialize a mock repository inside /tmp/agent-bridge-repo-status-test/repo
  console.log("[Setup] Initializing temporary git repository in /tmp/agent-bridge-repo-status-test/repo...");
  runGit(["init", "-b", "main"], TEST_REPO);
  runGit(["config", "user.email", "test@example.com"], TEST_REPO);
  runGit(["config", "user.name", "Test User"], TEST_REPO);

  fs.writeFileSync(path.join(TEST_REPO, "README.md"), "# Mock Repo\n\nInitial readme text.\n", "utf8");
  runGit(["add", "README.md"], TEST_REPO);
  runGit(["commit", "-m", "initial commit"], TEST_REPO);
  runGit(["branch", "develop"], TEST_REPO);

  // Setup mock agents.json in TEST_ROOT for MCP server validation
  fs.writeFileSync(
    path.join(TEST_ROOT, "agents.json"),
    JSON.stringify({ codex: { command: "codex", args: ["exec"], input: "arg" } }, null, 2),
    "utf8"
  );

  console.log("[Setup] Repository and test root initialized.\n");

  // Helper to connect to dist/index.js with specific environment
  async function withClient(
    extraEnv: Record<string, string | undefined>,
    fn: (client: Client) => Promise<void>
  ) {
    const serverPath = path.resolve("dist/index.js");
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) mergedEnv[k] = v;
    }
    mergedEnv["AGENT_BRIDGE_ROOT"] = TEST_ROOT;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) {
        delete mergedEnv[k];
      } else {
        mergedEnv[k] = v;
      }
    }

    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: mergedEnv,
    });
    const client = new Client({ name: "repo-status-test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      await fn(client);
    } finally {
      await client.close();
    }
  }

  // -------------------------------------------------
  // [Test 9a] Unset AGENT_BRIDGE_REPO -> isError: true
  // -------------------------------------------------
  console.log("-------------------------------------------------");
  console.log("[Test 9a] AGENT_BRIDGE_REPO unset");
  console.log("-------------------------------------------------");
  await withClient({ AGENT_BRIDGE_REPO: undefined }, async (client) => {
    const res = await client.callTool({ name: "repo_status" });
    assert.equal(res.isError, true, "Should return isError: true when AGENT_BRIDGE_REPO is unset");
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text || "";
    assert.ok(text.includes("AGENT_BRIDGE_REPO"), "Error message should mention AGENT_BRIDGE_REPO");

    // Check audit.log
    const auditPath = path.join(TEST_ROOT, "logs", "audit.log");
    assert.ok(fs.existsSync(auditPath), "audit.log must exist");
    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const lastAudit = JSON.parse(auditLines[auditLines.length - 1]);
    assert.equal(lastAudit.tool, "repo_status", "Audit record must log tool: 'repo_status'");
    assert.ok(lastAudit.ts, "Audit record must contain timestamp");
    assert.equal(lastAudit.output, undefined, "Audit record must NOT contain output");
  });
  console.log("✓ Test 9a passed: AGENT_BRIDGE_REPO unset rejected with isError: true and audited.\n");

  // -------------------------------------------------
  // [Test 9b] Relative path in AGENT_BRIDGE_REPO -> isError: true
  // -------------------------------------------------
  console.log("-------------------------------------------------");
  console.log("[Test 9b] AGENT_BRIDGE_REPO relative path");
  console.log("-------------------------------------------------");
  await withClient({ AGENT_BRIDGE_REPO: "relative/path/to/repo" }, async (client) => {
    const res = await client.callTool({ name: "repo_status" });
    assert.equal(res.isError, true, "Should return isError: true for relative path");
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text || "";
    assert.ok(text.includes("absolute path"), "Error message should require absolute path");
  });
  console.log("✓ Test 9b passed: Relative path rejected with isError: true.\n");

  // -------------------------------------------------
  // [Test 9c] Path does not exist or missing .git -> isError: true
  // -------------------------------------------------
  console.log("-------------------------------------------------");
  console.log("[Test 9c] Path does not exist or missing .git");
  console.log("-------------------------------------------------");
  await withClient({ AGENT_BRIDGE_REPO: "/tmp/agent-bridge-repo-status-test/nonexistent-dir" }, async (client) => {
    const res = await client.callTool({ name: "repo_status" });
    assert.equal(res.isError, true, "Should return isError: true for non-existent path");
  });

  const emptyDir = path.join(TEST_BASE, "empty-dir");
  fs.mkdirSync(emptyDir, { recursive: true });
  await withClient({ AGENT_BRIDGE_REPO: emptyDir }, async (client) => {
    const res = await client.callTool({ name: "repo_status" });
    assert.equal(res.isError, true, "Should return isError: true for directory lacking .git");
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text || "";
    assert.ok(text.includes(".git"), "Error message should mention missing .git");
  });
  console.log("✓ Test 9c passed: Nonexistent directory and missing .git rejected with isError: true.\n");

  // -------------------------------------------------
  // [Test 9d] Normal repository status and SECRET_FILE_BODY privacy check
  // -------------------------------------------------
  console.log("-------------------------------------------------");
  console.log("[Test 9d] Normal repository & privacy check");
  console.log("-------------------------------------------------");
  const SECRET_FILE_BODY = "SECRET_FILE_BODY_XYZ_SENSITIVE_123456789";
  fs.writeFileSync(path.join(TEST_REPO, "README.md"), `# Title\n\n${SECRET_FILE_BODY}\n`, "utf8");

  await withClient({ AGENT_BRIDGE_REPO: TEST_REPO }, async (client) => {
    const res = await client.callTool({ name: "repo_status" });
    assert.equal(res.isError, undefined, "Should not return isError on valid repo");
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text || "";

    console.log("repo_status output preview:\n" + text + "\n");

    // Must contain branch name
    assert.ok(text.includes("Branch: main"), "Output must contain branch name");
    assert.ok(text.includes("Status Summary:"), "Output must contain status summary section");
    assert.ok(text.includes("Refs:"), "Output must contain refs section");
    assert.ok(text.includes("Recent Commits:"), "Output must contain recent commits section");

    // Must NOT leak file body
    assert.ok(
      !text.includes(SECRET_FILE_BODY),
      `Output must strictly NOT contain SECRET_FILE_BODY ("${SECRET_FILE_BODY}")`
    );

    // Verify ref handling: develop exists, origin/main missing
    assert.ok(text.includes("develop:"), "Refs section must list develop");
    assert.ok(text.includes("origin/main: missing"), "Missing refs must be marked as missing");
  });
  console.log("✓ Test 9d passed: Normal repo status verified, branch name present, SECRET_FILE_BODY not leaked.\n");

  // -------------------------------------------------
  // [Test 9e] Output exceeds 8000 characters is truncated
  // -------------------------------------------------
  console.log("-------------------------------------------------");
  console.log("[Test 9e] Output truncation at 8000 characters");
  console.log("-------------------------------------------------");
  // Generate many untracked files with long names to exceed 8000 characters in git status
  const tempFiles: string[] = [];
  for (let i = 0; i < 200; i++) {
    const fn = `untracked_long_padding_entry_${i}_${"x".repeat(40)}.txt`;
    const fp = path.join(TEST_REPO, fn);
    fs.writeFileSync(fp, "padding", "utf8");
    tempFiles.push(fp);
  }

  try {
    await withClient({ AGENT_BRIDGE_REPO: TEST_REPO }, async (client) => {
      const res = await client.callTool({ name: "repo_status" });
      assert.equal(res.isError, undefined, "Should succeed even with large status output");
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text || "";

      assert.ok(
        text.length <= 8000,
        `Output length must be <= 8000 characters (actual: ${text.length})`
      );
      assert.ok(
        text.includes("[Output truncated: exceeded 8000 characters limit]"),
        "Output must include truncation notice"
      );
    });
  } finally {
    for (const fp of tempFiles) {
      try {
        fs.unlinkSync(fp);
      } catch {}
    }
  }
  console.log("✓ Test 9e passed: Output exceeding 8000 characters properly truncated with notice.\n");

  // -------------------------------------------------
  // [Test 9f] Source code static check: no "shell: true", no string concatenated git commands
  // -------------------------------------------------
  console.log("-------------------------------------------------");
  console.log("[Test 9f] Source code inspection on src/repo-status.ts");
  console.log("-------------------------------------------------");
  const sourceCode = fs.readFileSync(path.resolve("src/repo-status.ts"), "utf8");

  assert.ok(!sourceCode.includes("shell: true"), 'src/repo-status.ts must not contain "shell: true"');
  assert.ok(sourceCode.includes("shell: false"), 'src/repo-status.ts must explicitly specify "shell: false"');
  assert.ok(!sourceCode.match(/execSync\s*\(/), "src/repo-status.ts must not use execSync");
  assert.ok(!sourceCode.match(/exec\s*\(/), "src/repo-status.ts must not use exec");
  assert.ok(
    !sourceCode.match(/spawnSync\s*\(\s*["'`]git\s+/),
    "src/repo-status.ts must not use command-string concatenation in spawnSync"
  );
  assert.ok(
    !sourceCode.match(/`\s*git\s+/),
    "src/repo-status.ts must not construct git command strings via template literals"
  );

  console.log("✓ Test 9f passed: Source code verified to have shell: false and no command-string concatenation.\n");

  console.log("=================================================");
  console.log("  All repo_status tests passed successfully!     ");
  console.log("=================================================");
}

runRepoStatusTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
