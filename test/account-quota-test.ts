import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarizeAgyQuotas, summarizeCodexRateLimits, getAgyAccountQuota, formatQuotaLine } from "../src/account-quota.js";
import { getConfiguredDefaultModel, compactReport } from "../src/models.js";

const now = Date.parse("2026-10-31T10:00:00Z");

// agy: classify 5h vs weekly by time-to-reset
{
  const q = {
    "gemini-3.8-flash-low": { remainingFraction: 0.8, resetTime: "2026-10-31T13:00:00Z" },
    "gemini-4-argon": { remainingFraction: 0.25, resetTime: "2026-11-06T00:00:00Z" },
    "chat_1": { remainingFraction: 0 },
  };
  const all = summarizeAgyQuotas(q, undefined, now);
  assert.equal(all.five_hour?.remaining_pct, 80);
  assert.equal(all.weekly?.remaining_pct, 25);
  assert.equal(all.limited, false);
  const one = summarizeAgyQuotas(q, "gemini-3.8-flash-low", now);
  assert.equal(one.five_hour?.model, "gemini-3.8-flash-low");
  assert.equal(one.weekly, undefined, "model-specific view omits windows the model does not have");
  const stale = summarizeAgyQuotas({ m: { remainingFraction: 0, resetTime: "2026-10-30T00:00:00Z" } }, undefined, now);
  assert.equal(stale.five_hour, undefined);
}

// codex: primary weekly only (no 5h) and both windows
{
  const weeklyOnly = summarizeCodexRateLimits({
    ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793774239 }, secondary: null, planType: "plus", rateLimitReachedType: "rate_limit_reached" },
  });
  assert.equal(weeklyOnly.five_hour, undefined);
  assert.equal(weeklyOnly.weekly?.remaining_pct, 0);
  assert.equal(weeklyOnly.limited, true);
  assert.equal(weeklyOnly.plan, "plus");
  const both = summarizeCodexRateLimits({
    rateLimits: { primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1793774239 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1793800000 } },
  });
  assert.equal(both.five_hour?.remaining_pct, 59);
  assert.equal(both.weekly?.remaining_pct, 90);
  assert.equal(both.limited, false);
  assert.match(formatQuotaLine({ agent: "codex", account: "a@b", source: "x", ...both }), /5h 59% left.*weekly 90% left/);
}

// agy from a fake cockpit dir: current account + quota cache, never tokens
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-"));
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify({ current_account_id: "a1", accounts: [{ id: "a1", email: "me@x.com", token: "SECRET" }, { id: "a2", email: "other@x.com" }] }));
  const qdir = path.join(dir, "cache", "quota_api_v1_desktop", "authorized");
  fs.mkdirSync(qdir, { recursive: true });
  const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
  fs.writeFileSync(path.join(qdir, "x.json"), JSON.stringify({ email: "me@x.com", updatedAt: 1, payload: { models: { "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.5, resetTime: soon } } } } }));
  const q = getAgyAccountQuota("gemini-3.8-flash-low", dir);
  assert.equal(q.account, "me@x.com");
  assert.equal(q.five_hour?.remaining_pct, 50);
  assert.ok(!JSON.stringify(q).includes("SECRET"));
}

// default model: builtin agy default, agents.json override
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-root-"));
  assert.equal(getConfiguredDefaultModel(root, "agy"), "gemini-3.8-flash-low");
  assert.equal(getConfiguredDefaultModel(root, "codex"), undefined);
  fs.writeFileSync(path.join(root, "agents.json"), JSON.stringify({ agy: { command: "agy", args: [], input: "stdin", default_model: "claude-sonnet-4-6" } }));
  assert.equal(getConfiguredDefaultModel(root, "agy"), "claude-sonnet-4-6");
  const c = compactReport({ agent: "agy", command: "agy", installed: true, supportedReasoningEfforts: ["low"], defaultModel: "m1", models: [{ id: "m1", name: "M1", isDefault: true }, { id: "m2", name: "M2" }] });
  assert.deepEqual(c.models, ["m1", "m2"]);
  assert.equal(c.default_model, "m1");
}

console.log("account-quota-test: all passed");
