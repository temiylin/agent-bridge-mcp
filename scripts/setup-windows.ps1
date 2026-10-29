param(
    [ValidateSet('Install', 'Start', 'Stop', 'Status')]
    [string]$Action = 'Install',
    [string]$DataPath,
    [string]$OutputsPath,
    [string]$RelayServer,
    [string]$RelayHttp
)

$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$hasExplicitDataPath = [bool]$DataPath -or [bool]$env:AGENT_BRIDGE_ROOT
if (-not $DataPath) { $DataPath = $env:AGENT_BRIDGE_ROOT }
if (-not $DataPath) { $DataPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgentBridge' }
if (-not $OutputsPath) { $OutputsPath = $env:AGENT_BRIDGE_OUTPUTS }
if (-not $OutputsPath) { $OutputsPath = Join-Path $DataPath 'outputs' }
$DataPath = [IO.Path]::GetFullPath($DataPath)
$OutputsPath = [IO.Path]::GetFullPath($OutputsPath)
$runtimePath = Join-Path $DataPath 'launch-runtime.mjs'
$configPath = Join-Path $DataPath 'config.json'
$pidPath = Join-Path $DataPath 'relay.pid'
$stopPath = Join-Path $DataPath 'stop-request'

function Assert-NoLegacyWindowsInstall {
    param(
        [bool]$ExplicitDataPath,
        [string]$SelectedConfigPath,
        [string]$LegacyConfigPath,
        [string]$LegacyDataPath,
        [string]$LegacyStartupPath
    )
    if (Test-Path -LiteralPath $LegacyStartupPath) {
        throw 'A legacy agent-bridge.vbs startup entry exists. Stop the old relay and manually move that startup entry out of the Startup folder before installing. Preserve the old device token and agents.json; rerun with -DataPath pointing to the intended existing data directory.'
    }
    $hasLegacyConfig = Test-Path -LiteralPath $LegacyConfigPath -PathType Leaf
    if (-not $ExplicitDataPath -and $hasLegacyConfig -and (Test-Path -LiteralPath $LegacyDataPath -PathType Container)) {
        throw 'A legacy ~/.agent-bridge/config.json and ~/agent-bridge data directory exist. Installation stopped to avoid generating a second device identity. Stop the old relay, preserve its token and agents.json, and migrate its configuration into the intended data directory before rerunning with -DataPath.'
    }
    if ($ExplicitDataPath -and $hasLegacyConfig -and -not (Test-Path -LiteralPath $SelectedConfigPath)) {
        throw 'The selected data directory has no config.json, but a legacy ~/.agent-bridge/config.json exists. Installation stopped to preserve the device identity. Stop the old relay and copy its token configuration into the selected DataPath/config.json before rerunning. Preserve the existing agents.json as well.'
    }
}

function Read-Settings {
    if (-not (Test-Path -LiteralPath $configPath)) { return $null }
    # Never silently discard an unreadable configuration and rotate its token.
    return Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}

function Get-BridgeProcess {
    if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
    $storedPid = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$storedPid)) { return $null }
    if ($storedPid -le 0) { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.CommandLine -and $candidate.CommandLine.IndexOf($runtimePath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $candidate
    }
    return $null
}

function Start-Bridge {
    $existing = Get-BridgeProcess
    if ($existing) { Write-Output "Agent Bridge already running (PID $($existing.ProcessId))."; return }
    if (-not (Test-Path -LiteralPath $runtimePath)) { throw 'Run Install first.' }
    $settings = Read-Settings
    if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
    $runtime = Start-Process -FilePath $settings.nodePath -ArgumentList @('"' + $runtimePath + '"') -WorkingDirectory (Join-Path $DataPath 'workdir') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $DataPath 'logs\relay.stdout.log') -RedirectStandardError (Join-Path $DataPath 'logs\relay.stderr.log') -PassThru
    [IO.File]::WriteAllText($pidPath, [string]$runtime.Id)
    Start-Sleep -Seconds 2
    if (-not (Get-BridgeProcess)) { throw "Relay stopped during startup. Check logs in $DataPath\logs." }
    Write-Output "Agent Bridge running (PID $($runtime.Id))."
}

if ($Action -eq 'Status') {
    $running = Get-BridgeProcess
    if ($running) { Write-Output "Agent Bridge running (PID $($running.ProcessId))." }
    else { Write-Output 'Agent Bridge stopped.' }
    $connectionState = Join-Path $DataPath 'connection-state.json'
    if (Test-Path -LiteralPath $connectionState) { Get-Content -LiteralPath $connectionState }
    exit 0
}
if ($Action -eq 'Stop') {
    $running = Get-BridgeProcess
    if (-not $running) { Write-Output 'Agent Bridge already stopped.'; exit 0 }
    [IO.File]::WriteAllText($stopPath, 'stop')
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-BridgeProcess)) { break }
    }
    if (Get-BridgeProcess) { throw 'Graceful stop timed out; process was not forcefully terminated.' }
    Write-Output 'Agent Bridge stopped.'
    exit 0
}
if ($Action -eq 'Start') { Start-Bridge; exit 0 }

