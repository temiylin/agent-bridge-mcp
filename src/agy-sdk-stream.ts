export interface AgySdkInitEvent {
  event: "init";
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgySdkToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  [key: string]: unknown;
}

export interface AgySdkSubagentInfo {
  conversation_id?: string;
  log_uri?: string;
  type_name?: string;
  role?: string;
  [key: string]: unknown;
}

export interface AgySdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface AgySdkStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: "ACTIVE" | "DONE" | "ERROR" | string;
  step_type?: string;
  text_delta?: string;
  thinking_delta?: string;
  tool_name?: string;
  tool_info?: AgySdkToolInfo;
  subagent_info?: AgySdkSubagentInfo;
  error_message?: string;
  duration_seconds?: number;
  usage?: AgySdkUsage;
  [key: string]: unknown;
}

export interface AgySdkStepUpdateEvent {
  event: "step_update";
  step_update?: AgySdkStepUpdate;
  [key: string]: unknown;
}

export interface AgySdkResultPayload {
  conversation_id?: string;
  status?: "SUCCESS" | "ERROR" | string;
  finished_reason?: "print_timeout" | "interrupted" | "error" | string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgySdkUsage;
  [key: string]: unknown;
}

export interface AgySdkResultEvent {
  event: "result";
  result?: AgySdkResultPayload;
  [key: string]: unknown;
}

export type AgySdkStreamEvent =
  | AgySdkInitEvent
  | AgySdkStepUpdateEvent
  | AgySdkResultEvent
  | { event?: string; [key: string]: unknown };

export interface AgySdkActivityUpdate {
  conversationId?: string;
  source: string;
  stepIndex?: number;
  stepType?: string;
  state?: string;
  errorMessage?: string;
}

export interface AgySdkStreamCallbacks {
  onActivity?: (update: AgySdkActivityUpdate) => void;
  onEvent?: (event: AgySdkStreamEvent, rawLine: string) => void;
}

/**
 * Fault-tolerant, stateful NDJSON parser for `agy --output-format stream-json`.
 * Only depends on empirically observed fields (`init.conversation_id`, `step_update`,
 * `result.status`/`finished_reason`/`response`/`error`) and gracefully tolerates
 * unknown events, schema changes, or plain-text fallback lines across agy upgrades.
 */
export class AgySdkStreamParser {
  private remainder = "";
  private conversationId: string | null = null;
  private textChunks: string[] = [];
  private finalResponse: string | null = null;
  private resultPayload: AgySdkResultPayload | null = null;
  private errorMessages: string[] = [];
  private totalEvents = 0;
  private lastActivitySource: string = "none";
  private loggedSteps = new Set<string>();
  private readonly callbacks: AgySdkStreamCallbacks;

  constructor(callbacks: AgySdkStreamCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Feed a raw stdout chunk into the parser.
   * Returns human-readable progress text suitable for appending to `.out` log and `stdoutData`.
   */
  feedChunk(chunk: string): string {
    this.remainder += chunk;
    const readableOut: string[] = [];

    let newlineIdx = this.remainder.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.remainder.slice(0, newlineIdx).trim();
      this.remainder = this.remainder.slice(newlineIdx + 1);
      if (line.length > 0) {
        const formatted = this.processLine(line);
        if (formatted) {
          readableOut.push(formatted);
        }
      }
      newlineIdx = this.remainder.indexOf("\n");
    }

    return readableOut.join("");
  }

  /**
   * Flush any trailing partial line when the process closes.
   */
  flush(): string {
    const line = this.remainder.trim();
    this.remainder = "";
    if (!line) return "";
    return this.processLine(line) || "";
  }

