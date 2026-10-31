import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { reconcileTaskStatus, reconcileAllTasks, readReconciledStatus, isPidAlive, newestMtime, getStallThresholdMs } from "../src/task-reconcile.js";
import { writeStatus, readStatus } from "../src/status.js";

const ROOT = "/tmp/agent-bridge-robustness-test";
fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of ["status", "logs", "control", "results", "tasks"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
const DEAD = 999_999;
const old = new Date(Date.now() - 10 * 60_000).toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 1. worker pid dead -> failed with reason + log tail, lock removed, result written
{
  const id = "task_1_ghostworker";
  writeStatus(ROOT, id, { state: "running", agent: "agy", startedAt: old, workerPid: DEAD, pid: DEAD });
  fs.writeFileSync(path.join(ROOT, "logs", `${id}.out`), "line a\nline b\n");
  fs.writeFileSync(path.join(ROOT, "logs", `${id}.err`), "boom on stderr\n");
  fs.writeFileSync(path.join(ROOT, "control", `${id}.lock`), String(DEAD));
  const st = readReconciledStatus(ROOT, id)!;
  assert.equal(st.state, "failed");
  assert.equal(st.exitCode, null);
  assert.match(st.reason!, /worker process 999999 is gone/);
  assert.match(st.logTail!, /line b[\s\S]*boom on stderr/);
  assert.equal(readStatus(ROOT, id)!.state, "failed", "persisted");
  assert.ok(!fs.existsSync(path.join(ROOT, "control", `${id}.lock`)), "stale lock removed");
  assert.match(fs.readFileSync(path.join(ROOT, "results", `${id}.md`), "utf8"), /failed \(reconciled\)/);
}

// 2. legacy ghost: no workerPid recorded, lock holds dead pid, empty log
{
  const id = "task_2_legacyghost";
  writeStatus(ROOT, id, { state: "running", agent: "agy", startedAt: old });
  fs.writeFileSync(path.join(ROOT, "logs", `${id}.out`), "");
  fs.writeFileSync(path.join(ROOT, "control", `${id}.lock`), String(DEAD));
  assert.deepEqual(reconcileAllTasks(ROOT), [id]);
  const st = readStatus(ROOT, id)!;
  assert.equal(st.state, "failed");
  assert.match(st.reason!, /log is empty/);
}

// 3. live worker + live child -> untouched; young task -> untouched
{
  const id = "task_3_alive";
  writeStatus(ROOT, id, { state: "running", agent: "agy", startedAt: old, workerPid: process.pid, pid: process.pid });
  assert.equal(readReconciledStatus(ROOT, id)!.state, "running");
  const young = "task_3b_young";
  writeStatus(ROOT, young, { state: "running", agent: "agy", startedAt: new Date().toISOString(), workerPid: DEAD });
  assert.equal(readReconciledStatus(ROOT, young)!.state, "running");
}

// 4. live worker, dead child: wait for grace, then failed
{
  const id = "task_4_deadchild";
  writeStatus(ROOT, id, { state: "running", agent: "codex", startedAt: old, workerPid: process.pid, pid: DEAD });
  assert.equal(readReconciledStatus(ROOT, id)!.state, "running", "within child-exit grace");
  const st = reconcileTaskStatus(ROOT, { taskId: id, ...readStatus(ROOT, id)! }, { childExitGraceMs: 0 });
  assert.equal(st.state, "failed");
  assert.match(st.reason!, /agent pid 999999 exited/);
}

// 5. cancel path: ghost becomes cancelled
{
  const id = "task_5_cancelghost";
  writeStatus(ROOT, id, { state: "suspected_stalled", agent: "agy", startedAt: old, workerPid: DEAD });
  const st = reconcileTaskStatus(ROOT, { taskId: id, ...readStatus(ROOT, id)! }, { graceMs: 0, finalState: "cancelled" });
  assert.equal(st.state, "cancelled");
}

// 6. helpers
{
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(DEAD), false);
  const d = fs.mkdtempSync("/tmp/ab-mtime-");
  fs.mkdirSync(path.join(d, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(d, "a", "b", "f.txt"), "x");
  assert.ok(Date.now() - newestMtime(d) < 5000);
  process.env.AGENT_BRIDGE_STALL_MINUTES = "0";
  assert.equal(getStallThresholdMs(), 0);
  process.env.AGENT_BRIDGE_STALL_MINUTES = "2";
  assert.equal(getStallThresholdMs(), 120_000);
  delete process.env.AGENT_BRIDGE_STALL_MINUTES;
  assert.equal(getStallThresholdMs(), 20 * 60_000);
}

// 7. worker integration: stall detection + fast failure reason + pid recorded
async function workerIntegration() {
  const W = "/tmp/agent-bridge-robustness-worker";
  fs.rmSync(W, { recursive: true, force: true });
  for (const d of ["tasks", "results", "logs", "wd"]) fs.mkdirSync(path.join(W, d), { recursive: true });
  fs.writeFileSync(path.join(W, "silent.cjs"), "setTimeout(() => { process.stdout.write('done'); }, 6000);\n");
  fs.writeFileSync(path.join(W, "fastfail.cjs"), "process.stderr.write('fatal: bad flag --nope'); process.exit(3);\n");
  fs.writeFileSync(path.join(W, "agents.json"), JSON.stringify({
    silent: { command: process.execPath, args: [path.join(W, "silent.cjs")], input: "stdin" },
    fastfail: { command: process.execPath, args: [path.join(W, "fastfail.cjs")], input: "stdin" },
  }));
  // old work dir so it does not count as activity
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(W, "wd"), past, past);
  const task = (id: string, agent: string) => fs.writeFileSync(path.join(W, "tasks", `${id}.md`),
    `# t\n\n- **Task ID**: ${id}\n- **Agent**: ${agent}\n- **Project Dir**: ${path.join(W, "wd")}\n- **Created At**: ${new Date().toISOString()}\n\n---\n\n## Prompt\n\nhello\n`);
  const worker = spawn(process.execPath, ["dist/worker.js"], {
    env: { ...process.env, AGENT_BRIDGE_ROOT: W, AGENT_BRIDGE_POLL_MS: "200", AGENT_BRIDGE_NOTIFY: "0", AGENT_BRIDGE_STALL_MINUTES: "0.03" },
    stdio: "ignore",
  });
  try {
    task("task_7_fastfail", "fastfail");
    let st: any = null;
    for (let i = 0; i < 50 && st?.state !== "failed"; i++) { await sleep(200); st = readStatus(W, "task_7_fastfail"); }
    assert.equal(st?.state, "failed");
    assert.match(st.reason, /exited with code 3 .*fatal: bad flag --nope/s);
    assert.ok(fs.readFileSync(path.join(W, "logs", "task_7_fastfail.err"), "utf8").includes("bad flag"));

    task("task_7_silent", "silent");
    let sawPid = false, sawStall = false;
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      const s = readStatus(W, "task_7_silent");
      if (s?.pid && s.workerPid) sawPid = true;
      if (s?.state === "suspected_stalled") { sawStall = true; assert.match(s.reason!, /suspected stall/); break; }
    }
    assert.ok(sawPid, "running status records pid + workerPid");
    assert.ok(sawStall, "silent task flagged suspected_stalled");
    for (let i = 0; i < 60; i++) { await sleep(200); if (readStatus(W, "task_7_silent")?.state === "completed") break; }
    assert.equal(readStatus(W, "task_7_silent")?.state, "completed", "stall flag is cleared on completion");
  } finally {
    worker.kill();
  }
}

workerIntegration().then(() => console.log("task-robustness-test: all passed"), err => { console.error(err); process.exit(1); });