# Fail before creating directories, changing ACLs, credentials, MCP registration,
# or startup entries. Migration of an older layout is deliberately explicit.
$legacyHome = [Environment]::GetFolderPath('UserProfile')
Assert-NoLegacyWindowsInstall -ExplicitDataPath $hasExplicitDataPath -SelectedConfigPath $configPath `
    -LegacyConfigPath (Join-Path $legacyHome '.agent-bridge\config.json') `
    -LegacyDataPath (Join-Path $legacyHome 'agent-bridge') `
    -LegacyStartupPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'agent-bridge.vbs')

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = ((& $nodePath --version) | Select-Object -Last 1)
$nodeMajor = [int]([regex]::Match($nodeVersion, '^v(\d+)').Groups[1].Value)
if ($nodeMajor -lt 22) { throw 'Relay deployment requires Node.js 22 or newer.' }
$codexPath = ((& $nodePath (Join-Path $PSScriptRoot 'resolve-codex.mjs')) | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0) { throw 'No working native Codex executable was found.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'dist\client.js'))) { throw 'Build the project before running this installer.' }
$wasRunning = [bool](Get-BridgeProcess)
foreach ($subdir in @('', 'tasks', 'results', 'logs', 'workdir')) {
    $target = if ($subdir) { Join-Path $DataPath $subdir } else { $DataPath }
    [IO.Directory]::CreateDirectory($target) | Out-Null
}
$directoryAcl = Get-Acl -LiteralPath $DataPath
$directoryAcl.SetAccessRuleProtection($true, $false)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$directoryAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', $inheritance, $propagation, $allow))
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$directoryAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, 'FullControl', $inheritance, $propagation, $allow))
Set-Acl -LiteralPath $DataPath -AclObject $directoryAcl
$settings = Read-Settings
if (-not $RelayServer) { $RelayServer = $env:RELAY_SERVER }
if (-not $RelayServer -and $settings) { $RelayServer = [string]$settings.relayServer }
if (-not $RelayServer) { $RelayServer = 'wss://bridge.krow.top/ws' }
if (-not $RelayHttp) { $RelayHttp = $env:RELAY_HTTP }
if (-not $RelayHttp -and $settings) { $RelayHttp = [string]$settings.relayHttp }
if (-not $RelayHttp) { $RelayHttp = 'https://bridge.krow.top/mcp' }
if (([Uri]$RelayServer).Scheme -ne 'wss' -or ([Uri]$RelayHttp).Scheme -ne 'https') { throw 'Cloud relay endpoints must use WSS and HTTPS.' }
$deviceToken = if ($settings) { [string]$settings.deviceToken } else { '' }
if ($deviceToken -notmatch '^dev_[0-9a-f]{48}$') {
    $randomBytes = New-Object byte[] 24
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
    $deviceToken = 'dev_' + ([BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant())
}
$updatedSettings = [ordered]@{}
if ($settings) { foreach ($property in $settings.PSObject.Properties) { $updatedSettings[$property.Name] = $property.Value } }
$updatedSettings.deviceToken = $deviceToken
$updatedSettings.nodePath = $nodePath
$updatedSettings.repoPath = $repoPath
$updatedSettings.dataPath = $DataPath
$updatedSettings.dataRoot = $DataPath
$updatedSettings.outputsPath = $OutputsPath
$updatedSettings.relayServer = $RelayServer
$updatedSettings.relayHttp = $RelayHttp.TrimEnd('/')
$settings = $updatedSettings
[IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
$agentsPath = Join-Path $DataPath 'agents.json'
if (-not (Test-Path -LiteralPath $agentsPath)) {
    $catalog = ((& $nodePath (Join-Path $PSScriptRoot 'query-native-models.mjs') $codexPath) | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Could not discover the native Codex model catalog.' }
    $defaultModel = $catalog.models | Where-Object { $_.isDefault -and -not $_.hidden } | Select-Object -First 1
    if (-not $defaultModel) { throw 'The native Codex catalog did not return a default model.' }
    $agents = @{ codex = @{ command = $codexPath; args = @('exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-c', ('model="' + $defaultModel.model + '"'), '-c', ('model_reasoning_effort="' + $defaultModel.defaultReasoningEffort + '"')); input = 'stdin' } }
    [IO.File]::WriteAllText($agentsPath, ($agents | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}

$runtimeSource = @'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dataPath = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf8'));
process.env.AGENT_BRIDGE_ROOT = dataPath;
process.env.AGENT_BRIDGE_REPO = config.repoPath;
process.env.AGENT_BRIDGE_NOTIFY = '0';
process.env.HOST = '127.0.0.1';
process.env.AGENT_BRIDGE_EMBEDDED_WORKER = '1';
process.env.RELAY_SERVER = config.relayServer;
process.env.RELAY_HTTP = config.relayHttp;
process.env.DEVICE_TOKEN = config.deviceToken;
process.chdir(path.join(dataPath, 'workdir'));
const statePath = path.join(dataPath, 'connection-state.json');
function state(connected) {
  fs.writeFileSync(statePath, JSON.stringify({ connected, time: new Date().toISOString(), relay: config.relayServer }, null, 2));
}
state(false);
const { startRelayClient } = await import(pathToFileURL(path.join(config.repoPath, 'dist', 'client.js')).href);
const handle = await startRelayClient({ serverUrl: config.relayServer, token: config.deviceToken, customRootDir: dataPath, onConnect: () => state(true), onDisconnect: () => state(false) });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  handle.close();
  state(false);
  try { fs.unlinkSync(path.join(dataPath, 'relay.pid')); } catch {}
  try { fs.unlinkSync(path.join(dataPath, 'stop-request')); } catch {}
  setTimeout(() => process.exit(0), 300);
}
setInterval(() => { if (fs.existsSync(path.join(dataPath, 'stop-request'))) stop(); }, 250);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
'@
[IO.File]::WriteAllText($runtimePath, $runtimeSource, [Text.UTF8Encoding]::new($false))

# The current user's Startup folder requires no administrator privileges.
$startupPath = [Environment]::GetFolderPath('Startup')
$startupFile = Join-Path $startupPath 'AgentBridge.vbs'
$installerPath = $PSCommandPath
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startCommand = '"' + $powershellPath + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $installerPath + '" -Action Start -DataPath "' + $DataPath + '"'
$vbsCommand = $startCommand.Replace('"', '""')
$vbsSource = "Set shell = CreateObject(""WScript.Shell"")`r`nshell.Run ""$vbsCommand"", 0, False`r`n"
[IO.File]::WriteAllText($startupFile, $vbsSource, [Text.UnicodeEncoding]::new($false, $true))

[IO.Directory]::CreateDirectory($OutputsPath) | Out-Null
$packPath = Join-Path $DataPath 'plugin-package'
[IO.Directory]::CreateDirectory((Join-Path $packPath 'skills\agent-bridge')) | Out-Null
Copy-Item -LiteralPath (Join-Path $repoPath 'plugin-package\plugin.json') -Destination (Join-Path $packPath 'plugin.json') -Force
Copy-Item -LiteralPath (Join-Path $repoPath 'plugin-package\skills\agent-bridge\SKILL.md') -Destination (Join-Path $packPath 'skills\agent-bridge\SKILL.md') -Force
$deviceUrl = $settings.relayHttp + '/' + $deviceToken
$mcpConfig = [ordered]@{ '$schema' = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'; mcpServers = @{ 'agent-bridge' = @{ type = 'streamable-http'; url = $deviceUrl } } }
[IO.File]::WriteAllText((Join-Path $packPath 'mcp.json'), ($mcpConfig | ConvertTo-Json -Depth 7), [Text.UTF8Encoding]::new($false))
$zipPath = Join-Path $OutputsPath 'agent-bridge-plugin.zip'
Compress-Archive -Path (Join-Path $packPath '*') -DestinationPath $zipPath -Force
$connectionText = "Agent Bridge connection details`r`n`r`nMCP URL: $deviceUrl`r`nAuthentication: None (the URL contains your device access token).`r`n`r`nKeep this file and the plugin ZIP private. Import the ZIP into ChatGPT, or add the MCP URL manually.`r`n"
$connectionFileName = -join @([char]0x8fde, [char]0x63a5, [char]0x4fe1, [char]0x606f, '.txt')
[IO.File]::WriteAllText((Join-Path $OutputsPath $connectionFileName), $connectionText, [Text.UTF8Encoding]::new($false))
$mcpArguments = @('mcp', 'add', 'agent-bridge', '--env', ('AGENT_BRIDGE_ROOT=' + $DataPath), '--env', ('AGENT_BRIDGE_REPO=' + $repoPath), '--', $nodePath, (Join-Path $repoPath 'dist\index.js'))
# Native executable + argument array avoids cmd.exe quoting and does not expose the device token.
$registrationErrorPreference = $ErrorActionPreference
try {
    # Windows PowerShell 5.1 turns native stderr into ErrorRecords; warnings on
    # a successful registration must not become terminating errors.
    $ErrorActionPreference = 'Continue'
    $registrationOutput = & $codexPath @mcpArguments 2>&1
    $registrationExitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $registrationErrorPreference }
if ($registrationExitCode -ne 0) { throw 'Could not register Agent Bridge with the native Codex CLI.' }
if ($wasRunning) {
    Write-Output 'Configuration and build paths updated; the current relay was left running to preserve active tasks.'
    Write-Output 'After tasks finish, run this script with -Action Stop and then -Action Start to load the update.'
} else { Start-Bridge }
Write-Output "Login startup configured: $startupFile"
Write-Output "Plugin ZIP created: $zipPath"
Write-Output 'Device credentials are stored locally; no token was printed.'
