# Agent Setup & Deployment Guide (Antigravity & Codex)

When a user asks you (Antigravity / Codex / AI Agent) to deploy, setup, or run this repository (e.g., "帮我部署下", "setup", "install"), execute the automated setup script:

```bash
npm run auto-setup
```

## What this does automatically:
1. Installs dependencies and builds the project binaries.
2. Generates a unique, persistent 192-bit Device Token for this machine.
3. Automatically registers the MCP server into local Codex (`codex mcp add`) and Antigravity (`agy mcp add`).
4. Installs and starts a background daemon (macOS LaunchAgent) so the device automatically connects to the central cloud relay hub.
5. Packages a personalized `agent-bridge-plugin.zip` onto the user's Desktop for one-click upload in ChatGPT Web/Desktop.

After running `npm run auto-setup`, inform the user:
- In Codex / Antigravity (AGY): The tools are already active and ready to use immediately.
- In ChatGPT: Go to Settings -> Connectors/MCP -> Click "上传插件压缩包" and select `~/Desktop/agent-bridge-plugin.zip` (or use the device-specific URL printed in the terminal).
