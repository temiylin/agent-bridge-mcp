import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { BridgeLogger } from "./logger.js";
import { loadAgents } from "./agents.js";

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
  currentDefault?: {
    model?: string;
    reasoningEffort?: string;
  };
  supportedReasoningEfforts: string[];
  models: ModelInfo[];
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
    "List available AI models, active defaults, and supported reasoning effort levels for local execution agents (e.g. Codex, Antigravity).",
    {
      agent: z
        .string()
        .optional()
        .describe("Optional agent name to query (e.g., 'codex', 'agy'). If omitted, returns models for all registered agents."),
    },
    async ({ agent }) => {
      audit(rootDir, { tool: "list_models", agent: agent || undefined });

      try {
        let registry: Record<string, any> = {};
        try {
          registry = loadAgents(rootDir);
        } catch {}

        const targetAgent = agent ? agent.trim().toLowerCase() : "";
        const reports: Record<string, AgentModelsReport> = {};

        // 1. Check Codex
        if (!targetAgent || targetAgent === "codex") {
          let hasCodexBinary = false;
          try {
            execSync("which codex", { stdio: "ignore" });
            hasCodexBinary = true;
          } catch {}

          const codexConfig = readCodexConfig();
          const codexModels = getCodexModels();

          reports.codex = {
            agent: "codex",
            command: registry.codex ? registry.codex.command : "codex",
            installed: hasCodexBinary || "codex" in registry,
            currentDefault: {
              model: codexConfig.model || "gpt-6.1-sol",
              reasoningEffort: codexConfig.reasoningEffort || "low",
            },
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            models: codexModels,
          };
        }

        // 2. Check Antigravity (AGY)
        if (!targetAgent || targetAgent === "agy") {
          let hasAgyBinary = false;
          try {
            execSync("which agy", { stdio: "ignore" });
            hasAgyBinary = true;
          } catch {}

          const agyModels = getAgyModels();

          reports.agy = {
            agent: "agy",
            command: registry.agy ? registry.agy.command : "agy",
            installed: hasAgyBinary || "agy" in registry,
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            models: agyModels,
          };
        }

        // 3. Check any custom agents registered in agents.json that are not codex/agy
        for (const [name, config] of Object.entries(registry)) {
          if (name !== "codex" && name !== "agy" && (!targetAgent || targetAgent === name.toLowerCase())) {
            reports[name] = {
              agent: name,
              command: config.command,
              installed: true,
              supportedReasoningEfforts: ["low", "medium", "high"],
              models: [],
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(reports, null, 2),
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
