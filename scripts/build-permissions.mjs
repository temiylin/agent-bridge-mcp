import { chmodSync } from "node:fs";

if (process.platform !== "win32") {
  for (const file of ["dist/index.js", "dist/worker.js"]) chmodSync(file, 0o755);
}
