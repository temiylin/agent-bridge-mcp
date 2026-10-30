#!/usr/bin/env node
import { runSelfCheck } from "../dist/self-check.js";
import { resolveBridgeRoot } from "../dist/config.js";

const rootDir = process.env.AGENT_BRIDGE_ROOT || resolveBridgeRoot();
const report = runSelfCheck(rootDir);

console.log("=================================================");
console.log("          Agent Bridge Self-Check");
console.log("=================================================");
console.log(`Bridge Root: ${rootDir}`);
console.log(`Worker Status: ${report.worker.alive ? "✅ RUNNING" : "❌ INACTIVE"}`);
if (report.worker.pid) {
  console.log(`Worker PID:    ${report.worker.pid}`);
}
if (report.worker.lastHeartbeat) {
  console.log(`Heartbeat:     ${report.worker.lastHeartbeat}`);
}

console.log("\nRegistered Agents:");
if (report.agents.length === 0) {
  console.log("  (no agents registered or agents.json not found)");
} else {
  for (const agent of report.agents) {
    if (agent.runs) {
      console.log(`  ✅ [${agent.name}] ${agent.command} -> ${agent.version || "OK"}`);
    } else {
      console.log(`  ❌ [${agent.name}] ${agent.command} -> FAILED (${agent.error || "cannot execute"})`);
    }
  }
}

console.log("=================================================");
if (report.ok) {
  console.log("🎉 All checks passed!");
  process.exit(0);
} else {
  console.log("⚠️ Some checks failed.");
  process.exit(1);
}
