import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ResolvedTokenResult {
  token: string;
  source: "cli" | "env_token" | "env_file" | "config_file" | "default";
  deprecatedCliUsed?: boolean;
}

/**
 * Resolves the device connection token according to the following precedence:
 * 1. CLI flag (--token / -t): supported for backward compatibility, emits deprecation warning
 * 2. AGENT_BRIDGE_TOKEN env var
 * 3. AGENT_BRIDGE_TOKEN_FILE env var (path to file containing token)
 * 4. DEVICE_TOKEN env var (legacy)
 * 5. ~/.agent-bridge/config.json (legacy config file)
 * 6. Fallback default ("dev_default")
 *
 * NOTE: The raw token must NEVER be printed to logs or standard output.
 */
export function resolveDeviceToken(cliToken?: string, logWarning: (msg: string) => void = console.warn): ResolvedTokenResult {
  if (cliToken && cliToken.trim()) {
    logWarning("Deprecation warning: Passing device token via command line flag (--token / -t) is deprecated for security reasons. Please use AGENT_BRIDGE_TOKEN or AGENT_BRIDGE_TOKEN_FILE instead.");
    return {
      token: cliToken.trim(),
      source: "cli",
      deprecatedCliUsed: true,
    };
  }

  const envToken = process.env.AGENT_BRIDGE_TOKEN;
  if (envToken && envToken.trim()) {
    return {
      token: envToken.trim(),
      source: "env_token",
    };
  }

  const envTokenFile = process.env.AGENT_BRIDGE_TOKEN_FILE;
  if (envTokenFile && envTokenFile.trim()) {
    try {
      const filePath = path.resolve(envTokenFile.trim());
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) {
          return {
            token: content,
            source: "env_file",
          };
        }
      }
    } catch (err: any) {
      logWarning(`Warning: Failed to read token file specified by AGENT_BRIDGE_TOKEN_FILE: ${err?.message || String(err)}`);
    }
  }

  const legacyDeviceToken = process.env.DEVICE_TOKEN;
  if (legacyDeviceToken && legacyDeviceToken.trim()) {
    return {
      token: legacyDeviceToken.trim(),
      source: "env_token",
    };
  }

  try {
    const candidateDirs = [
      path.join(os.homedir(), ".agent-bridge"),
      path.join(os.homedir(), "agent-bridge"),
    ];
    for (const dir of candidateDirs) {
      const cfgPath = path.join(dir, "config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (cfg && typeof cfg.deviceToken === "string" && cfg.deviceToken.trim()) {
          return {
            token: cfg.deviceToken.trim(),
            source: "config_file",
          };
        }
      }
    }
  } catch {}

  return {
    token: "dev_default",
    source: "default",
  };
}
