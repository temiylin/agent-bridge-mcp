import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAgentAdminServer } from "../scripts/agent-admin.mjs";

const TEST_ROOT = "/tmp/agent-bridge-admin-test";
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
  assert.equal(process.env.AGENT_BRIDGE_ROOT, TEST_ROOT, "Tests must only use the isolated /tmp root.");
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const originalRegistry = {
    existing: { command: "existing-agent", args: ["run"], input: "stdin" },
  };
  const agentsPath = path.join(TEST_ROOT, "agents.json");
  fs.writeFileSync(agentsPath, JSON.stringify(originalRegistry, null, 2), "utf8");

  let failRename = false;
  const fileSystem = {
    mkdirSync: fs.mkdirSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    lstatSync: fs.lstatSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    copyFileSync: fs.copyFileSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (failRename) throw new Error("simulated atomic rename failure");
      return fs.renameSync(...args);
    },
    unlinkSync: fs.unlinkSync.bind(fs),
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

    failRename = true;
    const failedWrite = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": token },
      body: JSON.stringify({ name: "codex", enabled: true }),
    });
    failRename = false;
    assert.equal(failedWrite.status, 500, "Simulated write failure must return an error.");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), unchangedText, "Failed write must preserve the original registry content.");

    console.log("agent-admin tests passed");
  } finally {
    failRename = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
