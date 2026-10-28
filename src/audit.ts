import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  tool?: string;
  taskId?: string;
  agent?: string;
  state?: string;
  exitCode?: number | null;
  ts?: string;
}

const MAX_AUDIT_LOG_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Writes an audit record to $AGENT_BRIDGE_ROOT/logs/audit.log.
 * Only the allowed fields (tool, taskId, agent, state, exitCode, ts) are written.
 * Rotates to audit.log.1 when size exceeds 10MB.
 */
export function audit(root: string, entry: AuditEntry): void {
  const logsDir = path.join(root, "logs");
  if (!fs.existsSync(logsDir)) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {
      // ignore directory creation error
    }
  }

  const auditLogPath = path.join(logsDir, "audit.log");
  const auditBackupPath = path.join(logsDir, "audit.log.1");

  // Filter strictly to allowed fields
  const filteredEntry: Record<string, any> = {};
  if (entry.tool !== undefined) filteredEntry.tool = entry.tool;
  if (entry.taskId !== undefined) filteredEntry.taskId = entry.taskId;
  if (entry.agent !== undefined) filteredEntry.agent = entry.agent;
  if (entry.state !== undefined) filteredEntry.state = entry.state;
  if (entry.exitCode !== undefined) filteredEntry.exitCode = entry.exitCode;
  filteredEntry.ts = entry.ts || new Date().toISOString();

  const line = JSON.stringify(filteredEntry) + "\n";

  try {
    if (fs.existsSync(auditLogPath)) {
      const stats = fs.statSync(auditLogPath);
      if (stats.size >= MAX_AUDIT_LOG_SIZE) {
        try {
          fs.renameSync(auditLogPath, auditBackupPath);
        } catch {
          // ignore rotation failure
        }
      }
    }
    fs.appendFileSync(auditLogPath, line, "utf8");
  } catch {
    // Audit logging failure should not crash caller
  }
}
