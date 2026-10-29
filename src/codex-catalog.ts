import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelInfo } from "./models.js";

export interface NativeCodexCatalog {
  models: ModelInfo[];
  defaultModel?: ModelInfo;
}

/** Read the registered CLI's catalog without creating a thread or running inference. */
export async function queryNativeCodexCatalog(
  command: string,
  launchArgs: string[] = ["app-server", "--stdio"]
): Promise<NativeCodexCatalog | null> {
  if (!path.isAbsolute(command)) return null;
  if (process.platform === "win32" && path.extname(command).toLowerCase() !== ".exe") return null;
  try {
    if (!fs.statSync(command).isFile()) return null;
  } catch {
    return null;
  }

  return new Promise(resolve => {
    const child = spawn(command, launchArgs, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const models = new Map<string, ModelInfo>();
    const seenCursors = new Set<string>();
    let defaultModel: ModelInfo | undefined;
    let finished = false;
    let expectedId = 1;
    let initialized = false;

    const finish = (catalog: NativeCodexCatalog | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      resolve(catalog);
    };
    const timer = setTimeout(() => finish(null), 10000);
    const requestModels = (cursor?: string) => {
      expectedId++;
      child.stdin.write(JSON.stringify({
        id: expectedId,
        method: "model/list",
        params: { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) },
      }) + "\n");
    };

    child.stderr.resume();
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdin.on("error", () => finish(null));
    lines.on("line", line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (finished || message.id !== expectedId) return;
      if (message.error) return finish(null);
      if (!initialized) {
        initialized = true;
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
        requestModels();
        return;
      }
      const page = message.result;
      if (!Array.isArray(page?.data)) return finish(null);
      for (const model of page.data) {
        if (!model || typeof model !== "object" || model.hidden === true) continue;
        const id = model.model || model.id;
        if (typeof id !== "string" || !id) continue;
        const info: ModelInfo = {
          id,
          name: typeof model.displayName === "string" ? model.displayName : typeof model.display_name === "string" ? model.display_name : id,
          description: typeof model.description === "string" ? model.description : "",
          defaultReasoning: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : undefined,
          supportedEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.map((effort: any) =>
              typeof effort === "string" ? effort : effort?.reasoningEffort
            ).filter((effort: unknown): effort is string => typeof effort === "string")
            : [],
        };
        models.set(id, info);
        if (model.isDefault) defaultModel = info;
      }
      if (typeof page.nextCursor === "string" && page.nextCursor) {
        if (seenCursors.has(page.nextCursor) || seenCursors.size >= 15) return finish(null);
        seenCursors.add(page.nextCursor);
        requestModels(page.nextCursor);
      } else {
        // A successful empty catalog is authoritative; do not replace it with
        // static fallback models that the installed CLI might no longer offer.
        finish({ models: [...models.values()], defaultModel });
      }
    });

    child.stdin.write(JSON.stringify({
      id: expectedId,
      method: "initialize",
      params: {
        clientInfo: { name: "agent_bridge_catalog", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    }) + "\n");
  });
}
