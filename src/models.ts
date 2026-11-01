import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { loadAgents } from "./agents.js";
import { queryNativeCodexCatalog } from "./codex-catalog.js";
import { getAgentAccountQuota, AgentAccountQuota } from "./account-quota.js";

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  defaultReasoning?: string;
  supportedEfforts?: string[];
}

export interface AgentModelsReport {
  agent: string;
  command: string;
  installed: boolean;
  catalogSource?: string;
  currentDefault?: {
    model?: string;
    reasoningEffort?: string;
  };
  supportedReasoningEfforts: string[];
  /** Model send_task uses when no model is passed (agents.json default_model, else built-in default). */
  defaultModel?: string;
  models: (ModelInfo & { isDefault?: boolean })[];
  account?: AgentAccountQuota | null;
}

/** Built-in per-agent defaults; override with "default_model" in agents.json. */
export const BUILTIN_DEFAULT_MODELS: Record<string, string> = {
  agy: "gemini-3.8-flash-low",
  "agy-sdk": "gemini-3.8-flash-low",
};

/** Reads agents.json default_model for an agent (raw read: loadAgents drops unknown keys). */
export function getConfiguredDefaultModel(rootDir: string, agent: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, "agents.json"), "utf8"));
    const v = raw?.[agent]?.default_model;
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {}
  return BUILTIN_DEFAULT_MODELS[agent];
}

/** Agent command-line defaults override the desktop app's global configuration. */
export function readCodexAgentDefaults(args: string[]): { model?: string; reasoningEffort?: string } {
  const defaults: { model?: string; reasoningEffort?: string } = {};
  let explicitModel: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      const value = args[i + 1];
      if (value && !value.startsWith("-")) { explicitModel = value; i++; }
      continue;
    }
    if (arg.startsWith("--model=")) {
      explicitModel = arg.slice("--model=".length) || undefined;
      continue;
    }
    let override: string | undefined;
    if (arg === "-c" || arg === "--config") override = args[++i];
    else if (arg.startsWith("--config=")) override = arg.slice("--config=".length);
    else if (arg.startsWith("-c") && arg.length > 2) override = arg.slice(2);
    if (!override) continue;
    const match = override.match(/^(model|model_reasoning_effort)\s*=\s*(.+)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { continue; }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (typeof value !== "string" || !value) continue;
    if (match[1] === "model") defaults.model = value;
    else defaults.reasoningEffort = value;
  }
  if (explicitModel) defaults.model = explicitModel;
  return defaults;
}

/**
 * Parses ~/.codex/config.toml to find current default model and reasoning effort.
 */
function readCodexConfig(): { model?: string; reasoningEffort?: string } {
  try {
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
    if (!fs.existsSync(configPath)) return {};
    const content = fs.readFileSync(configPath, "utf8");

    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
    const effortMatch = content.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);

    return {
      model: modelMatch ? modelMatch[1] : undefined,
      reasoningEffort: effortMatch ? effortMatch[1] : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Discovers available Codex models from ~/.codex/models_cache.json or built-in fallback.
 */
function getCodexModels(): ModelInfo[] {
  try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (Array.isArray(data.models) && data.models.length > 0) {
        return data.models.map((m: any) => ({
          id: m.slug || m.id,
          name: m.display_name || m.slug || m.id,
          description: m.description || "",
          defaultReasoning: m.default_reasoning_level || "low",
          supportedEfforts: Array.isArray(m.supported_reasoning_levels)
            ? m.supported_reasoning_levels.map((lvl: any) => (typeof lvl === "string" ? lvl : lvl.effort))
            : ["low", "medium", "high", "xhigh", "max"],
        }));
      }
    }
  } catch {}

  // Fallback defaults for Codex
  return [
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1-Sol",
      description: "Latest workhorse model for coding and general software engineering.",
      defaultReasoning: "low",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "gpt-6-luna",
      name: "GPT-6-Luna",
      description: "High-intelligence reasoning model for complex architectural problems.",
      defaultReasoning: "medium",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "gpt-6-astra",
      name: "GPT-6-Astra",
      description: "Balanced speed and reasoning depth model.",
      defaultReasoning: "low",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "gpt-6.1-terra",
      name: "GPT-6.1-Terra",
      description: "High-throughput model optimized for rapid code generation.",
      defaultReasoning: "low",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "gpt-6-sol",
      name: "GPT-6-Sol",
      description: "Standard general-purpose reasoning model.",
      defaultReasoning: "medium",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "o3",
      name: "o3",
      description: "Advanced reasoning model for hard scientific and algorithmic challenges.",
      defaultReasoning: "medium",
      supportedEfforts: ["low", "medium", "high"],
    },
    {
      id: "o3-mini",
      name: "o3-mini",
      description: "Fast reasoning model optimized for coding math and science.",
      defaultReasoning: "medium",
      supportedEfforts: ["low", "medium", "high"],
    },
  ];
}

