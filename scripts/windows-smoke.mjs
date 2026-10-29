#!/usr/bin/env node
// Deployment checks use unique fixtures in the system temporary directory.
// Local inference is opt-in with --e2e; ordinary checks are read-only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveCodexExecutable } from "./resolve-codex.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(os.tmpdir(), "agent-bridge-smoke");
const argv = process.argv.slice(2);
const remoteIndex = argv.indexOf("--remote");
const rootIndex = argv.indexOf("--root");
const remoteMode = remoteIndex >= 0;
// Inference is opt-in: ordinary validation must not consume model usage.
const runAgent = argv.includes("--e2e");
let token = "";
let remoteUrl = "";
let activeTaskId;
let worker;
let workerFd;
let client;

function safeMessage(error) {
  let message = error?.message || String(error);
  if (token) message = message.split(token).join("[device-token]");
  if (remoteUrl) message = message.split(remoteUrl).join("[relay-endpoint]");
  return message;
}

function textOf(result) {
  return (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 25000 });
  assert.ok(!result.isError, `${name} returned a tool error`);
  return result;
}

function parseJson(result) {
  return JSON.parse(textOf(result));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containedTestRoot(target) {
  const absolute = path.resolve(target);
  const relative = path.relative(workRoot, absolute);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "The isolated test directory must be a child of the Agent Bridge smoke-test directory");
  assert.notEqual(absolute.toLowerCase(), repoRoot.toLowerCase(), "Do not use the source repository as test data");
  return absolute;
}

