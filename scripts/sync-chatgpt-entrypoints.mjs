import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const statePath = path.join(process.env.HOME, ".codex/.codex-global-state.json");
if (!fs.existsSync(statePath)) {
  console.error("State file not found:", statePath);
  process.exit(1);
}

// 1. Fetch tools from dist/index.js
function getTools() {
  return new Promise((resolve, reject) => {
    const proc = spawn("/usr/local/bin/node", ["/Users/news/code/mcp/agent-bridge-mcp/dist/index.js"], {
      env: {
        ...process.env,
        AGENT_BRIDGE_ROOT: "/Users/news/agent-bridge",
        AGENT_BRIDGE_REPO: "/Users/news/code/mcp/agent-bridge-mcp"
      }
    });

    let buffer = "";
    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const msg = JSON.parse(l);
          if (msg.id === 2) {
            proc.kill();
            resolve(msg.result.tools || []);
          }
        } catch (e) {}
      }
    });

    proc.on("error", reject);

    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    }) + "\n");

    setTimeout(() => {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    }, 300);
  });
}

const rawTools = await getTools();
console.log(`Fetched ${rawTools.length} tools from agent-bridge-mcp.`);

const formattedTools = rawTools.map((t) => ({
  name: t.name,
  description: t.description || `Tool ${t.name} from agent-bridge.`,
  inputSchema: t.inputSchema || { type: "object", properties: {} },
  _meta: {
    ui: {
      resourceUri: "ui://agent-bridge/app",
      visibility: ["app", "model"]
    }
  }
}));

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const atom = state["electron-persisted-atom-state"] || {};
const entrypoints = atom["mcp-global-entrypoints-v2"] || {};

for (const key of Object.keys(entrypoints)) {
  const list = entrypoints[key];
  const existingIdx = list.findIndex((s) => s.server === "agent-bridge");
  const newEntry = {
    server: "agent-bridge",
    pluginId: "agent-bridge@local-marketplace",
    pluginVersion: "1.0.0",
    httpOrigin: null,
    tools: formattedTools
  };
  if (existingIdx >= 0) {
    list[existingIdx] = newEntry;
    console.log("Updated agent-bridge in key:", key);
  } else {
    list.push(newEntry);
    console.log("Added agent-bridge to key:", key);
  }
}

// Backup
const bakPath = `${statePath}.bak.${Date.now()}`;
fs.writeFileSync(bakPath, fs.readFileSync(statePath));
console.log("Backup written to:", bakPath);

// Write updated state
fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
console.log("Successfully updated ~/.codex/.codex-global-state.json!");
