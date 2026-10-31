import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadPoolConfig,
  savePoolConfig,
  initPoolProfile,
  pausePoolProfile,
  resumePoolProfile,
  bindProfileEmail,
  selectPoolAccount,
  recordTaskStartUnderProfile,
  handlePoolQuotaPaused,
  queryPoolStatus,
  sanitizeEmailLocalPart,
  deriveUniqueAlias,
  detectProfileLoginStatus,
  isProfileLoggedIn,
  recordProfileLoginResult,
} from "../src/account-pool.js";
import { getSessionAccount, recordSessionAccount } from "../src/sessions.js";
import { writeStatus } from "../src/status.js";
import { removePoolProfile, markProfileNeedsRelogin } from "../src/account-pool.js";
import {
  selectDualPoolAccount, acquireDualPoolAccount, releaseSelection, pauseEmail, isEmailPaused,
  queryAccountOverview, setCustomPoolEnabled, isCustomPoolEnabled, getEmailBusyTask,
} from "../src/dual-pool.js";
import { isQuotaExhaustedError, classifyAgentFailure, parseQuotaResetTime } from "../src/session-quota.js";

const TEST_ROOT = "/tmp/agent-bridge-account-pool-test";

function plantLoggedInAuth(profileHome: string) {
  const gemini = path.join(profileHome, ".gemini");
  fs.mkdirSync(path.join(gemini, "antigravity-cli"), { recursive: true });
  const token = {
    access_token: "ya29.test-access",
    token_type: "Bearer",
    refresh_token: "1//test-refresh",
    expiry: new Date(Date.now() + 3600_000).toISOString(),
  };
  const jetski = { token, auth_method: "consumer", id_token: "header.payload.sig" };
  fs.writeFileSync(path.join(gemini, "jetski-standalone-oauth-token"), JSON.stringify(jetski), "utf8");
  fs.writeFileSync(
    path.join(gemini, "oauth_creds.json"),
    JSON.stringify({
      access_token: token.access_token,
      token_type: "Bearer",
      refresh_token: token.refresh_token,
      expiry_date: Date.now() + 3600_000,
    }),
    "utf8"
  );
}

