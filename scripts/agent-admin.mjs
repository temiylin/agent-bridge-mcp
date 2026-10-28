#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const PRESETS = Object.freeze([
  Object.freeze({
    name: "codex",
    command: "codex",
    args: Object.freeze(["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"]),
    input: "stdin",
  }),
]);

const MAX_BODY_BYTES = 16 * 1024;
const PROBE_TIMEOUT_MS = 30_000;

function resolveRoot(env = process.env) {
  const configured = env.AGENT_BRIDGE_ROOT?.trim();
  if (!configured) return path.join(os.homedir(), "agent-bridge");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.resolve(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function resolvePort(value) {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("AGENT_ADMIN_PORT must be an integer from 0 to 65535.");
  }
  return parsed;
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function assertRegistry(registry) {
  if (typeof registry !== "object" || registry === null || Array.isArray(registry)) {
    throw new Error("agents.json must contain an object of agent definitions.");
  }
  for (const [name, config] of Object.entries(registry)) {
    if (!name || typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error(`Invalid agent configuration for ${name || "(empty name)"}.`);
    }
    if (typeof config.command !== "string" || config.command.trim() === "") {
      throw new Error(`Agent ${name} must have a non-empty command.`);
    }
    if (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string")) {
      throw new Error(`Agent ${name} args must be an array of strings.`);
    }
    if (config.input !== "stdin" && config.input !== "arg") {
      throw new Error(`Agent ${name} input must be stdin or arg.`);
    }
  }
  return registry;
}

function registryPaths(rootDir) {
  const filePath = path.join(rootDir, "agents.json");
  return { filePath, tempPath: path.join(rootDir, `.agents.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`) };
}

function readRegistry(rootDir, fileSystem) {
  const { filePath } = registryPaths(rootDir);
  if (!fileSystem.existsSync(filePath)) return {};
  const stat = fileSystem.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("agents.json must be a regular file, not a symlink or directory.");
  }
  return assertRegistry(JSON.parse(fileSystem.readFileSync(filePath, "utf8")));
}

function findCommand(command) {
  const executable = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(executable, [command], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 5_000,
  });
  const resolved = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
  return { available: Boolean(resolved), path: resolved || null };
}

function getPreset(name) {
  return PRESETS.find((preset) => preset.name === name);
}

function agentStatus(name, registry) {
  const preset = getPreset(name);
  const command = findCommand(preset.command);
  return {
    name,
    enabled: Object.hasOwn(registry, name),
    command: preset.command,
    executableAvailable: command.available,
    executablePath: command.path,
  };
}

