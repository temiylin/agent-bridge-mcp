import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadAgents } from "./agents.js";
import { resolveBridgeRoot } from "./config.js";

export interface RoutingRule {
  id: string;
  scenario: string;
  keywords: string[];
  agent: string;
  description?: string;
}

export interface RoutingConfig {
  defaultAgent: string;
  instructions: string;
  rules: RoutingRule[];
}

export function getRoutingFilePath(rootDir: string = resolveBridgeRoot()): string {
  return path.join(rootDir, "routing.json");
}

export function getDefaultRoutingConfig(): RoutingConfig {
  return {
    defaultAgent: "codex",
    instructions: "涉及后端架构、服务端接口、数据库、系统脚本的开发任务走 codex；涉及前端界面、UI 组件、Vue/React、CSS 与页面展示的任务走 agy。",
    rules: [
      {
        id: "rule_backend",
        scenario: "后端及数据服务",
        keywords: ["后端", "backend", "api", "database", "数据库", "server", "服务", "node", "python", "go", "sql", "redis"],
        agent: "codex",
        description: "后端开发、接口与数据库任务优先由 Codex 处理",
      },
      {
        id: "rule_frontend",
        scenario: "前端与界面交互",
        keywords: ["前端", "frontend", "ui", "界面", "vue", "react", "css", "html", "web", "样式", "组件", "页面", "tailwind"],
        agent: "agy",
        description: "前端页面、UI 组件与可视化交互任务优先由 Antigravity (agy) 处理",
      },
      {
        id: "rule_testing",
        scenario: "测试与代码审查",
        keywords: ["测试", "test", "unittest", "review", "审查", "lint", "规范"],
        agent: "codex",
        description: "自动化测试与代码静态检查由 Codex 处理",
      },
    ],
  };
}

/**
 * Loads routing configuration from routing.json in rootDir.
 * If file does not exist, returns and writes the default configuration.
 */
export function loadRoutingConfig(rootDir: string = resolveBridgeRoot()): RoutingConfig {
  const filePath = getRoutingFilePath(rootDir);

  if (!fs.existsSync(filePath)) {
    const defaults = getDefaultRoutingConfig();
    try {
      if (!fs.existsSync(rootDir)) {
        fs.mkdirSync(rootDir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf8");
    } catch {}
    return defaults;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return getDefaultRoutingConfig();
    }

    const defaultAgent = typeof parsed.defaultAgent === "string" ? parsed.defaultAgent.trim() : "codex";
    const instructions = typeof parsed.instructions === "string" ? parsed.instructions : "";
    const rules: RoutingRule[] = Array.isArray(parsed.rules)
      ? parsed.rules
          .filter((r: any) => r && typeof r === "object")
          .map((r: any) => ({
            id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : `rule_${crypto.randomBytes(4).toString("hex")}`,
            scenario: typeof r.scenario === "string" ? r.scenario.trim() : "未命名场景",
            keywords: Array.isArray(r.keywords) ? r.keywords.map((k: any) => String(k).trim()).filter(Boolean) : [],
            agent: typeof r.agent === "string" ? r.agent.trim() : defaultAgent,
            description: typeof r.description === "string" ? r.description.trim() : "",
          }))
      : [];

    return { defaultAgent, instructions, rules };
  } catch {
    return getDefaultRoutingConfig();
  }
}

/**
 * Atomically writes routing configuration to routing.json in rootDir.
 */
export function saveRoutingConfig(rootDir: string, config: RoutingConfig): void {
  const filePath = getRoutingFilePath(rootDir);
  const tempPath = path.join(rootDir, `.routing.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);

  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  const payload: RoutingConfig = {
    defaultAgent: (config.defaultAgent || "codex").trim(),
    instructions: (config.instructions || "").trim(),
    rules: Array.isArray(config.rules)
      ? config.rules.map((r) => ({
          id: r.id || `rule_${crypto.randomBytes(4).toString("hex")}`,
          scenario: (r.scenario || "未命名场景").trim(),
          keywords: (r.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
          agent: (r.agent || config.defaultAgent || "codex").trim(),
          description: (r.description || "").trim(),
        }))
      : [],
  };

  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

export interface ResolvedAgentResult {
  agent: string;
  reason: string;
  scenario?: string;
}

/**
 * Resolves the target agent based on prompt content, requested agent, and routing rules.
 */
export function resolveTaskAgent(
  rootDir: string,
  prompt: string,
  requestedAgent?: string
): ResolvedAgentResult {
  let registry: Record<string, any> = {};
  try {
    registry = loadAgents(rootDir);
  } catch {}

  const availableAgents = Object.keys(registry);

  // 1. Explicitly requested agent
  if (requestedAgent && requestedAgent.trim() && requestedAgent.trim().toLowerCase() !== "auto") {
    const trimmed = requestedAgent.trim();
    if (trimmed in registry) {
      return { agent: trimmed, reason: "显式指定 (explicitly requested)" };
    }
    // If not in registry but requested, let caller validate or reject
    return { agent: trimmed, reason: "显式指定 (unregistered)" };
  }

  // 2. Load routing configuration
  const routing = loadRoutingConfig(rootDir);
  const promptLower = (prompt || "").toLowerCase();

  // 3. Match against rules (find rule with most keyword hits)
  let bestRule: RoutingRule | null = null;
  let highestScore = 0;

  for (const rule of routing.rules) {
    if (!rule.agent) continue;
    // Check if agent is valid in registry (if registry has agents)
    if (availableAgents.length > 0 && !availableAgents.includes(rule.agent)) {
      continue;
    }

    let score = 0;
    for (const kw of rule.keywords) {
      if (!kw) continue;
      if (promptLower.includes(kw.toLowerCase())) {
        score++;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestRule = rule;
    }
  }

  if (bestRule && highestScore > 0) {
    return {
      agent: bestRule.agent,
      scenario: bestRule.scenario,
      reason: `智能规则命中 [${bestRule.scenario}] (匹配 ${highestScore} 个关键词)`,
    };
  }

  // 4. Fallback to defaultAgent
  if (routing.defaultAgent && (availableAgents.length === 0 || availableAgents.includes(routing.defaultAgent))) {
    return {
      agent: routing.defaultAgent,
      reason: `默认 Agent (defaultAgent: ${routing.defaultAgent})`,
    };
  }

  // 5. Fallback to first available agent
  if (availableAgents.length > 0) {
    return {
      agent: availableAgents[0],
      reason: `首选可用 Agent (fallback: ${availableAgents[0]})`,
    };
  }

  return { agent: "codex", reason: "系统兜底 (codex)" };
}
