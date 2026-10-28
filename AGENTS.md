# Agent Setup & Deployment Guide

When a user asks you (Codex / AI Agent) to deploy, setup, or run this repository (e.g., "帮我部署下", "setup", "install"), execute the automated setup script:

```bash
npm run auto-setup
```

## What this does automatically:
1. Installs dependencies and builds the project binaries.
2. Generates a unique, persistent Device Token for this machine.
3. Automatically registers the MCP server into local Codex via `codex mcp add`.
4. Installs and starts a background daemon (macOS LaunchAgent) so the device automatically connects to the central cloud relay at `wss://bridge.krow.top/ws`.
5. Packages a personalized `agent-bridge-plugin.zip` onto the user's Desktop for one-click upload in ChatGPT Web/Desktop.

After running `npm run auto-setup`, inform the user:
- In Codex: The tools are already active and ready to use immediately.
- In ChatGPT: Go to Settings -> Connectors/MCP -> Click "上传插件压缩包" and select `~/Desktop/agent-bridge-plugin.zip`.
