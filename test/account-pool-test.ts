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
} from "../src/account-pool.js";
import { getSessionAccount, recordSessionAccount } from "../src/sessions.js";
import { writeStatus } from "../src/status.js";

const TEST_ROOT = "/tmp/agent-bridge-account-pool-test";

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
  console.log("✓ Assertion passed: conflicts rejected; colliding local-part got suffix alias.");

  console.log("=================================================");
  console.log("  All Account Pool Tests Passed! 🎉              ");
  console.log("=================================================");
}

runAccountPoolTests().catch((err) => {
  console.error("Account pool test failed:", err);
  process.exit(1);
});
