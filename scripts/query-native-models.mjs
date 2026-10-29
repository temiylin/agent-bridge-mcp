#!/usr/bin/env node
// Read-only model discovery through the installed native Codex app-server.
// Never creates a thread, runs inference, or writes configuration.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolveCodexExecutable } from "./resolve-codex.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.argv[2] || resolveCodexExecutable();
if (!fs.existsSync(executable)) throw new Error("The native Codex executable does not exist");

const proc = spawn(executable, ["app-server", "--stdio"], {
  cwd: repoRoot,
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = readline.createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;
let stderrBytes = 0;
proc.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
proc.stdin.on("error", () => {});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after 45000ms (stderr bytes: ${stderrBytes})`));
    }, 45000);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  clearTimeout(item.timer);
  if (message.error) item.reject(new Error(`Codex RPC error ${message.error.code}: ${message.error.message}`));
  else item.resolve(message.result);
});
proc.on("error", (error) => {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
});
proc.on("exit", (code) => {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error(`Codex app-server exited with code ${code} (stderr bytes: ${stderrBytes})`));
  }
  pending.clear();
});

try {
  await request("initialize", {
    clientInfo: { name: "agent_bridge_windows_verifier", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  let cursor;
  const models = [];
  const seenCursors = new Set();
  do {
    const page = await request("model/list", { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error("Codex model/list returned an invalid catalog");
    models.push(...page.data.map((model) => ({
      id: model.id,
      model: model.model,
      isDefault: model.isDefault,
      hidden: model.hidden,
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportedReasoningEfforts: (model.supportedReasoningEfforts || []).map((effort) => effort.reasoningEffort),
    })));
    cursor = page.nextCursor;
    if (cursor && (seenCursors.has(cursor) || seenCursors.size >= 20)) throw new Error("Codex model/list pagination did not terminate");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  console.log(JSON.stringify({ source: "native app-server model/list", models }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  lines.close();
  proc.stdin.end();
  if (proc.exitCode === null) proc.kill();
}
