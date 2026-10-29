import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveCodexExecutable } from "../scripts/resolve-codex.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-setup-test-"));
try {
  const oldBin = path.join(fixture, "old");
  const newBin = path.join(fixture, "new with spaces");
  fs.mkdirSync(oldBin);
  fs.mkdirSync(newBin);
  const oldExe = path.join(oldBin, "codex.exe");
  const newExe = path.join(newBin, "codex.exe");
  const cmdShim = path.join(newBin, "codex.cmd");
  for (const filename of [oldExe, newExe, cmdShim]) fs.writeFileSync(filename, "fixture - never executed");
  const queried = [];
  const queryVersion = filename => {
    queried.push(filename);
    return { status: 0, stdout: filename === oldExe ? "codex-cli 0.100.0" : "codex-cli 0.165.0-alpha.1.2" };
  };
  const options = { platform: "win32", env: { Path: `${oldBin};${newBin}` }, queryVersion };
  assert.equal(resolveCodexExecutable(options), newExe, "newest native CLI wins over an older PATH entry");
  assert.equal(resolveCodexExecutable({ ...options, env: { AGENT_BRIDGE_CODEX_EXE: oldExe } }), oldExe, "explicit path is honored");
  assert.throws(() => resolveCodexExecutable({ ...options, env: { AGENT_BRIDGE_CODEX_EXE: cmdShim } }), /No working native/);
  assert.equal(queried.includes(cmdShim), false, "batch shims are never executed");

  const configDir = path.join(fixture, "private data");
  fs.mkdirSync(configDir);
  const testToken = `dev_${"a".repeat(48)}`;
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ deviceToken: testToken, relayHttp: "https://relay.example.test/mcp" }));
  const url = spawnSync(process.execPath, [path.join(repoRoot, "scripts/device-url.mjs"), "--raw"], {
    encoding: "utf8", shell: false, windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_ROOT: configDir, RELAY_HTTP: "" },
  });
  assert.equal(url.status, 0);
  assert.equal(url.stdout.trim(), `https://relay.example.test/mcp/${testToken}`, "URL query reads the selected configuration");

  const setupSource = fs.readFileSync(path.join(repoRoot, "scripts/setup-windows.ps1"), "utf8");
  assert.match(setupSource, /process\.env\.HOST = '127\.0\.0\.1'/);
  assert.match(setupSource, /if \(-not \(Test-Path -LiteralPath \$agentsPath\)\)/, "existing agents are preserved");
  assert.doesNotMatch(setupSource, /dangerously-skip-permissions/);
  assert.match(setupSource, /if \(\$wasRunning\)/, "active relays are not automatically restarted");
  assert.match(setupSource, /\$settings \| ConvertTo-Json -Depth 100/, "nested configuration fields are preserved");
  assert.match(setupSource, /\$registrationExitCode = \$LASTEXITCODE/);
  assert.match(setupSource, /finally \{ \$ErrorActionPreference = \$registrationErrorPreference \}/, "native warnings do not persistently change error handling");
  const autoSetup = fs.readFileSync(path.join(repoRoot, "scripts/auto-setup.mjs"), "utf8");
  assert.ok(autoSetup.indexOf('execSync("npm run build"') < autoSetup.indexOf('if (process.platform === "win32")'), "Windows setup builds before installation");
  assert.match(autoSetup, /if \(process\.env\.RELAY_SERVER\) args\.push\("-RelayServer", process\.env\.RELAY_SERVER\)/, "only explicit relay overrides reach the installer");
  assert.match(autoSetup, /if \(process\.env\.RELAY_HTTP\) args\.push\("-RelayHttp", process\.env\.RELAY_HTTP\)/);
  for (const name of ["auto-setup.mjs", "build-permissions.mjs", "query-native-models.mjs", "resolve-codex.mjs", "windows-smoke.mjs", "device-url.mjs"]) {
    const syntax = spawnSync(process.execPath, ["--check", path.join(repoRoot, "scripts", name)], { encoding: "utf8", windowsHide: true });
    assert.equal(syntax.status, 0, `${name} syntax: ${syntax.stderr}`);
  }
  if (process.platform === "win32") {
    const filename = path.join(repoRoot, "scripts/setup-windows.ps1").replaceAll("'", "''");
    const parse = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$tokens = $null; $errors = $null; [Management.Automation.Language.Parser]::ParseFile('${filename}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`],
    { encoding: "utf8", windowsHide: true, shell: false });
    assert.equal(parse.status, 0, `PowerShell syntax: ${parse.stderr}`);
    const registrationBlock = setupSource.slice(setupSource.indexOf('$registrationErrorPreference ='), setupSource.indexOf('if ($wasRunning)', setupSource.indexOf('$registrationErrorPreference =')));
    const nodeExe = process.execPath.replaceAll("'", "''");
    const nativeFixture = path.join(fixture, 'native-stderr-fixture.mjs');
    fs.writeFileSync(nativeFixture, 'process.stderr.write("warning only"); process.exit(0);');
    const warningProbe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = 'Stop'; $codexPath = '${nodeExe}'; $mcpArguments = @('${nativeFixture.replaceAll("'", "''")}'); ${registrationBlock}; if ($ErrorActionPreference -ne 'Stop' -or $registrationExitCode -ne 0) { exit 1 }; Write-Output 'OK'`],
    { encoding: "utf8", windowsHide: true, shell: false });
    assert.equal(warningProbe.status, 0, `Native registration stderr compatibility: ${warningProbe.stderr}`);
    assert.match(warningProbe.stdout, /OK/);
    const legacyGuard = setupSource.slice(setupSource.indexOf('function Assert-NoLegacyWindowsInstall'), setupSource.indexOf('function Read-Settings'));
    assert.ok(setupSource.indexOf('Assert-NoLegacyWindowsInstall -ExplicitDataPath') < setupSource.indexOf('[IO.Directory]::CreateDirectory'), 'legacy layout check precedes installer mutations');
    const legacyConfig = path.join(fixture, 'legacy-config.json');
    const legacyData = path.join(fixture, 'legacy-data');
    const legacyStartup = path.join(fixture, 'agent-bridge.vbs');
    const selectedConfig = path.join(fixture, 'selected-config.json');
    const quotePs = value => `'${value.replaceAll("'", "''")}'`;
    const legacyProbe = explicit => {
      const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `${legacyGuard}; try { Assert-NoLegacyWindowsInstall -ExplicitDataPath $${explicit} -SelectedConfigPath ${quotePs(selectedConfig)} -LegacyConfigPath ${quotePs(legacyConfig)} -LegacyDataPath ${quotePs(legacyData)} -LegacyStartupPath ${quotePs(legacyStartup)}; Write-Output 'ALLOWED' } catch { Write-Output 'BLOCKED' }`],
      { encoding: 'utf8', windowsHide: true, shell: false });
      assert.equal(check.status, 0, check.stderr);
      return check.stdout.trim();
    };
    assert.equal(legacyProbe(false), 'ALLOWED', 'fresh installs are allowed');
    fs.writeFileSync(legacyConfig, '{}');
    fs.mkdirSync(legacyData);
    assert.equal(legacyProbe(false), 'BLOCKED', 'default installation cannot silently create a second identity');
    assert.equal(legacyProbe(true), 'BLOCKED', 'explicit data without migrated token config is blocked');
    fs.writeFileSync(selectedConfig, '{}');
    assert.equal(legacyProbe(true), 'ALLOWED', 'explicitly migrated configuration is allowed');
    fs.writeFileSync(legacyStartup, 'fixture');
    assert.equal(legacyProbe(true), 'BLOCKED', 'a legacy startup entry prevents a second worker');
  }
  console.log("PASS: native CLI selection, explicit paths, shim rejection, selected configuration, installer guards, and script syntax (no installation or inference run).");
} finally {
  assert.equal(path.dirname(fixture), os.tmpdir());
  assert.ok(path.basename(fixture).startsWith("agent-bridge-setup-test-"));
  fs.rmSync(fixture, { recursive: true, force: true });
}
