import fs from "node:fs";
import path from "node:path";

export interface AgentConfig {
  command: string;
  args: string[];
  input: "stdin" | "arg";
}

export type AgentRegistry = Record<string, AgentConfig>;

export function getAgentsFilePath(rootDir: string): string {
  return path.join(rootDir, "agents.json");
}

/**
 * Loads and validates agents.json from the specified root directory.
 * If agents.json does not exist or has invalid schema, throws an error.
 * Built-in default commands are strictly disallowed.
 */
export function loadAgentRegistry(rootDir: string): AgentRegistry {
  const agentsPath = getAgentsFilePath(rootDir);

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

    const { command, args, input } = config as Record<string, unknown>;

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
    };
  }

  return registry;
}
