import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface AgentConfig {
  command: string;
  args: string[];
  input: "stdin" | "arg";
  capabilities?: {
    effort_models?: string[];
    supports_effort?: boolean;
    [key: string]: any;
  };
  models?: Record<string, { supports_effort?: boolean; [key: string]: any }>;
}

export type AgentRegistry = Record<string, AgentConfig>;

export function getAgentsFilePath(root: string): string {
  return path.join(root, "agents.json");
}

/**
 * Loads and validates agents.json from the specified root directory.
 * Always reads from disk on every invocation so modifications take effect immediately.
 * Throws descriptive errors if file is missing, invalid JSON, or schema is violated.
 */
export function loadAgents(root: string): AgentRegistry {
  const agentsPath = getAgentsFilePath(root);

  if (!fs.existsSync(agentsPath)) {
    throw new Error(`Agent registry not found at "${agentsPath}". You must create agents.json to register available agents.`);
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(agentsPath, "utf8");
  } catch (err: any) {
    throw new Error(`Failed to read agents.json at "${agentsPath}": ${err?.message || String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err: any) {
    throw new Error(`Failed to parse agents.json at "${agentsPath}": Invalid JSON (${err?.message || String(err)})`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid agents.json format at "${agentsPath}": Root must be an object of agent definitions.`);
  }

  const registry: AgentRegistry = {};
  for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error(`Invalid configuration for agent "${name}": Entry must be an object.`);
    }

    const { command, args, input, capabilities, models } = config as Record<string, unknown>;

    if (typeof command !== "string" || command.trim() === "") {
      throw new Error(`Invalid configuration for agent "${name}": "command" must be a non-empty string.`);
    }

    if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
      throw new Error(`Invalid configuration for agent "${name}": "args" must be an array of strings.`);
    }

    if (input !== "stdin" && input !== "arg") {
      throw new Error(`Invalid configuration for agent "${name}": "input" must be either "stdin" or "arg".`);
    }

    registry[name] = {
      command: command.trim(),
      args: [...args],
      input,
      ...(capabilities && typeof capabilities === "object" ? { capabilities: capabilities as any } : {}),
      ...(models && typeof models === "object" ? { models: models as any } : {}),
    };
  }

  return registry;
}

/**
 * Retrieves a specific agent configuration by name from agents.json.
 * Always reads from disk on every call.
 * Throws an error if agent is not found or registry is invalid.
 */
export function getAgent(root: string, name: string): AgentConfig {
  const registry = loadAgents(root);
  if (!(name in registry)) {
    const available = Object.keys(registry).join(", ") || "(none)";
    throw new Error(`Agent "${name}" not found in agents.json. Available agents: [${available}]`);
  }
  return registry[name];
}

/**
 * Helper to determine if an agent or specific model supports reasoning effort.
 */
export function agentSupportsEffort(agentConfig: AgentConfig, model?: string): boolean {
  if (model && agentConfig.models && agentConfig.models[model]) {
    if (typeof agentConfig.models[model].supports_effort === "boolean") {
      return agentConfig.models[model].supports_effort!;
    }
  }

  if (agentConfig.capabilities) {
    if (Array.isArray(agentConfig.capabilities.effort_models) && model) {
      return agentConfig.capabilities.effort_models.includes(model);
    }
    if (typeof agentConfig.capabilities.supports_effort === "boolean") {
      return agentConfig.capabilities.supports_effort;
    }
  }

  // Codex natively supports reasoning effort (by command name or agent name)
  if (agentConfig.command.includes("codex")) {
    return true;
  }

  return false;
}

// Alias for compatibility
export const loadAgentRegistry = loadAgents;

/**
 * Atomically writes agents.json to disk.
 */
export function saveAgents(root: string, registry: AgentRegistry): void {
  const filePath = getAgentsFilePath(root);
  const tempPath = path.join(root, `.agents.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, filePath);
}