function makePage(probeEnabled) {
  const probeNote = probeEnabled
    ? "已启用真实自检：点击按钮会运行本地 Codex，可能消耗额度。"
    : "默认自检只检查命令是否在 PATH 中，不启动 Codex、不消耗额度。";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>本地 Agent 启停</title>
<style>
body{font:15px system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#17202a;background:#f7f8fa}
h1{font-size:24px}.card{background:white;border:1px solid #dfe4ea;border-radius:12px;padding:18px;margin:14px 0}
.row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.name{font-weight:700;font-size:18px}.muted{color:#52606d;font-size:13px}
button{border:0;border-radius:7px;padding:9px 14px;background:#185abd;color:white;cursor:pointer}button:disabled{opacity:.55;cursor:wait}
.state{font-weight:600}.error{color:#a61b1b}.ok{color:#176b36}code{overflow-wrap:anywhere}
</style></head><body>
<h1>本地 Agent 启停</h1><p class="muted">仅管理脚本内的预设 Agent；配置直接写入本机 agents.json。</p>
<p id="probe-note" class="muted">${probeNote}</p><div id="agents"></div><p id="message" role="status" class="muted"></p>
<script>
const token=new URLSearchParams(location.search).get("token")||"";
const container=document.querySelector("#agents"),message=document.querySelector("#message");
async function load(){
  const response=await fetch("/api/agents?token="+encodeURIComponent(token));
  const data=await response.json();if(!response.ok)throw new Error(data.error||"读取状态失败");
  container.replaceChildren();
  for(const agent of data.agents){
    const card=document.createElement("section");card.className="card";
    const row=document.createElement("div");row.className="row";
    const name=document.createElement("span");name.className="name";name.textContent=agent.name;
    const state=document.createElement("span");state.className="state";state.textContent=agent.enabled?"已启用":"已停用";
    const toggle=document.createElement("button");toggle.textContent=agent.enabled?"停用":"启用";
    toggle.addEventListener("click",async()=>{toggle.disabled=true;await change(agent.name,!agent.enabled)});
    const check=document.createElement("button");check.textContent="自检";
    check.addEventListener("click",async()=>{check.disabled=true;await checkAgent(agent.name);check.disabled=false});
    row.append(name,state,toggle,check);
    const details=document.createElement("p");details.className="muted";
    details.textContent="命令："+agent.command+"；PATH："+(agent.executableAvailable?agent.executablePath:"未找到");
    card.append(row,details);container.append(card);
  }
}
async function change(name,enabled){
  try{const response=await fetch("/api/agents",{method:"POST",headers:{"Content-Type":"application/json","X-Admin-Token":token},body:JSON.stringify({name,enabled})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"写入失败");message.textContent=data.message;message.className="ok";await load();
  }catch(error){message.textContent=error.message;message.className="error";load();}
}
async function checkAgent(name){
  try{const response=await fetch("/api/check?name="+encodeURIComponent(name)+"&token="+encodeURIComponent(token));const data=await response.json();
    if(!response.ok)throw new Error(data.error||"自检失败");message.textContent=data.message;message.className=data.available?"ok":"error";
  }catch(error){message.textContent=error.message;message.className="error";}
}
load().catch(error=>{message.textContent=error.message;message.className="error"});
</script></body></html>`;
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

function writeRegistry(rootDir, registry, fileSystem) {
  const { filePath, tempPath } = registryPaths(rootDir);
  const existed = fileSystem.existsSync(filePath);
  let backupPath = null;
  if (existed) {
    const stat = fileSystem.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("agents.json must be a regular file, not a symlink or directory.");
    backupPath = `${filePath}.bak-${Date.now()}`;
  }

  let targetReplaced = false;
  try {
    if (backupPath) fileSystem.copyFileSync(filePath, backupPath);
    const serialized = `${JSON.stringify(assertRegistry(registry), null, 2)}\n`;
    fileSystem.writeFileSync(tempPath, serialized, { encoding: "utf8", flag: "wx" });
    assertRegistry(JSON.parse(fileSystem.readFileSync(tempPath, "utf8")));
    fileSystem.renameSync(tempPath, filePath);
    targetReplaced = true;
    assertRegistry(JSON.parse(fileSystem.readFileSync(filePath, "utf8")));
  } catch (error) {
    try {
      if (targetReplaced && backupPath && fileSystem.existsSync(backupPath)) fileSystem.copyFileSync(backupPath, filePath);
      else if (!existed && fileSystem.existsSync(filePath)) fileSystem.unlinkSync(filePath);
    } catch {}
    try {
      if (fileSystem.existsSync(tempPath)) fileSystem.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
  return backupPath;
}

function runProbe(name) {
  const preset = getPreset(name);
  const input = "Reply with exactly PONG. Do not read or modify files.\n";
  const args = [...preset.args];
  const options = { encoding: "utf8", shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 };
  const result = preset.input === "stdin"
    ? spawnSync(preset.command, args, { ...options, input })
    : spawnSync(preset.command, [...args, input.trim()], options);
  if (result.error) throw new Error(`Probe failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Probe exited with status ${result.status}.`);
  return { output: (result.stdout || "").trim().slice(0, 1000) };
}

export function createAgentAdminServer({ rootDir = resolveRoot(), port = resolvePort(process.env.AGENT_ADMIN_PORT), probeEnabled = false, fileSystem = fs } = {}) {
  const normalizedRoot = path.resolve(rootDir);
  const token = crypto.randomBytes(32).toString("hex");
  fileSystem.mkdirSync(normalizedRoot, { recursive: true });

  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    const host = String(req.headers.host || "").toLowerCase();
    const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    if (!allowedHosts.includes(host)) return sendJson(res, 403, { error: "Forbidden host." });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return sendJson(res, 403, { error: "Forbidden origin." });

    let url;
    try {
      url = new URL(req.url || "/", `http://${host}`);
    } catch {
      return sendJson(res, 400, { error: "Invalid request URL." });
    }

    if (req.method === "GET") {
      if (!safeTokenEqual(url.searchParams.get("token"), token)) return sendJson(res, 403, { error: "Invalid admin token." });
      if (url.pathname === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        return res.end(makePage(probeEnabled));
      }
      if (url.pathname === "/api/agents") {
        try {
          const registry = readRegistry(normalizedRoot, fileSystem);
          return sendJson(res, 200, { agents: PRESETS.map(({ name }) => agentStatus(name, registry)) });
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }
      if (url.pathname === "/api/check") {
        const name = url.searchParams.get("name");
        const preset = getPreset(name);
        if (!preset) return sendJson(res, 400, { error: "Agent is not in the preset list." });
        try {
          const status = findCommand(preset.command);
          if (probeEnabled && status.available) {
            const probe = runProbe(name);
            return sendJson(res, 200, { ...status, message: `真实自检通过：${probe.output || "（无标准输出）"}`, probe: true });
          }
          return sendJson(res, 200, {
            ...status,
            message: status.available ? `命令可用：${status.path}。未启动 Agent。` : `未在 PATH 中找到 ${preset.command}。`,
            probe: false,
          });
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }
      return sendJson(res, 404, { error: "Not found." });
    }

    if (req.method === "POST") {
      if (!safeTokenEqual(req.headers["x-admin-token"], token)) return sendJson(res, 403, { error: "Invalid admin token." });
      if (url.pathname !== "/api/agents") return sendJson(res, 404, { error: "Not found." });
      let body;
      try {
        body = await readRequestBody(req);
      } catch (error) {
        return sendJson(res, error.statusCode || 400, { error: error.message });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJson(res, 400, { error: "Request body must be an object." });
      if (Object.hasOwn(body, "command") || Object.hasOwn(body, "args")) {
        return sendJson(res, 400, { error: "command and args cannot be supplied by clients." });
      }
      const keys = Object.keys(body);
      if (keys.some((key) => key !== "name" && key !== "enabled")) return sendJson(res, 400, { error: "Only name and enabled are accepted." });
      const preset = getPreset(body.name);
      if (!preset) return sendJson(res, 400, { error: "Agent is not in the preset list." });
      if (typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean." });

      try {
        const registry = readRegistry(normalizedRoot, fileSystem);
        if (body.enabled) registry[body.name] = { command: preset.command, args: [...preset.args], input: preset.input };
        else delete registry[body.name];
        const backupPath = writeRegistry(normalizedRoot, registry, fileSystem);
        return sendJson(res, 200, { ok: true, enabled: body.enabled, backup: backupPath, message: body.enabled ? `${body.name} 已启用。` : `${body.name} 已停用。` });
      } catch (error) {
        return sendJson(res, 500, { error: `无法更新 agents.json：${error.message}` });
      }
    }

    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  });

  return { server, token };
}

export async function startAgentAdminServer(options = {}) {
  const { server, token } = createAgentAdminServer(options);
  const port = options.port ?? resolvePort(process.env.AGENT_ADMIN_PORT);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to determine the admin server address.");
  return { server, token, url: `http://127.0.0.1:${address.port}/?token=${token}` };
}

const isMainModule = process.argv[1] && path.basename(process.argv[1]) === "agent-admin.mjs";
if (isMainModule) {
  try {
    const probeEnabled = process.argv.includes("--probe");
    const running = await startAgentAdminServer({ probeEnabled });
    process.stdout.write(`Agent admin page: ${running.url}\n`);
    process.stdout.write(probeEnabled ? "Real Codex probe is enabled.\n" : "Self-check only checks PATH; Codex execution is disabled.\n");
    const shutdown = () => running.server.close(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    process.stderr.write(`Failed to start agent admin page: ${error.message}\n`);
    process.exitCode = 1;
  }
}