async function testTask(startWorker) {
  const dispatched = await call("send_task", {
    title: "Windows deployment smoke test",
    agent: "codex",
    prompt: "Reply with exactly BRIDGE_WINDOWS_OK. Do not use tools, read files, or modify files.",
  });
  activeTaskId = textOf(dispatched).match(/task_id:\s*([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(activeTaskId, "send_task must return a task ID");
  if (startWorker) startWorker();

  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const status = parseJson(await call("get_task_status", { task_id: activeTaskId }));
    if (["completed", "failed", "cancelled"].includes(status.state)) {
      assert.equal(status.state, "completed", `Codex smoke task ended in state ${status.state}`);
      assert.equal(status.exitCode, 0, "Codex smoke task must exit successfully");
      const result = await call("read_result", { task_id: activeTaskId });
      assert.ok(textOf(result).includes("BRIDGE_WINDOWS_OK"), "Codex result must contain the expected marker");
      console.log("PASS: send_task -> Codex -> completed -> read_result");
      activeTaskId = undefined;
      return;
    }
    if (worker && worker.exitCode !== null) throw new Error("The isolated worker exited before completing its task");
    await wait(1000);
  }
  throw new Error("Codex smoke task exceeded 150 seconds");
}

async function main() {
  assert.equal(process.platform, "win32", "This validation script targets Windows");
  let transport;
  let dataRoot;
  let childEnv;

  if (remoteMode) {
    assert.ok(argv[remoteIndex + 1], "Usage: windows-smoke.mjs --remote <config.json> [--e2e]");
    const config = JSON.parse(fs.readFileSync(path.resolve(argv[remoteIndex + 1]), "utf8").replace(/^\uFEFF/, ""));
    token = config.deviceToken || "";
    assert.ok(/^dev_[a-fA-F0-9]{48}$/.test(token), "Remote configuration must contain a strong deviceToken");
    const base = config.relayHttp || config.relayHttpUrl || config.relayHttpBase || "https://bridge.krow.top/mcp";
    remoteUrl = `${base.replace(/\/$/, "")}/${encodeURIComponent(token)}`;
    assert.equal(new URL(remoteUrl).protocol, "https:", "Remote MCP requires HTTPS");
    transport = new StreamableHTTPClientTransport(new URL(remoteUrl));
  } else {
    fs.mkdirSync(workRoot, { recursive: true });
    dataRoot = rootIndex >= 0
      ? containedTestRoot(argv[rootIndex + 1] || "")
      : fs.mkdtempSync(path.join(workRoot, "smoke-data-"));
    fs.mkdirSync(path.join(dataRoot, "workdir"), { recursive: true });
    const codex = resolveCodexExecutable();
    assert.ok(fs.statSync(codex).isFile(), "The verified native Codex executable must exist");
    const catalogQuery = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "query-native-models.mjs"), codex], { encoding: "utf8", windowsHide: true, shell: false, timeout: 50000 });
    assert.equal(catalogQuery.status, 0, "Native model discovery must succeed");
    const defaultModel = JSON.parse(catalogQuery.stdout).models.find(model => model.isDefault && !model.hidden);
    assert.ok(defaultModel, "The native catalog must return a default model");
    const registryPath = path.join(dataRoot, "agents.json");
    assert.ok(!fs.existsSync(registryPath), "Use a fresh isolated smoke-test directory");
    fs.writeFileSync(registryPath, JSON.stringify({ codex: {
      command: codex,
      args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-c", "mcp_servers.agent-bridge.enabled=false", "-c", `model="${defaultModel.model}"`, "-c", `model_reasoning_effort="${defaultModel.defaultReasoningEffort}"`],
      input: "stdin",
    } }, null, 2));
    childEnv = Object.fromEntries(Object.entries({ ...process.env,
      AGENT_BRIDGE_ROOT: dataRoot,
      AGENT_BRIDGE_REPO: repoRoot,
      AGENT_BRIDGE_NOTIFY: "0",
      AGENT_BRIDGE_POLL_MS: "250",
      AGENT_BRIDGE_TIMEOUT_MS: "120000",
    }).filter(([, value]) => typeof value === "string"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "dist", "index.js")],
      cwd: path.join(dataRoot, "workdir"),
      env: childEnv,
      stderr: "pipe",
    });
  }

  client = new Client({ name: "agent-bridge-windows-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport, { timeout: 30000 });
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["device_info", "repo_status", "read_file", "get_file_info", "send_task", "read_result", "get_task_status", "worker_alive_summary"]) {
    assert.ok(names.has(name), `Tool discovery is missing ${name}`);
  }
  console.log(`PASS: ${remoteMode ? "cloud" : "stdio"} MCP handshake and ${names.size} tools discovered`);

  const device = parseJson(await call("device_info"));
  assert.equal(device.os.platform, "win32");
  assert.ok(device.disk?.totalBytes > 0, "Windows disk telemetry must be populated");
  assert.ok(device.runningProcessCount > 0, "Windows process count must be populated");
  console.log("PASS: Windows CPU/memory/disk/process telemetry");
  const models = parseJson(await call("list_models", { agent: "codex" }));
  assert.equal(models.codex.catalogSource, "native Codex CLI model/list");
  assert.ok(models.codex.models.some(model => model.id === models.codex.currentDefault.model));
  console.log(`PASS: native CLI model catalog, default ${models.codex.currentDefault.model}`);
  await call("repo_status");
  const rejected = await client.callTool({ name: "read_result", arguments: { task_id: "../../credentials" } });
  assert.ok(rejected.isError, "Unsafe task IDs must be rejected");
  console.log("PASS: repository status and task path validation");

  if (!remoteMode) {
    const fixture = path.join(dataRoot, "fixture.txt");
    fs.writeFileSync(fixture, "WINDOWS_FILESYSTEM_OK\r\n", "utf8");
    await call("get_file_info", { path: fixture });
    const file = parseJson(await call("read_file", { path: fixture }));
    assert.equal(file.content, "WINDOWS_FILESYSTEM_OK\r\n");
    console.log("PASS: Windows fixture metadata and file reading");
  } else {
    const alive = parseJson(await call("worker_alive_summary"));
    assert.equal(alive.running, true, "The cloud-connected embedded worker must be running");
    console.log("PASS: cloud-connected worker is alive");
  }

  if (runAgent) {
    await testTask(remoteMode ? undefined : () => {
      workerFd = fs.openSync(path.join(dataRoot, "smoke-worker.log"), "a");
      worker = spawn(process.execPath, [path.join(repoRoot, "dist", "worker.js")], {
        cwd: path.join(dataRoot, "workdir"),
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", workerFd, workerFd],
      });
      worker.on("error", () => {});
    });
  }
  console.log("Windows deployment validation passed.");
}

try {
  await main();
} catch (error) {
  console.error(`FAIL: ${safeMessage(error)}`);
  process.exitCode = 1;
} finally {
  if (activeTaskId && client) {
    try { await call("cancel_task", { task_id: activeTaskId }); await wait(1500); } catch {}
  }
  if (worker && worker.exitCode === null) {
    worker.kill();
    await Promise.race([new Promise((resolve) => worker.once("exit", resolve)), wait(3000)]);
  }
  if (workerFd !== undefined) fs.closeSync(workerFd);
  if (client) await client.close().catch(() => {});
}