/**
 * Discovers available Antigravity (AGY) models.
 */
function getAgyModels(): ModelInfo[] {
  try {
    const raw = execSync("agy models", {
      encoding: "utf8",
      timeout: 2500,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = raw.split("\n").filter((l) => l.trim() && !l.includes("Fetching"));
    const models: ModelInfo[] = [];
    for (const line of lines) {
      const match = line.trim().match(/^([^\s]+)\s+(.+)$/);
      if (match) {
        models.push({
          id: match[1],
          name: match[2],
          supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        });
      }
    }
    if (models.length > 0) return models;
  } catch {}

  // Fallback defaults for AGY
  return [
    {
      id: "gemini-3.8-flash-high",
      name: "Gemini 3.8 Flash (High)",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "gemini-3.8-flash-medium",
      name: "Gemini 3.8 Flash (Medium)",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "gemini-3.8-flash-low",
      name: "Gemini 3.8 Flash (Low)",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6 (Thinking)",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-opus-4-6-thinking",
      name: "Claude Opus 4.6 (Thinking)",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "gpt-oss-120b-medium",
      name: "GPT-OSS 120B (Medium)",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
  ];
}

const reportCache = new Map<string, { at: number; value: AgentModelsReport }>();
const REPORT_TTL_MS = Number(process.env.AGENT_BRIDGE_MODELS_CACHE_MS || 10 * 60_000);

async function buildCodexReport(registry: Record<string, any>, lookup: string): Promise<AgentModelsReport> {
  const command = registry.codex ? registry.codex.command : "codex";
  const nativeCatalog = await queryNativeCodexCatalog(command);
  const codexModels = nativeCatalog?.models ?? getCodexModels();
  const codexConfig = {
    ...readCodexConfig(),
    ...readCodexAgentDefaults(registry.codex?.args || []),
  };
  let hasCodexBinary = Boolean(nativeCatalog);
  if (!hasCodexBinary) {
    const result = spawnSync(lookup, [command], {
      shell: false, windowsHide: true, stdio: "ignore", timeout: 2500,
    });
    hasCodexBinary = result.status === 0;
  }
  return {
    agent: "codex",
    command,
    installed: hasCodexBinary || "codex" in registry,
    catalogSource: nativeCatalog ? "native Codex CLI model/list" : "desktop cache or built-in fallback",
    currentDefault: {
      model: codexConfig.model || nativeCatalog?.defaultModel?.id,
      reasoningEffort: codexConfig.reasoningEffort || nativeCatalog?.defaultModel?.defaultReasoning,
    },
    supportedReasoningEfforts: [...new Set(codexModels.flatMap(model => model.supportedEfforts || []))],
    models: codexModels,
  };
}

function buildAgyReport(registry: Record<string, any>, lookup: string): AgentModelsReport {
  let hasAgyBinary = false;
  try {
    execSync(`${lookup} agy`, { stdio: "ignore" });
    hasAgyBinary = true;
  } catch {}
  return {
    agent: "agy",
    command: registry.agy ? registry.agy.command : "agy",
    installed: hasAgyBinary || "agy" in registry,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    models: getAgyModels(),
  };
}

/**
 * Model catalogs for registered agents (cached for AGENT_BRIDGE_MODELS_CACHE_MS, default 10 min).
 * Used by list_models and by send_task model validation.
 */
export async function getAgentModelReports(
  rootDir: string,
  targetAgent = "",
  opts: { fresh?: boolean } = {}
): Promise<Record<string, AgentModelsReport>> {
  let registry: Record<string, any> = {};
  try {
    registry = loadAgents(rootDir);
  } catch {}
  const target = targetAgent.trim().toLowerCase();
  const lookup = process.platform === "win32" ? "where" : "which";
  const reports: Record<string, AgentModelsReport> = {};
  const cached = async (name: string, build: () => Promise<AgentModelsReport> | AgentModelsReport) => {
    const key = `${rootDir}|${name}`;
    const hit = reportCache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < REPORT_TTL_MS) return hit.value;
    const value = await build();
    reportCache.set(key, { at: Date.now(), value });
    return value;
  };

  const jobs: Promise<void>[] = [];
  if (!target || target === "codex") jobs.push(cached("codex", () => buildCodexReport(registry, lookup)).then(r => { reports.codex = r; }));
  if (!target || target === "agy") jobs.push(cached("agy", () => buildAgyReport(registry, lookup)).then(r => { reports.agy = r; }));
  await Promise.all(jobs);

  for (const [name, config] of Object.entries(registry)) {
    if (name !== "codex" && name !== "agy" && (!target || target === name.toLowerCase())) {
      const isAgyVariant = name === "agy-sdk" || String(config?.command || "").includes("agy");
      reports[name] = {
        agent: name,
        command: config.command,
        installed: true,
        supportedReasoningEfforts: isAgyVariant ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"],
        models: isAgyVariant ? (reports.agy?.models ?? getAgyModels()) : [],
      };
    }
  }

  // Mark defaults (copy so the cache is not mutated).
  const ordered: Record<string, AgentModelsReport> = {};
  for (const name of Object.keys(reports).sort((a, b) => (a === "codex" ? -1 : b === "codex" ? 1 : a === "agy" ? -1 : b === "agy" ? 1 : a.localeCompare(b)))) {
    const r = reports[name];
    const def = getConfiguredDefaultModel(rootDir, name) || r.currentDefault?.model;
    ordered[name] = {
      ...r,
      ...(def ? { defaultModel: def } : {}),
      models: r.models.map(m => (def && m.id === def ? { ...m, isDefault: true } : m)),
    };
  }
  return ordered;
}

/** Valid model ids for an agent, or null when the agent has no catalog (custom agents). */
export async function getValidModelIds(rootDir: string, agent: string): Promise<string[] | null> {
  const reports = await getAgentModelReports(rootDir, agent);
  const r = reports[agent];
  if (!r || r.models.length === 0) return null;
  return r.models.map(m => m.id);
}

export function compactReport(r: AgentModelsReport): Record<string, unknown> {
  return {
    agent: r.agent,
    installed: r.installed,
    default_model: r.defaultModel,
    ...(r.currentDefault?.reasoningEffort ? { default_effort: r.currentDefault.reasoningEffort } : {}),
    models: r.models.map(m => m.id),
    efforts: r.supportedReasoningEfforts,
    ...(r.account !== undefined ? { account: r.account } : {}),
  };
}

/**
 * Registers the list_models tool.
 */
export function registerModelsTool(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  server.tool(
    "list_models",
    "List available AI models (default marked), supported reasoning efforts, and the current account quota (5h/weekly remaining) for codex and agy. Use agent= to filter and compact=true for a short id-only listing. Results are cached ~10 min; pass refresh=true to re-query.",
    {
      agent: z
        .string()
        .optional()
        .describe("Optional agent name to query (e.g., 'codex', 'agy'). If omitted, returns models for all registered agents."),
      compact: z.boolean().optional().describe("Return model ids only plus default, efforts and account quota (much smaller)."),
      include_quota: z.boolean().optional().describe("Include current account quota for codex/agy (default true)."),
      refresh: z.boolean().optional().describe("Bypass the model catalog / quota caches."),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ agent, compact, include_quota, refresh }) => {
      audit(rootDir, { tool: "list_models", agent: agent || undefined });

      try {
        const reports = await getAgentModelReports(rootDir, agent || "", { fresh: refresh === true });
        if (include_quota !== false) {
          await Promise.all(Object.values(reports).map(async r => {
            if (r.agent === "codex" || r.agent === "agy") {
              r.account = await getAgentAccountQuota(r.agent, {
                model: r.agent === "agy" ? r.defaultModel : undefined,
                command: r.command,
                fresh: refresh === true,
              });
            }
          }));
        }
        const out = compact
          ? Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, compactReport(r)]))
          : reports;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(out, null, compact ? 0 : 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`list_models error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving available models: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );
}
