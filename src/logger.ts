import fs from "node:fs";
import path from "node:path";

export class BridgeLogger {
  private logFilePath: string;

  constructor(logsDir: string) {
    this.logFilePath = path.join(logsDir, "server.log");
  }

  public log(level: "INFO" | "WARN" | "ERROR", message: string): void {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${level}] ${message}\n`;

    try {
      fs.appendFileSync(this.logFilePath, formatted, "utf8");
    } catch {
      // Ignore disk log failure to keep server operational
    }

    // stdio transport safety: ONLY output to stderr, never stdout!
    console.error(formatted.trimEnd());
  }

  public info(message: string): void {
    this.log("INFO", message);
  }

  public warn(message: string): void {
    this.log("WARN", message);
  }

  public error(message: string): void {
    this.log("ERROR", message);
  }
}
