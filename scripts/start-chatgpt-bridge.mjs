#!/usr/bin/env node
/**
 * One-click starter for Agent Bridge HTTP/SSE server + secure tunnel for ChatGPT.
 */
import { spawn } from "node:child_process";
import { startHttpServer } from "../dist/http-server.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 38080;
const HOST = "127.0.0.1";

async function main() {
  console.log("===============================================================");
  console.log("  🚀 启动 Agent Bridge ChatGPT 桥接服务");
  console.log("===============================================================\n");

  // 1. 启动本地 HTTP/SSE 服务
  console.log(`[1/2] 正在启动本地 MCP 服务 (http://${HOST}:${PORT}/mcp)...`);
  const httpHandle = await startHttpServer({ port: PORT, host: HOST });
  console.log(`✅ 本地 MCP 服务启动成功！`);

  // 2. 检查是否有 cloudflared，优先使用，否则使用 npx localtunnel
  console.log(`\n[2/2] 正在建立安全 HTTPS 隧道供 ChatGPT 云端访问...`);

  let tunnelProcess;
  let tunnelUrl = "";

  // 尝试检测 cloudflared
  const hasCloudflared = await new Promise((res) => {
    const p = spawn("which", ["cloudflared"]);
    p.on("close", (code) => res(code === 0));
  });

  if (hasCloudflared) {
    console.log("检测到已安装 cloudflared，正在启动 Cloudflare Quick Tunnel...");
    tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://${HOST}:${PORT}`]);

    const handleOutput = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        printBanner(tunnelUrl);
      }
    };

    tunnelProcess.stdout.on("data", handleOutput);
    tunnelProcess.stderr.on("data", handleOutput);
  } else {
    console.log("使用免安装临时安全隧道 (localtunnel)...");
    tunnelProcess = spawn("npx", ["--yes", "localtunnel", "--port", String(PORT)]);

    tunnelProcess.stdout.on("data", (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[^\s]+/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0].trim();
        printBanner(tunnelUrl);
      }
    });
  }

  function printBanner(url) {
    const mcpUrl = `${url.replace(/\/$/, "")}/mcp`;
    console.log("\n===============================================================");
    console.log("🎉 安全隧道创建成功！请在 ChatGPT 桌面版（或网页版）中完成一次性添加：");
    console.log("===============================================================");
    console.log(`\n1. 打开 ChatGPT ->「设置 (Settings)」-> 点击右上角「添加 (Add)」`);
    console.log(`2. 选择「添加自定义 MCP 服务器 (Add Custom MCP Server)」`);
    console.log(`3. 填写信息：`);
    console.log(`   - 名称 (Name):          Agent Bridge`);
    console.log(`   - 服务器 URL (URL):     \x1b[32m\x1b[1m${mcpUrl}\x1b[0m`);
    console.log(`   - 身份验证 (Auth):      \x1b[1m无 (None)\x1b[0m`);
    console.log(`4. 点击「创建 / 保存 (Save)」！\n`);
    console.log("---------------------------------------------------------------");
    console.log("💡 现在打开任何普通 ChatGPT 聊天窗口，直接对它说：");
    console.log(`   \x1b[36m"查一下这台 Mac 的硬件架构、内存与磁盘剩余空间"\x1b[0m`);
    console.log("---------------------------------------------------------------");
    console.log("按 Ctrl+C 即可随时退出并关闭通道。\n");
  }

  // 优雅退出处理
  const cleanup = async () => {
    console.log("\n正在关闭服务和安全隧道...");
    if (tunnelProcess) {
      tunnelProcess.kill();
    }
    await httpHandle.close();
    console.log("已安全退出。");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