async function runAccountPoolTests() {
  console.log("=================================================");
  console.log("  agy Multi-Account Pool & Selection Tests");
  console.log("=================================================");

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // Test 1: Empty pool => exact legacy behavior (undefined returned)
  console.log("[Test 1] Testing empty pool legacy behavior...");
  const emptySel = selectPoolAccount(TEST_ROOT);
  assert.equal(emptySel, undefined, "Empty pool must return undefined (legacy default process HOME)");
  console.log("✓ Assertion passed: Empty pool returns undefined.");

  // Test 2: initPoolProfile creates dir, symlinks, copies settings, outputs login command
  console.log("[Test 2] Testing initPoolProfile...");
  const initRes = initPoolProfile(TEST_ROOT, { alias: "worker-alpha", email: "user1@example.com" });
  assert.equal(initRes.success, true, "initPoolProfile must succeed");
  assert.ok(initRes.profile, "profile object must be returned");
  assert.equal(initRes.profile.alias, "worker-alpha");
  assert.equal(initRes.profile.email, "user1@example.com");
  assert.ok(fs.existsSync(initRes.profile.home), "Profile home directory must exist on disk");
  assert.ok(
    initRes.loginCommand.includes(`HOME=${initRes.profile.home} agy`),
    "Login command must contain HOME=<dir> agy"
  );
  assert.equal(detectProfileLoginStatus(initRes.profile!).status, "logged_out", "fresh profile is 未登录");
  plantLoggedInAuth(initRes.profile!.home);
  assert.equal(detectProfileLoginStatus(initRes.profile!).status, "logged_in", "planted auth => 已登录");
  console.log("✓ Assertion passed: initPoolProfile initialized dir and login command:", initRes.loginCommand);

  // Test 3: One-account-one-dir invariant: cannot bind same email to another profile dir
  console.log("[Test 3] Testing one-account-one-dir invariant...");
  const dupRes = initPoolProfile(TEST_ROOT, { alias: "worker-beta", email: "user1@example.com" });
  assert.equal(dupRes.success, false, "Must reject binding the same email to a second profile");
  assert.ok(dupRes.error?.includes("already bound to profile"), "Error message must state duplicate binding");
  console.log("✓ Assertion passed: Duplicate email across profiles strictly prevented.");

  // Test 4: Initialize a second independent profile
  console.log("[Test 4] Initializing second profile worker-beta with user2@example.com...");
  const initRes2 = initPoolProfile(TEST_ROOT, { alias: "worker-beta", email: "user2@example.com" });
  assert.equal(initRes2.success, true);
  plantLoggedInAuth(initRes2.profile!.home);
  const profiles = loadPoolConfig(TEST_ROOT);
  assert.equal(profiles.length, 2, "Pool must now contain 2 profiles");
  console.log("✓ Assertion passed: 2 profiles loaded.");

  // Test 5: Auto selection picks idle profile
  console.log("[Test 5] Testing auto selection among idle profiles...");
  const sel1 = selectPoolAccount(TEST_ROOT);
  assert.ok(sel1, "Must select an available profile");
  assert.ok(sel1.alias === "worker-alpha" || sel1.alias === "worker-beta");
  console.log("✓ Assertion passed: Auto selection returned profile:", sel1.alias);

  // Test 6: In-flight task makes profile busy; auto routes to the other idle profile
  console.log("[Test 6] Testing busy routing to idle account...");
  // Simulate task running under worker-alpha
  writeStatus(TEST_ROOT, "task-101", {
    state: "running",
    agent: "agy",
    account: "worker-alpha",
    startedAt: new Date().toISOString(),
  });

  const sel2 = selectPoolAccount(TEST_ROOT);
  assert.ok(sel2);
  assert.equal(sel2.alias, "worker-beta", "Auto selection must pick idle worker-beta since worker-alpha is busy");
  console.log("✓ Assertion passed: Busy profile skipped, routed to idle profile worker-beta.");

  // Test 7: Session stickiness (same session_id always routes to same profile)
  console.log("[Test 7] Testing session sticky account routing...");
  const sessionId = "sess_checkout_flow_001";
  recordTaskStartUnderProfile(TEST_ROOT, "worker-alpha", "task-101", sessionId);

  // Even if worker-beta is idle, a task with session_id bound to worker-alpha must route to worker-alpha
  const stickySel = selectPoolAccount(TEST_ROOT, { session_id: sessionId });
  assert.ok(stickySel);
  assert.equal(stickySel.alias, "worker-alpha", "Follow-up tasks on same session_id must reuse worker-alpha");
  console.log("✓ Assertion passed: Session stickiness preserved across tasks.");

  // Test 8: Pause and resume profile
  console.log("[Test 8] Testing pool_pause and pool_resume...");
  // Mark task-101 completed
  writeStatus(TEST_ROOT, "task-101", {
    state: "completed",
    agent: "agy",
    account: "worker-alpha",
    finishedAt: new Date().toISOString(),
  });

  pausePoolProfile(TEST_ROOT, "worker-alpha");
  const pausedSel = selectPoolAccount(TEST_ROOT);
  assert.equal(pausedSel?.alias, "worker-beta", "Paused profile must be excluded from auto selection");

  resumePoolProfile(TEST_ROOT, "worker-alpha");
  const resumedConfig = loadPoolConfig(TEST_ROOT);
  const alphaP = resumedConfig.find((p) => p.alias === "worker-alpha");
  assert.equal(alphaP?.enabled, true);
  assert.equal(alphaP?.paused_until, undefined);
  console.log("✓ Assertion passed: pool_pause and pool_resume function properly.");

  // Test 9: Quota exhaustion handler sets paused_until
  console.log("[Test 9] Testing handlePoolQuotaPaused...");
  handlePoolQuotaPaused(TEST_ROOT, "worker-alpha");
  const quotaConfig = loadPoolConfig(TEST_ROOT);
  const quotaAlpha = quotaConfig.find((p) => p.alias === "worker-alpha");
  assert.ok(quotaAlpha?.paused_until, "Must have paused_until set on quota exhaustion");
  console.log("✓ Assertion passed: Quota exhaustion set paused_until:", quotaAlpha.paused_until);

  // Test 10: Compact pool status report
  console.log("[Test 10] Testing queryPoolStatus...");
  const poolStatuses = queryPoolStatus(TEST_ROOT);
  assert.equal(poolStatuses.length, 2);
  const alphaStat = poolStatuses.find((s) => s.alias === "worker-alpha");
  assert.equal(alphaStat?.enabled, false, "Paused profile must report enabled=false");
  assert.ok(alphaStat?.login_status, "login_status must be present");
  assert.ok(alphaStat?.login_label, "login_label must be present");
  console.log("✓ Assertion passed: queryPoolStatus returned valid status lines:", poolStatuses);

  // Test 11: sanitize + derive alias from email local-part
  console.log("[Test 11] Testing alias derivation from email...");
  assert.equal(sanitizeEmailLocalPart("jianjianlin380@gmail.com"), "jianjianlin380");
  assert.equal(sanitizeEmailLocalPart("Jia.Un-Lind+tag@gmail.com"), "jia_un-lind_tag");
  assert.equal(
    deriveUniqueAlias("user1@example.com", ["worker-alpha", "worker-beta"]),
    "user1"
  );
  assert.equal(
    deriveUniqueAlias("user1@example.com", ["user1", "worker-beta"]),
    "user1-2"
  );
  console.log("✓ Assertion passed: email local-part sanitized and collision suffix applied.");

  // Test 12: email-only init auto-generates alias/HOME
  console.log("[Test 12] Testing email-only initPoolProfile...");
  const emailOnly = initPoolProfile(TEST_ROOT, { email: "mmei49293@gmail.com" });
  assert.equal(emailOnly.success, true, "email-only init must succeed");
  assert.equal(emailOnly.profile?.alias, "mmei49293");
  assert.equal(emailOnly.profile?.email, "mmei49293@gmail.com");
  assert.ok(emailOnly.profile?.home.includes("mmei49293"), "HOME must include derived alias");
  assert.ok(emailOnly.loginCommand?.includes(`HOME=${emailOnly.profile?.home} agy`));
  plantLoggedInAuth(emailOnly.profile!.home);
  console.log("✓ Assertion passed: email-only init created alias mmei49293:", emailOnly.loginCommand);

  // Test 13: duplicate email rejected; alias collision rejected
  console.log("[Test 13] Testing email and alias collision rejection...");
  const dupEmail = initPoolProfile(TEST_ROOT, { email: "mmei49293@gmail.com" });
  assert.equal(dupEmail.success, false);
  assert.ok(dupEmail.error?.includes("already bound"), "duplicate email must be rejected");

  const aliasClash = initPoolProfile(TEST_ROOT, { alias: "mmei49293", email: "other@example.com" });
  assert.equal(aliasClash.success, false);
  assert.ok(aliasClash.error?.includes("already exists"), "alias collision must be rejected");

  // Same local-part email but different domain still needs unique alias suffix when local alias taken
  const sameLocal = initPoolProfile(TEST_ROOT, { email: "mmei49293@example.com" });
  assert.equal(sameLocal.success, true);
  assert.equal(sameLocal.profile?.alias, "mmei49293-2", "colliding local-part must get -2 suffix");
  plantLoggedInAuth(sameLocal.profile!.home);
  console.log("✓ Assertion passed: conflicts rejected; colliding local-part got suffix alias.");

  // Test 14: dispatcher skips profiles that are not logged in
  console.log("[Test 14] Testing selectPoolAccount skips 未登录 profiles...");
  const loggedOutOnlyRoot = path.join(TEST_ROOT, "logged-out-only");
  fs.rmSync(loggedOutOnlyRoot, { recursive: true, force: true });
  fs.mkdirSync(loggedOutOnlyRoot, { recursive: true });
  const bare = initPoolProfile(loggedOutOnlyRoot, { alias: "bare", email: "bare@example.com" });
  assert.equal(bare.success, true);
  assert.equal(isProfileLoggedIn(bare.profile!), false);
  const noPick = selectPoolAccount(loggedOutOnlyRoot);
  assert.equal(noPick, undefined, "未登录 profile must not be selected");
  plantLoggedInAuth(bare.profile!.home);
  const yesPick = selectPoolAccount(loggedOutOnlyRoot);
  assert.equal(yesPick?.alias, "bare");
  console.log("✓ Assertion passed: unlogged profiles are skipped by dispatcher.");

  // Test 15: login_failed reason surfaces in queryPoolStatus
  console.log("[Test 15] Testing login_failed status reason...");
  recordProfileLoginResult(loggedOutOnlyRoot, "bare", { success: false, error: "cockpit switch failed" });
  // still logged in because auth files remain; wipe auth to expose login_failed
  fs.rmSync(path.join(bare.profile!.home, ".gemini", "jetski-standalone-oauth-token"), { force: true });
  fs.rmSync(path.join(bare.profile!.home, ".gemini", "oauth_creds.json"), { force: true });
  const failed = detectProfileLoginStatus(loadPoolConfig(loggedOutOnlyRoot)[0]);
  assert.equal(failed.status, "login_failed");
  assert.equal(failed.label, "登录失败");
  assert.ok(failed.reason?.includes("cockpit switch failed"));
  const statusLines = queryPoolStatus(loggedOutOnlyRoot);
  assert.equal(statusLines[0].login_status, "login_failed");
  assert.equal(statusLines[0].login_label, "登录失败");
  console.log("✓ Assertion passed: login_failed reason reported.");

  // ===== Dual pool / quota-detection tests =====
  console.log("[Test 16] exit 3 with empty log is NOT quota...");
  assert.equal(isQuotaExhaustedError(3, "", ""), false);
  assert.equal(isQuotaExhaustedError(129, "", ""), false);
  assert.equal(classifyAgentFailure(3, "", ""), "other");
  assert.equal(classifyAgentFailure(3, "", 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}'), "quota");
  assert.equal(classifyAgentFailure(1, "", "Error: UNAUTHENTICATED: invalid_grant"), "login");
  const reset = parseQuotaResetTime("Resets in 68h38m30s.", 0);
  assert.equal(reset, new Date((68 * 3600 + 38 * 60 + 30) * 1000).toISOString());
  assert.equal(parseQuotaResetTime("no hint"), undefined);
  console.log("✓ quota/login classification");

  const D = path.join(TEST_ROOT, "dual");
  fs.rmSync(D, { recursive: true, force: true });
  fs.mkdirSync(D, { recursive: true });
  const ck = (email: string, frac: number, current = false) => ({
    accountId: "antigravity_" + email.split("@")[0], email, current, disabled: false, provider: "antigravity",
    quotas: {}, remainingFractionSummary: frac,
  });

  console.log("[Test 17] no profiles => default pool (current Cockpit account, no switch)...");
  const cockpit = [ck("a@x.com", 0, true), ck("b@x.com", 0), ck("c380@x.com", 1)];
  let sel = selectDualPoolAccount(D, { cockpitAccounts: [ck("a@x.com", 0.5, true)], defaultHome: "/home/def" });
  assert.equal(sel.pool, "default");
  assert.equal((sel as any).needsSwitch, false);
  console.log("[Test 18] default pool switches to idle 380 even though 380 is configured as a custom profile...");
  const p380 = initPoolProfile(D, { alias: "c380", email: "c380@x.com" });
  assert.equal(p380.success, true);
  // profile not logged in => custom unusable, default should still pick 380 (idle, full quota)
  sel = selectDualPoolAccount(D, { cockpitAccounts: cockpit, defaultHome: "/home/def" });
  assert.equal(sel.pool, "default");
  assert.equal((sel as any).email, "c380@x.com");
  assert.equal((sel as any).needsSwitch, true);
  console.log("[Test 19] custom profile preferred when available...");
  plantLoggedInAuth(p380.profile!.home);
  sel = selectDualPoolAccount(D, { cockpitAccounts: cockpit });
  assert.equal(sel.pool, "custom");
  console.log("[Test 20] busy email across pools: 380 running in custom => default skips it => queue...");
  let switched = "";
  const a1 = await acquireDualPoolAccount(D, "task_dual_1", { cockpitAccounts: cockpit, switchFn: async (o: any) => { switched = o.targetEmailOrAccount; return { success: true }; } });
  assert.equal(a1.pool, "custom");
  assert.ok(getEmailBusyTask(D, "c380@x.com"));
  const a2 = await acquireDualPoolAccount(D, "task_dual_2", { cockpitAccounts: cockpit, switchFn: async () => ({ success: true }) });
  assert.equal(a2.pool, "none", "a,b out of quota; 380 busy => queue");
  assert.equal((a2 as any).kind, "busy");
  releaseSelection(D, a1, "task_dual_1");
  const a3 = await acquireDualPoolAccount(D, "task_dual_3", { cockpitAccounts: cockpit, switchFn: async () => ({ success: true }) });
  assert.equal(a3.pool, "custom");
  releaseSelection(D, a3, "task_dual_3");
  console.log("[Test 21] custom pool toggle off => default pool used...");
  setCustomPoolEnabled(D, false);
  assert.equal(isCustomPoolEnabled(D), false);
  const a4 = await acquireDualPoolAccount(D, "task_dual_4", { cockpitAccounts: cockpit, switchFn: async (o: any) => { switched = o.targetEmailOrAccount; return { success: true }; } });
  assert.equal(a4.pool, "default");
  assert.equal(switched, "antigravity_c380");
  const a5 = await acquireDualPoolAccount(D, "task_dual_5", { cockpitAccounts: cockpit });
  assert.equal(a5.pool, "none", "default HOME single-account: second default task waits");
  releaseSelection(D, a4, "task_dual_4");
  setCustomPoolEnabled(D, true);
  console.log("[Test 22] paused custom profile => fallback to default (not queue)...");
  pausePoolProfile(D, "c380", 3600);
  sel = selectDualPoolAccount(D, { cockpitAccounts: cockpit });
  assert.equal(sel.pool, "default");
  resumePoolProfile(D, "c380");
  console.log("[Test 23] shared email pause blocks both pools...");
  pauseEmail(D, "c380@x.com", new Date(Date.now() + 3600_000).toISOString(), "quota");
  assert.ok(isEmailPaused(D, "c380@x.com"));
  sel = selectDualPoolAccount(D, { cockpitAccounts: cockpit });
  assert.equal(sel.pool, "none");
  assert.equal((sel as any).kind, "no_quota", "all exhausted => structured no_quota");
  assert.ok((sel as any).earliest_reset);
  const ov = queryAccountOverview(D, cockpit as any);
  const r380 = ov.find((r) => r.email === "c380@x.com")!;
  assert.deepEqual(r380.pools.sort(), ["custom", "default"]);
  assert.notEqual(r380.paused_until, "none");
  assert.equal(ov.length, 3, "one row per email");
  console.log("[Test 24] needs_relogin is not quota and excludes profile...");
  markProfileNeedsRelogin(D, "c380", "invalid_grant");
  assert.equal(detectProfileLoginStatus(loadPoolConfig(D)[0]).status, "needs_relogin");
  console.log("[Test 25] remove profile...");
  const rm = removePoolProfile(D, "c380", { deleteHome: true });
  assert.equal(rm.success, true);
  assert.equal(rm.homeDeleted, true);
  assert.equal(loadPoolConfig(D).length, 0);
  assert.equal(removePoolProfile(D, "c380").success, false);
  console.log("✓ dual pool tests passed");

  console.log("=================================================");
  console.log("  All Account Pool Tests Passed! 🎉              ");
  console.log("=================================================");
}

runAccountPoolTests().catch((err) => {
  console.error("Account pool test failed:", err);
  process.exit(1);
});
