# Agent Setup & Deployment Guide

When a user asks you (Codex / AI Agent) to deploy, setup, or run this repository (e.g., "帮我部署下", "setup", "install"), execute the automated setup script:

```bash
npm run auto-setup
```

## What this does automatically:
1. Installs dependencies and builds the project binaries.
2. Generates a unique, persistent Device Token for this machine.
3. Configures the platform's local execution agents and supported MCP registrations. Preserve existing agent settings and report any registration failures.
4. Installs and starts a background daemon (macOS LaunchAgent or a hidden Windows login startup entry) so the device connects to the central cloud relay hub.
5. Packages a personalized `agent-bridge-plugin.zip` for upload in ChatGPT Web/Desktop. On Windows, use the output location reported by the installer.

After running `npm run auto-setup`, inform the user:
- Report which clients were actually registered; do not claim an agent can execute tasks until verified.
- In ChatGPT: import the generated plugin ZIP, or use the device-specific endpoint from the locally saved connection details. These files contain access credentials and must not be committed or shared publicly.
- On Windows, use `scripts/setup-windows.ps1 -Action Status`, `Stop`, or `Start` to manage the existing runtime. Avoid rerunning `Install` merely to restart it.
