import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAgentAdminServer } from "../scripts/agent-admin.mjs";

const TEST_ROOT_BASE = "/tmp/agent-bridge-admin-test";
let TEST_ROOT: string;
const PRESET = {
  command: "codex",
  args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"],
  input: "stdin",
};

function jsonBody(response: Response): Promise<any> {
  return response.json();
}

function requestStatusWithHeaders(url: string, headers: http.OutgoingHttpHeaders): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      headers,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode || 0));
    });
    request.on("error", reject);
  });
}

async function main() {
  assert.equal(process.env.AGENT_BRIDGE_ROOT, TEST_ROOT_BASE, "Tests must only use the isolated /tmp root.");
  TEST_ROOT = fs.mkdtempSync(`${TEST_ROOT_BASE}-`);
  const originalRegistry = {
    existing: { command: "existing-agent", args: ["run"], input: "stdin" },
  };
  const agentsPath = path.join(TEST_ROOT, "agents.json");
  fs.writeFileSync(agentsPath, JSON.stringify(originalRegistry, null, 2), "utf8");

  let failRename = false;
  let failBackupCreation = false;
  let failTempWrite = false;
  let failTempValidation = false;
  let failRestoreCopy = false;
  let failRestoreBackupLookup = false;
  let failRestoreValidation = false;
  let failPostWriteValidation = false;
  let failTargetUnlink = false;
  let failTempCleanup = false;
  let restoredBackup = false;
  let agentsJsonReadCount = 0;
  const fileSystem = {
    mkdirSync: fs.mkdirSync.bind(fs),
    existsSync: (filePath: Parameters<typeof fs.existsSync>[0]) => {
      if (failRestoreBackupLookup && typeof filePath === "string" && path.basename(filePath).startsWith("agents.json.bak-")) {
        return false;
      }
      return fs.existsSync(filePath);
    },
    lstatSync: fs.lstatSync.bind(fs),
    readFileSync: (filePath: Parameters<typeof fs.readFileSync>[0], options?: any) => {
      const fileName = String(filePath);
      if (failTempValidation && path.basename(fileName).startsWith(".agents.json.") && fileName.endsWith(".tmp")) {
        failTempValidation = false;
        throw new Error("simulated temporary-file validation failure");
      }
      if (failPostWriteValidation && filePath === agentsPath) {
        agentsJsonReadCount += 1;
        if (agentsJsonReadCount === 2) {
          failPostWriteValidation = false;
          throw new Error("simulated post-write validation failure");
        }
      }
      if (failRestoreValidation && restoredBackup && filePath === agentsPath) {
        failRestoreValidation = false;
        restoredBackup = false;
        throw new Error("simulated restored registry validation failure");
      }
      return fs.readFileSync(filePath as any, options);
    },
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
      const source = args[0];
      const destination = args[1];
      if (failBackupCreation && source === agentsPath && typeof destination === "string" && path.basename(destination).startsWith("agents.json.bak-")) {
        throw new Error("simulated backup creation failure");
      }
      if (failRestoreCopy && typeof source === "string" && path.basename(source).startsWith("agents.json.bak-")) {
        throw new Error("simulated recovery copy failure");
      }
      const result = fs.copyFileSync(...args);
      if (typeof source === "string" && path.basename(source).startsWith("agents.json.bak-") && destination === agentsPath) {
        restoredBackup = true;
      }
      return result;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (failTempWrite && typeof args[0] === "string" && path.basename(args[0]).startsWith(".agents.json.")) {
        throw new Error("simulated temporary-file write failure");
      }
      return fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (failRename) throw new Error("simulated atomic rename failure");
      return fs.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (failTargetUnlink && args[0] === agentsPath) {
        throw new Error("simulated recovery unlink failure");
      }
      if (failTempCleanup && typeof args[0] === "string" && path.basename(args[0]).startsWith(".agents.json.") && args[0].endsWith(".tmp")) {
        throw new Error("simulated temporary-file cleanup failure");
      }
      return fs.unlinkSync(...args);
    },
  };

  const { server, token } = createAgentAdminServer({ rootDir: TEST_ROOT, port: 0, fileSystem });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1", "Admin server must bind only to loopback.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const pageUrl = `${baseUrl}/?token=${encodeURIComponent(token)}`;
    const originalText = fs.readFileSync(agentsPath, "utf8");

    const missingToken = await fetch(`${baseUrl}/`);
    assert.equal(missingToken.status, 403, "GET without a token must be rejected.");
    const wrongToken = await fetch(`${baseUrl}/?token=wrong`);
    assert.equal(wrongToken.status, 403, "GET with a wrong token must be rejected.");
    const postWithoutToken = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    assert.equal(postWithoutToken.status, 403, "POST without X-Admin-Token must be rejected.");
    const postWithWrongToken = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": "wrong" },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    assert.equal(postWithWrongToken.status, 403, "POST with a wrong X-Admin-Token must be rejected.");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), originalText, "Unauthorized POSTs must not mutate agents.json.");

    const evilHostStatus = await requestStatusWithHeaders(pageUrl, { Host: "evil.example" });
    assert.equal(evilHostStatus, 403, "Unexpected Host must be rejected.");

    const evilOrigin = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token, Origin: "http://evil.example" },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    assert.equal(evilOrigin.status, 403, "Cross-origin POST must be rejected.");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), originalText, "Rejected requests must not mutate agents.json.");

    const enable = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    assert.equal(enable.status, 200);
    const afterEnable = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
    assert.deepEqual(afterEnable.codex, PRESET, "Enabled codex entry must exactly match the preset.");
    assert.deepEqual(afterEnable.existing, originalRegistry.existing, "Unrelated agents must be preserved.");

    const disable = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: false }),
    });
    assert.equal(disable.status, 200);
    const afterDisable = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
    assert.equal(Object.hasOwn(afterDisable, "codex"), false, "Disabled codex entry must be removed.");
    assert.deepEqual(afterDisable.existing, originalRegistry.existing);
    assert.ok(fs.readdirSync(TEST_ROOT).some((name) => name.startsWith("agents.json.bak-")), "Disable must create a backup.");

    const unchangedText = fs.readFileSync(agentsPath, "utf8");
    const injectedCommand = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true, command: "touch", args: ["/tmp/not-allowed"] }),
    });
    assert.equal(injectedCommand.status, 400, "Client command and args must be rejected.");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText, "Rejected command injection must not mutate agents.json.");

    const unknownAgent = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "agy", enabled: true }),
    });
    assert.equal(unknownAgent.status, 400, "Unlisted agent names must be rejected.");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText);

    failBackupCreation = true;
    const failedBackup = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failBackupCreation = false;
    assert.equal(failedBackup.status, 500, "Backup creation failure must return HTTP 500.");
    assert.match((await failedBackup.json()).error, /simulated backup creation failure/u);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText, "Backup creation failure must preserve the registry.");

    failTempWrite = true;
    const failedTempWrite = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failTempWrite = false;
    assert.equal(failedTempWrite.status, 500, "Temporary-file write failure must return HTTP 500.");
    assert.match((await failedTempWrite.json()).error, /simulated temporary-file write failure/u);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText, "Temporary-file write failure must preserve the registry.");

    failTempValidation = true;
    const failedTempValidation = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    assert.equal(failedTempValidation.status, 500, "Temporary-file validation failure must return HTTP 500.");
    assert.match((await failedTempValidation.json()).error, /simulated temporary-file validation failure/u);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText, "Temporary-file validation failure must preserve the registry.");
    assert.equal(fs.readdirSync(TEST_ROOT).some((name) => name.startsWith(".agents.json.") && name.endsWith(".tmp")), false, "Temporary-file validation failure must clean up its temp file.");

    failRename = true;
    const failedWrite = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failRename = false;
    assert.equal(failedWrite.status, 500, "Simulated write failure must return an error.");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText, "Failed write must preserve the original registry content.");
    assert.equal(fs.readdirSync(TEST_ROOT).some((name) => name.startsWith(".agents.json.") && name.endsWith(".tmp")), false, "Rename failure must clean up its temp file.");

    failRename = true;
    failTempCleanup = true;
    const failedTempCleanup = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failRename = false;
    failTempCleanup = false;
    assert.equal(failedTempCleanup.status, 500, "Temporary-file cleanup failure must return HTTP 500.");
    const failedTempCleanupBody = await failedTempCleanup.json();
    assert.match(failedTempCleanupBody.error, /simulated atomic rename failure/u, "Cleanup error must preserve the original write failure.");
    assert.match(failedTempCleanupBody.error, /temporary file cleanup failed/u, "Cleanup failure must be reported.");
    assert.match(failedTempCleanupBody.error, /simulated temporary-file cleanup failure/u);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText, "Cleanup failure must leave the original registry intact.");
    for (const name of fs.readdirSync(TEST_ROOT).filter((entry) => entry.startsWith(".agents.json.") && entry.endsWith(".tmp"))) {
      fs.unlinkSync(path.join(TEST_ROOT, name));
    }

    const rollbackOriginalText = fs.readFileSync(agentsPath, "utf8");
    failPostWriteValidation = true;
    agentsJsonReadCount = 0;
    const successfulRecovery = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failPostWriteValidation = false;
    assert.equal(successfulRecovery.status, 500, "Post-write validation failure must return an error even when recovery succeeds.");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), rollbackOriginalText, "Successful recovery must restore the original registry content.");

    failRestoreBackupLookup = true;
    failPostWriteValidation = true;
    agentsJsonReadCount = 0;
    const missingRestoreBackup = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failRestoreBackupLookup = false;
    failPostWriteValidation = false;
    assert.equal(missingRestoreBackup.status, 500, "Missing restore backup must return HTTP 500.");
    const missingRestoreBackupBody = await missingRestoreBackup.json();
    assert.match(missingRestoreBackupBody.error, /Backup file is missing/u);
    assert.match(missingRestoreBackupBody.error, /agents\.json\.bak-/u);
    fs.writeFileSync(agentsPath, rollbackOriginalText, "utf8");

    failRestoreValidation = true;
    failPostWriteValidation = true;
    agentsJsonReadCount = 0;
    restoredBackup = false;
    const failedRestoredValidation = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failPostWriteValidation = false;
    failRestoreValidation = false;
    assert.equal(failedRestoredValidation.status, 500, "Restored-registry validation failure must return HTTP 500.");
    const failedRestoredValidationBody = await failedRestoredValidation.json();
    assert.match(failedRestoredValidationBody.error, /simulated post-write validation failure/u);
    assert.match(failedRestoredValidationBody.error, /simulated restored registry validation failure/u);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), rollbackOriginalText, "Restore validation failure must still leave the original bytes in place.");

    const recoveryOriginalText = fs.readFileSync(agentsPath, "utf8");
    const backupNamesBeforeRecoveryFailure = new Set(fs.readdirSync(TEST_ROOT).filter((name) => name.startsWith("agents.json.bak-")));
    failRestoreCopy = true;
    failPostWriteValidation = true;
    agentsJsonReadCount = 0;
    const recoveryFailure = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failRestoreCopy = false;
    failPostWriteValidation = false;
    assert.equal(recoveryFailure.status, 500, "Recovery failure must return HTTP 500.");
    assert.notEqual(recoveryFailure.status, 200, "Recovery failure must not look successful.");
    const recoveryFailureBody = await recoveryFailure.json();
    assert.match(recoveryFailureBody.error, /agents\.json\.bak-/u, "Error must include the backup path.");
    assert.match(recoveryFailureBody.error, /simulated post-write validation failure/u, "Error must include the original write failure.");
    assert.match(recoveryFailureBody.error, /simulated recovery copy failure/u, "Error must include the recovery failure.");
    const backupPathMatch = recoveryFailureBody.error.match(/backup "([^"]+)"/u);
    assert.ok(backupPathMatch, "Error must identify the backup path explicitly.");
    assert.ok(fs.existsSync(backupPathMatch[1]), "Backup must remain available after recovery fails.");
    assert.equal(fs.readFileSync(backupPathMatch[1], "utf8"), recoveryOriginalText, "Backup must retain the original agents.json content.");
    assert.ok(!backupNamesBeforeRecoveryFailure.has(path.basename(backupPathMatch[1])), "Recovery failure test must create a new backup.");

    fs.unlinkSync(agentsPath);
    failTempWrite = true;
    const absentFileTempWriteFailure = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failTempWrite = false;
    assert.equal(absentFileTempWriteFailure.status, 500, "Temporary write failure without an original file must return HTTP 500.");
    assert.equal(fs.existsSync(agentsPath), false, "Failure before target creation must leave agents.json absent.");

    failPostWriteValidation = true;
    agentsJsonReadCount = 1;
    const absentFileRecovery = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failPostWriteValidation = false;
    assert.equal(absentFileRecovery.status, 500, "Post-write failure without an original file must return an error.");
    assert.equal(fs.existsSync(agentsPath), false, "Successful recovery without an original file must remove the new registry.");

    failTargetUnlink = true;
    failPostWriteValidation = true;
    agentsJsonReadCount = 1;
    const absentFileRecoveryFailure = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failTargetUnlink = false;
    failPostWriteValidation = false;
    assert.equal(absentFileRecoveryFailure.status, 500, "Failed recovery unlink must return HTTP 500.");
    const absentFileRecoveryBody = await absentFileRecoveryFailure.json();
    assert.match(absentFileRecoveryBody.error, /no backup available/u, "Missing-original recovery error must explain that no backup exists.");
    assert.match(absentFileRecoveryBody.error, /simulated recovery unlink failure/u, "Missing-original recovery error must include the unlink failure.");
    assert.equal(fs.existsSync(agentsPath), true, "Failed recovery unlink must be surfaced while the new file remains present.");
    fs.unlinkSync(agentsPath);

    console.log("agent-admin tests passed");
  } finally {
    failRename = false;
    failBackupCreation = false;
    failTempWrite = false;
    failTempValidation = false;
    failRestoreBackupLookup = false;
    failTargetUnlink = false;
    failTempCleanup = false;
    failRestoreValidation = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
