import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getProcessTreeCpuTime, newestMtime } from "./task-reconcile.js";

export interface TaskSessionTrackerOptions {
  taskId: string;
  agentName: string;
  command?: string;
  workDir?: string;
  prompt?: string;
  sessionId?: string;
  profileHome?: string;
  startedAtMs?: number;
}

export interface ActivityCheckResult {
  hasActivity: boolean;
  activity: "active" | "idle";
  lastActivityTime: number;
  last_activity_at: string;
  idle_seconds: number;
  activity_source: string;
}

interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

/**
 * Checks for non-empty crash log in crashes directory.
 * Ignores 0-byte crash files which agy generates on normal startup.
 */
export function getNonEmptyCrashLog(cliDir: string, pid?: number): string | null {
  const crashesDir = path.join(cliDir, "crashes");
  if (!fs.existsSync(crashesDir)) return null;
  try {
    const files = fs.readdirSync(crashesDir);
    for (const file of files) {
      if (pid && !file.includes(String(pid))) continue;
      const full = path.join(crashesDir, file);
      try {
        const st = fs.statSync(full);
        if (st.size > 0) {
          return full;
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Accurately tracks per-task session logs and monitors 4 independent activity signals:
 * 1. Bound task session log size / mtime growth (never scanning global directories)
 * 2. stdout / stderr growth
 * 3. Process tree CPU time increase
 * 4. Task workDir file modifications
 */
export class TaskSessionTracker {
  public readonly taskId: string;
  public readonly agentName: string;
  public readonly isAgy: boolean;
  public readonly isCodex: boolean;
  public readonly workDir?: string;
  public readonly prompt?: string;
  public readonly startedAtMs: number;

  private agyCliHome: string;
  private codexHome: string;
  private initialBrainDirs: Set<string> = new Set();
  private boundSessionFiles: string[] = [];
  private boundConversationId?: string;
  private boundCodexSessionId?: string;

  private fileSnapshots = new Map<string, FileSnapshot>();
  private lastStdoutLen = 0;
  private lastStderrLen = 0;
  private lastCpuSec = 0;
  private lastWorkDirMtime = 0;

  private lastActivityTime: number;
  private lastActivitySource = "none";

  constructor(opts: TaskSessionTrackerOptions) {
    this.taskId = opts.taskId;
    this.agentName = opts.agentName;
    this.isAgy = opts.command?.includes("agy") || opts.agentName === "agy";
    this.isCodex = opts.command?.includes("codex") || opts.agentName === "codex";
    this.workDir = opts.workDir;
    this.prompt = opts.prompt;
    this.startedAtMs = opts.startedAtMs || Date.now();
    this.lastActivityTime = this.startedAtMs;

    // Resolve agy CLI home directory
    if (process.env.GEMINI_CLI_HOME) {
      this.agyCliHome = process.env.GEMINI_CLI_HOME;
    } else if (opts.profileHome && fs.existsSync(path.join(opts.profileHome, ".gemini", "antigravity-cli"))) {
      this.agyCliHome = path.join(opts.profileHome, ".gemini", "antigravity-cli");
    } else {
      this.agyCliHome = path.join(os.homedir(), ".gemini", "antigravity-cli");
    }

    // Resolve Codex home directory
    this.codexHome = process.env.CODEX_CLI_HOME || path.join(os.homedir(), ".codex");

    // Pre-snapshot existing agy brain directories to detect the newly created conversation
    if (this.isAgy) {
      const brainDir = path.join(this.agyCliHome, "brain");
      if (fs.existsSync(brainDir)) {
        try {
          const dirs = fs.readdirSync(brainDir);
          for (const d of dirs) this.initialBrainDirs.add(d);
        } catch {}
      }
      if (opts.sessionId) {
        this.bindAgyConversation(opts.sessionId);
      }
    }

    if (this.isCodex && opts.sessionId) {
      this.bindCodexSession(opts.sessionId);
    }

    if (this.workDir && fs.existsSync(this.workDir)) {
      this.lastWorkDirMtime = newestMtime(this.workDir);
    }
  }

  /**
   * Binds an agy conversationId to its exact transcript.jsonl and .db files.
   */
  public bindAgyConversation(conversationId: string): void {
    if (this.boundConversationId === conversationId) return;
    this.boundConversationId = conversationId;
    const brainDir = path.join(this.agyCliHome, "brain");
    const convsDir = path.join(this.agyCliHome, "conversations");

    const transcriptPath = path.join(brainDir, conversationId, ".system_generated", "logs", "transcript.jsonl");
    const dbPath = path.join(convsDir, `${conversationId}.db`);

    this.boundSessionFiles = [transcriptPath, dbPath];
    for (const f of this.boundSessionFiles) {
      if (fs.existsSync(f)) {
        try {
          const st = fs.statSync(f);
          this.fileSnapshots.set(f, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
  }

  /**
   * Binds a Codex session ID to its rollout file.
   */
  public bindCodexSession(sessionId: string): void {
    if (this.boundCodexSessionId === sessionId) return;
    this.boundCodexSessionId = sessionId;
    const sessionsDir = path.join(this.codexHome, "sessions");
    if (!fs.existsSync(sessionsDir)) return;

    const findMatch = (dir: string, depth = 0): string | null => {
      if (depth > 4) return null;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            const found = findMatch(p, depth + 1);
            if (found) return found;
          } else if (ent.name.includes(sessionId)) {
            return p;
          }
        }
      } catch {}
      return null;
    };

    const matched = findMatch(sessionsDir);
    if (matched) {
      this.boundSessionFiles = [matched];
      try {
        const st = fs.statSync(matched);
        this.fileSnapshots.set(matched, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }

  /**
   * Discovers newly created conversation directories for agy tasks.
   */
  private tryDiscoverAgyConversation(): void {
    if (this.boundConversationId) return;
    const brainDir = path.join(this.agyCliHome, "brain");
    if (!fs.existsSync(brainDir)) return;

    try {
      const currentDirs = fs.readdirSync(brainDir);
      const candidates: string[] = [];

      for (const d of currentDirs) {
        if (!this.initialBrainDirs.has(d)) {
          candidates.push(d);
        }
      }

      // Check candidates for cwd match or prompt match
      for (const cand of candidates) {
        const candDir = path.join(brainDir, cand);
        const transcriptFile = path.join(candDir, ".system_generated", "logs", "transcript.jsonl");
        if (fs.existsSync(transcriptFile)) {
          let matched = false;
          if (this.workDir) {
            try {
              // Read first 16KB of transcript to check workspace / cwd match
              const fd = fs.openSync(transcriptFile, "r");
              const buf = Buffer.alloc(16384);
              const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
              fs.closeSync(fd);
              const header = buf.toString("utf8", 0, bytesRead);
              if (header.includes(this.workDir) || (this.prompt && header.includes(this.prompt.slice(0, 50)))) {
                matched = true;
              }
            } catch {}
          } else if (this.prompt) {
            try {
              const fd = fs.openSync(transcriptFile, "r");
              const buf = Buffer.alloc(16384);
              const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
              fs.closeSync(fd);
              const header = buf.toString("utf8", 0, bytesRead);
              if (header.includes(this.prompt.slice(0, 50))) {
                matched = true;
              }
            } catch {}
          }
          if (matched || (!this.workDir && !this.prompt && candidates.length === 1)) {
            this.bindAgyConversation(cand);
            break;
          }
        }
      }
    } catch {}
  }

  /**
   * Checks the 4 activity signals:
   * - Signal 1: stdout / stderr length growth
   * - Signal 2: bound session log size or mtime growth
   * - Signal 3: process tree CPU time delta
   * - Signal 4: workDir mtime modification
   */
  public checkActivity(params: {
    childPid?: number;
    stdoutLen?: number;
    stderrLen?: number;
    extractedSessionId?: string;
    stuckThresholdMs?: number;
  }): ActivityCheckResult {
    const now = Date.now();
    const stuckThresholdMs = params.stuckThresholdMs || 180000;
    let hasDelta = false;
    let deltaSource = "";

    // Check stdout growth
    const curStdout = params.stdoutLen ?? this.lastStdoutLen;
    if (curStdout > this.lastStdoutLen) {
      hasDelta = true;
      deltaSource = "stdout";
      this.lastStdoutLen = curStdout;
      this.lastActivityTime = now;
    }

    // Check stderr growth
    const curStderr = params.stderrLen ?? this.lastStderrLen;
    if (curStderr > this.lastStderrLen) {
      hasDelta = true;
      deltaSource = deltaSource || "stderr";
      this.lastStderrLen = curStderr;
      this.lastActivityTime = now;
    }

    // Bind session ID if extracted
    if (params.extractedSessionId) {
      if (this.isAgy && !this.boundConversationId) {
        this.bindAgyConversation(params.extractedSessionId);
      } else if (this.isCodex && !this.boundCodexSessionId) {
        this.bindCodexSession(params.extractedSessionId);
      }
    }

    // Try auto-discovery for agy if not yet bound
    if (this.isAgy && !this.boundConversationId) {
      this.tryDiscoverAgyConversation();
    }

    // Check Signal 1: Bound session log size or mtime growth
    for (const filePath of this.boundSessionFiles) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const st = fs.statSync(filePath);
        const prev = this.fileSnapshots.get(filePath);
        if (!prev) {
          // Newly appeared bound file
          hasDelta = true;
          deltaSource = deltaSource || "session_log";
          this.fileSnapshots.set(filePath, { size: st.size, mtimeMs: st.mtimeMs });
          this.lastActivityTime = Math.max(this.lastActivityTime, st.mtimeMs, now);
        } else if (st.size > prev.size || st.mtimeMs > prev.mtimeMs) {
          hasDelta = true;
          deltaSource = deltaSource || "session_log";
          this.fileSnapshots.set(filePath, { size: st.size, mtimeMs: st.mtimeMs });
          this.lastActivityTime = Math.max(this.lastActivityTime, st.mtimeMs, now);
        }
      } catch {}
    }

    // Check Signal 3: Process tree CPU time increase (require >= 1.0s sustained CPU delta to avoid idle polling jitter)
    if (params.childPid) {
      const currentCpu = getProcessTreeCpuTime(params.childPid);
      if (currentCpu > this.lastCpuSec + 1.0) {
        hasDelta = true;
        deltaSource = deltaSource || "cpu";
        this.lastCpuSec = currentCpu;
        this.lastActivityTime = now;
      }
    }

    // Check Signal 4: workDir changes
    if (this.workDir && fs.existsSync(this.workDir)) {
      const currentWorkMtime = newestMtime(this.workDir);
      if (currentWorkMtime > this.lastWorkDirMtime) {
        hasDelta = true;
        deltaSource = deltaSource || "workdir";
        this.lastWorkDirMtime = currentWorkMtime;
        this.lastActivityTime = Math.max(this.lastActivityTime, currentWorkMtime, now);
      }
    }

    if (deltaSource) {
      this.lastActivitySource = deltaSource;
    }

    const idleSeconds = Math.max(0, Math.floor((now - this.lastActivityTime) / 1000));
    const idleCutoffSec = Math.min(30, Math.max(1, Math.floor(stuckThresholdMs / 2000)));
    const activity: "active" | "idle" = idleSeconds >= idleCutoffSec ? "idle" : "active";

    return {
      hasActivity: hasDelta,
      activity,
      lastActivityTime: this.lastActivityTime,
      last_activity_at: new Date(this.lastActivityTime).toISOString(),
      idle_seconds: idleSeconds,
      activity_source: this.lastActivitySource,
    };
  }

  public getBoundSessionFiles(): string[] {
    return [...this.boundSessionFiles];
  }

  public getBoundConversationId(): string | undefined {
    return this.boundConversationId;
  }
}
