import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  acquireDualPoolAccount,
  releaseSelection,
  getDefaultPoolMaxConcurrent,
  countDefaultPoolRunning,
  queryAccountOverview,
} from "../src/dual-pool.js";
import { loadPoolConfig, savePoolConfig, initPoolProfile } from "../src/account-pool.js";
import { writeStatus } from "../src/status.js";
import {
  conversationLaneKey,
  isConversationLaneBusy,
} from "../src/queue-dispatcher.js";

const ROOT = "/tmp/agent-bridge-pool-concurrency-test";

function plantLoggedInAuth(profileHome: string) {
  const gemini = path.join(profileHome, ".gemini");
  fs.mkdirSync(path.join(gemini, "antigravity-cli"), { recursive: true });
  fs.writeFileSync(
    path.join(gemini, "oauth_creds.json"),
    JSON.stringify({ access_token: "t", refresh_token: "r", expiry_date: Date.now() + 3600_000 }),
    "utf8"
  );
}

function writeTask(rootDir: string, taskId: string, meta: { session_id?: string; project_dir?: string; continue_session?: boolean }) {
  const tasksDir = path.join(rootDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  let header = `- **Task ID**: ${taskId}\n- **Agent**: agy\n`;
  if (meta.session_id) header += `- **Session ID**: ${meta.session_id}\n`;
  if (meta.continue_session) header += `- **Continue Session**: true\n`;
  if (meta.project_dir) header += `- **Project Dir**: ${meta.project_dir}\n`;
  fs.writeFileSync(path.join(tasksDir, `${taskId}.md`), `# T\n\n${header}---\n\n## Prompt\n\nhi\n`, "utf8");
}

async function run() {
  console.log("=================================================");
  console.log("  Pool Concurrency & Conversation Lane Tests");
  console.log("=================================================");

  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  delete process.env.AGENT_BRIDGE_DEFAULT_POOL_MAX_CONCURRENT;
  assert.equal(getDefaultPoolMaxConcurrent(), 0);

  const ck = (email: string, frac: number, current = false) => ({
    accountId: "antigravity_" + email.split("@")[0],
    email,
    current,
    disabled: false,
    provider: "antigravity",
    quotas: {},
    remainingFractionSummary: frac,
  });
  const cockpit = [ck("a@x.com", 0.5, true), ck("b@x.com", 0.5)];

  console.log("[Test 1] uncapped default pool: two concurrent acquires...");
  const d1 = await acquireDualPoolAccount(ROOT, "def_1", { cockpitAccounts: cockpit, defaultHome: "/home/def" });
  const d2 = await acquireDualPoolAccount(ROOT, "def_2", { cockpitAccounts: cockpit, defaultHome: "/home/def" });
  assert.equal(d1.pool, "default");
  assert.equal(d2.pool, "default");
  assert.equal(countDefaultPoolRunning(ROOT), 2);
  releaseSelection(ROOT, d1, "def_1");
  releaseSelection(ROOT, d2, "def_2");

  console.log("[Test 2] default pool cap via AGENT_BRIDGE_DEFAULT_POOL_MAX_CONCURRENT=1...");
  process.env.AGENT_BRIDGE_DEFAULT_POOL_MAX_CONCURRENT = "1";
  const c1 = await acquireDualPoolAccount(ROOT, "cap_1", { cockpitAccounts: cockpit, defaultHome: "/home/def" });
  assert.equal(c1.pool, "default");
  const c2 = await acquireDualPoolAccount(ROOT, "cap_2", { cockpitAccounts: cockpit, defaultHome: "/home/def" });
  assert.equal(c2.pool, "none");
  assert.equal((c2 as any).kind, "busy");
  releaseSelection(ROOT, c1, "cap_1");
  delete process.env.AGENT_BRIDGE_DEFAULT_POOL_MAX_CONCURRENT;

  console.log("[Test 3] custom profile max_concurrent=2 allows two running...");
  const prof = initPoolProfile(ROOT, { alias: "worker-parallel", email: "parallel@x.com" });
  assert.equal(prof.success, true);
  plantLoggedInAuth(prof.profile!.home);
  const profiles = loadPoolConfig(ROOT);
  profiles[0].max_concurrent = 2;
  savePoolConfig(ROOT, profiles);
  writeStatus(ROOT, "run_a", { state: "running", agent: "agy", account: "worker-parallel", startedAt: new Date().toISOString() });
  const p1 = await acquireDualPoolAccount(ROOT, "run_b", { cockpitAccounts: cockpit });
  assert.equal(p1.pool, "custom");
  releaseSelection(ROOT, p1, "run_b");
  writeStatus(ROOT, "run_a", { state: "completed", agent: "agy", account: "worker-parallel", finishedAt: new Date().toISOString() });
  writeStatus(ROOT, "run_a", { state: "running", agent: "agy", account: "worker-parallel", startedAt: new Date().toISOString() });
  writeStatus(ROOT, "run_c", { state: "running", agent: "agy", account: "worker-parallel", startedAt: new Date().toISOString() });
  const pBlock = await acquireDualPoolAccount(ROOT, "run_d", { cockpitAccounts: cockpit });
  assert.equal(pBlock.pool, "none");
  assert.match((pBlock as any).reason, /max concurrent/i);

  console.log("[Test 4] conversation lane: same session+project_dir serializes...");
  const proj = path.join(ROOT, "proj-a");
  fs.mkdirSync(proj, { recursive: true });
  writeTask(ROOT, "lane_1", { session_id: "sess_lane", project_dir: proj });
  writeStatus(ROOT, "lane_1", { state: "running", agent: "agy", startedAt: new Date().toISOString() });
  assert.ok(isConversationLaneBusy(ROOT, "sess_lane", proj, false, "lane_2"));
  assert.ok(!isConversationLaneBusy(ROOT, "sess_lane", path.join(ROOT, "other-proj"), false, "lane_2"));
  assert.ok(!isConversationLaneBusy(ROOT, "other_session", proj, false, "lane_2"));
  assert.equal(conversationLaneKey("sess_lane", proj, false)?.includes("sess_lane"), true);

  console.log("[Test 5] queryAccountOverview exposes running_task_count...");
  const ov = queryAccountOverview(ROOT, cockpit as any);
  const par = ov.find((r) => r.email === "parallel@x.com");
  assert.ok(par);
  assert.ok(typeof par!.running_task_count === "number");

  console.log("=================================================");
  console.log("  Pool Concurrency Tests Passed!");
  console.log("=================================================");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
