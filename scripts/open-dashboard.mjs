#!/usr/bin/env node
import { exec } from "node:child_process";

const port = process.env.AGENT_BRIDGE_PORT || process.env.PORT || 38080;
const url = `http://localhost:${port}`;

console.log(`\n===============================================================`);
console.log(`  🖥️ 正在打开 Agent Bridge 本机智能调度控制台...`);
console.log(`===============================================================`);
console.log(`URL: \x1b[36m\x1b[1m${url}\x1b[0m\n`);

const cmd = process.platform === "darwin"
  ? `open "${url}"`
  : process.platform === "win32"
  ? `start "${url}"`
  : `xdg-open "${url}"`;

exec(cmd, (err) => {
  if (err) {
    console.log(`请手动在浏览器中访问: ${url}`);
  }
});
