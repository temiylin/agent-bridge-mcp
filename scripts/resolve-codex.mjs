import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function resolveCodexExecutable(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const queryVersion = options.queryVersion || ((executable) => spawnSync(executable, ["--version"], {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 5000,
  }));
  const explicit = env.AGENT_BRIDGE_CODEX_EXE;
  const candidates = explicit ? [explicit] : [];
  if (!explicit) {
    const appBin = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    if (platform === "win32" && appBin && fs.existsSync(appBin)) {
      candidates.push(path.join(appBin, "codex.exe"));
      for (const entry of fs.readdirSync(appBin, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(appBin, entry.name, "codex.exe"));
      }
    }
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
    for (const directory of (env[pathKey] || "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
      candidates.push(path.join(directory, platform === "win32" ? "codex.exe" : "codex"));
    }
  }
  const versions = [];
  for (const candidate of new Set(candidates)) {
    // Windows .cmd/.bat shims require a shell and can select a stale CLI package.
    if (platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) continue;
    try { if (!fs.statSync(candidate).isFile()) continue; } catch { continue; }
    const query = queryVersion(candidate);
    const match = query.stdout?.match(/codex-cli (\d+)\.(\d+)\.(\d+)([^\s]*)/);
    if (query.status === 0 && match) versions.push({ path: candidate, numbers: match.slice(1, 4).map(Number), suffix: match[4] });
  }
  versions.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return b.numbers[i] - a.numbers[i];
    if (!a.suffix !== !b.suffix) return a.suffix ? 1 : -1;
    return b.suffix.localeCompare(a.suffix, undefined, { numeric: true });
  });
  if (!versions.length) throw new Error("No working native Codex executable was found");
  return versions[0].path;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) console.log(resolveCodexExecutable());