  private processLine(line: string): string {
    if (!line.startsWith("{")) {
      this.textChunks.push(`${line}\n`);
      return `${line}\n`;
    }

    let parsed: AgySdkStreamEvent;
    try {
      parsed = JSON.parse(line) as AgySdkStreamEvent;
    } catch {
      this.textChunks.push(`${line}\n`);
      return `${line}\n`;
    }

    if (!parsed || typeof parsed !== "object") {
      this.textChunks.push(`${line}\n`);
      return `${line}\n`;
    }

    // Extract top-level conversation_id if present on any event shape
    if (typeof parsed.conversation_id === "string" && parsed.conversation_id.trim()) {
      this.conversationId = parsed.conversation_id.trim();
    }

    if (typeof parsed.event !== "string") {
      // Unknown JSON object without `event`: tolerate and extract response/text/error if present
      if (typeof (parsed as any).response === "string") {
        const resp = (parsed as any).response as string;
        this.textChunks.push(resp);
        return resp;
      }
      if (typeof (parsed as any).error === "string") {
        const err = (parsed as any).error as string;
        this.errorMessages.push(err);
        return `[sdk:error] ${err}\n`;
      }
      return "";
    }

    this.totalEvents += 1;
    try {
      this.callbacks.onEvent?.(parsed, line);
    } catch {}

    if (parsed.event === "init") {
      const initEv = parsed as AgySdkInitEvent;
      if (typeof initEv.conversation_id === "string" && initEv.conversation_id.trim()) {
        this.conversationId = initEv.conversation_id.trim();
      }
      this.emitActivity({
        conversationId: this.conversationId ?? undefined,
        source: "sdk_init",
      });
      return "";
    }

    if (parsed.event === "step_update") {
      const su = (parsed as AgySdkStepUpdateEvent).step_update;
      if (!su || typeof su !== "object") {
        this.emitActivity({
          conversationId: this.conversationId ?? undefined,
          source: "sdk_step",
        });
        return "";
      }

      if (typeof su.conversation_id === "string" && su.conversation_id.trim()) {
        this.conversationId = su.conversation_id.trim();
      }

      if (typeof su.error_message === "string" && su.error_message.trim()) {
        this.errorMessages.push(su.error_message.trim());
      }

      const toolName =
        (typeof su.tool_info?.name === "string" && su.tool_info.name) ||
        (typeof su.tool_name === "string" && su.tool_name) ||
        undefined;
      let source = "sdk_step";
      if (toolName) {
        source = `sdk_tool:${toolName}`;
      } else if (typeof su.thinking_delta === "string" && su.thinking_delta.length > 0) {
        source = "sdk_thinking";
      } else if (typeof su.text_delta === "string" && su.text_delta.length > 0) {
        source = "sdk_response";
      } else if (su.step_type === "user_input") {
        source = "sdk_user_input";
      } else if (su.step_type === "agent_response") {
        source = "sdk_response";
      } else if (typeof su.step_type === "string" && su.step_type) {
        source = `sdk_${su.step_type}`;
      }

      this.emitActivity({
        conversationId: this.conversationId ?? undefined,
        source,
        stepIndex: typeof su.step_index === "number" ? su.step_index : undefined,
        stepType: typeof su.step_type === "string" ? su.step_type : undefined,
        state: typeof su.state === "string" ? su.state : undefined,
        errorMessage: typeof su.error_message === "string" ? su.error_message : undefined,
      });

      const outPieces: string[] = [];

      if (toolName && su.step_index !== undefined) {
        const stepKey = `${su.step_index}:${toolName}:${su.state || "ACTIVE"}`;
        if (!this.loggedSteps.has(stepKey) && (su.state === "ACTIVE" || su.state === "ERROR")) {
          this.loggedSteps.add(stepKey);
          outPieces.push(`[sdk:tool] ${toolName} (${su.state})\n`);
        }
      }

      if (typeof su.text_delta === "string" && su.text_delta.length > 0) {
        this.textChunks.push(su.text_delta);
        outPieces.push(su.text_delta);
      }

      if (typeof su.error_message === "string" && su.error_message.trim()) {
        outPieces.push(`\n[sdk:error] ${su.error_message.trim()}\n`);
      }

      return outPieces.join("");
    }

    if (parsed.event === "result") {
      const res = (parsed as AgySdkResultEvent).result;
      if (res && typeof res === "object") {
        this.resultPayload = res;
        if (typeof res.conversation_id === "string" && res.conversation_id.trim()) {
          this.conversationId = res.conversation_id.trim();
        }
        if (typeof res.response === "string" && res.response.length > 0) {
          this.finalResponse = res.response;
        }
        if (typeof res.error === "string" && res.error.trim()) {
          this.errorMessages.push(res.error.trim());
        }
        const isErr = res.status === "ERROR" || res.finished_reason === "error";
        this.emitActivity({
          conversationId: this.conversationId ?? undefined,
          source: isErr ? "sdk_error" : "sdk_result",
          state: typeof res.status === "string" ? res.status : undefined,
          errorMessage: typeof res.error === "string" ? res.error : undefined,
        });
        if (this.textChunks.length === 0 && typeof res.response === "string" && res.response.length > 0) {
          this.textChunks.push(res.response);
          return res.response;
        }
      }
      return "";
    }

    // Future/unknown event type (e.g., agy version upgrade): record activity without crashing
    this.emitActivity({
      conversationId: this.conversationId ?? undefined,
      source: `sdk_${parsed.event}`,
    });
    return "";
  }

  private emitActivity(update: AgySdkActivityUpdate) {
    this.lastActivitySource = update.source;
    try {
      this.callbacks.onActivity?.(update);
    } catch {}
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  getCleanOutput(): string {
    if (typeof this.finalResponse === "string" && this.finalResponse.trim().length > 0) {
      return this.finalResponse;
    }
    return this.textChunks.join("");
  }

  getResultPayload(): AgySdkResultPayload | null {
    return this.resultPayload;
  }

  getErrorMessages(): string[] {
    return [...this.errorMessages];
  }

  getLastActivitySource(): string {
    return this.lastActivitySource;
  }

  hasStructuredEvents(): boolean {
    return this.totalEvents > 0;
  }

  isQuotaError(): boolean {
    const combined = [
      ...this.errorMessages,
      this.resultPayload?.error || "",
      this.resultPayload?.finished_reason || "",
    ]
      .join("\n")
      .toLowerCase();
    return (
      combined.includes("quota") ||
      combined.includes("resource_exhausted") ||
      combined.includes("rate limit") ||
      combined.includes("429") ||
      combined.includes("exhausted your capacity")
    );
  }
}
