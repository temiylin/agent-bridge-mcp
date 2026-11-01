export const MAX_SDK_BUFFER_BYTES = 1024 * 1024; // 1MB cap

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
  immediate?: boolean;
}

export interface AgySdkStreamCallbacks {
  onActivity?: (update: AgySdkActivityUpdate) => void;
  /**
   * Called with a sanitized/compact JSON line suitable for `events.jsonl`
   * (omits high-frequency `text_delta` / `thinking_delta` chunks).
   */
  onEvent?: (event: AgySdkStreamEvent, compactLine: string) => void;
}

/**
 * Keeps only the last `maxBytes` characters/bytes of a string.
 */
export function capTailString(str: string, maxBytes: number = MAX_SDK_BUFFER_BYTES): string {
  if (str.length <= maxBytes) return str;
  return str.slice(str.length - maxBytes);
}

/**
 * Strict quota exhaustion matcher for structured SDK / stream-json output:
 * - Recognizes explicit `RESOURCE_EXHAUSTED`
 * - Recognizes explicit quota exhaustion phrases (`quota exhausted`, `quota exceeded`,
 *   `individual quota reached`, `exhausted your capacity`, `out of quota`, `insufficient_quota`)
 * - Recognizes `exitCode === 3` ONLY when paired with non-empty quota-related wording
 * - Deliberately excludes bare `"429"` numbers and generic `"rate limit"` / `"too many requests"`
 *   so transient rate limits or unrelated numbers never pause an account.
 */
export function isStrictAgyQuotaError(exitCode: number | null | undefined, text: string): boolean {
  const clean = (text || "").trim();
  if (!clean) return false;

  const explicitQuotaPatterns = [
    /\bRESOURCE_EXHAUSTED\b/i,
    /\bquota\s+(?:exhausted|exceeded|reached)\b/i,
    /\bindividual\s+quota\s+reached\b/i,
    /\bexhausted\s+your\s+(?:capacity|quota|daily\s+quota)\b/i,
    /\bout\s+of\s+quota\b/i,
    /\bexceeded\s+your\s+current\s+quota\b/i,
    /\binsufficient_quota\b/i,
  ];

  if (explicitQuotaPatterns.some((pat) => pat.test(clean))) {
    return true;
  }

  if (exitCode === 3 && /\bquota\b/i.test(clean)) {
    return true;
  }

  return false;
}

/**
 * Fault-tolerant, stateful NDJSON parser for `agy --output-format stream-json`.
 * - Binds `conversationId` strictly from the `init` event.
 * - Caps `remainder` and accumulated text at 1MB (`MAX_SDK_BUFFER_BYTES`).
 * - Strips `text_delta` and `thinking_delta` from `events.jsonl` logging.
 */
export class AgySdkStreamParser {
  private remainder = "";
  private conversationId: string | null = null;
  private textBuffer = "";
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

  private appendTextBuffer(chunk: string): void {
    if (!chunk) return;
    this.textBuffer = capTailString(this.textBuffer + chunk, MAX_SDK_BUFFER_BYTES);
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

    // Drop remainder if a single unterminated line exceeds 1MB
    if (this.remainder.length > MAX_SDK_BUFFER_BYTES) {
      this.remainder = "";
    }

    return readableOut.join("");
  }

  /**
   * Flush any trailing partial line when the process closes.
   */
  flush(): string {
    if (this.remainder.length > MAX_SDK_BUFFER_BYTES) {
      this.remainder = "";
      return "";
    }
    const line = this.remainder.trim();
    this.remainder = "";
    if (!line) return "";
    return this.processLine(line) || "";
  }

  private emitSanitizedEvent(parsed: AgySdkStreamEvent): void {
    if (!this.callbacks.onEvent) return;
    try {
      if (parsed.event === "step_update") {
        const su = (parsed as AgySdkStepUpdateEvent).step_update;
        if (!su || typeof su !== "object") return;
        const hasTool = Boolean(su.tool_info?.name || su.tool_name);
        const hasError = Boolean(su.error_message);
        const isTerminalStepState = su.state === "DONE" || su.state === "ERROR";
        // Skip pure token-streaming delta frames (`text_delta` / `thinking_delta`) to keep events.jsonl small
        if (!hasTool && !hasError && !isTerminalStepState && (su.text_delta || su.thinking_delta)) {
          return;
        }
        const cloneSu: Record<string, unknown> = { ...su };
        delete cloneSu.text_delta;
        delete cloneSu.thinking_delta;
        if (cloneSu.tool_info && typeof cloneSu.tool_info === "object") {
          const ti = { ...(cloneSu.tool_info as Record<string, unknown>) };
          if (typeof ti.output === "string" && ti.output.length > 512) {
            ti.output = `${ti.output.slice(0, 512)}...[truncated]`;
          }
          cloneSu.tool_info = ti;
        }
        const compact = JSON.stringify({ event: "step_update", step_update: cloneSu });
        this.callbacks.onEvent(parsed, compact);
        return;
      }

      if (parsed.event === "result") {
        const res = (parsed as AgySdkResultEvent).result;
        if (res && typeof res === "object") {
          const cloneRes: Record<string, unknown> = { ...res };
          if (typeof cloneRes.response === "string" && cloneRes.response.length > 1024) {
            cloneRes.response = `${cloneRes.response.slice(0, 1024)}...[truncated]`;
          }
          this.callbacks.onEvent(parsed, JSON.stringify({ event: "result", result: cloneRes }));
          return;
        }
      }

      const raw = JSON.stringify(parsed);
      this.callbacks.onEvent(parsed, raw.length > 4096 ? `${raw.slice(0, 4096)}...` : raw);
    } catch {}
  }

  private processLine(line: string): string {
    if (!line.startsWith("{")) {
      this.appendTextBuffer(`${line}\n`);
      return `${line}\n`;
    }

    let parsed: AgySdkStreamEvent;
    try {
      parsed = JSON.parse(line) as AgySdkStreamEvent;
    } catch {
      this.appendTextBuffer(`${line}\n`);
      return `${line}\n`;
    }

    if (!parsed || typeof parsed !== "object") {
      this.appendTextBuffer(`${line}\n`);
      return `${line}\n`;
    }

    if (typeof parsed.event !== "string") {
      if (typeof (parsed as any).response === "string") {
        const resp = (parsed as any).response as string;
        this.appendTextBuffer(resp);
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
    this.emitSanitizedEvent(parsed);

    if (parsed.event === "init") {
      const initEv = parsed as AgySdkInitEvent;
      // Only bind conversationId from the `init` event
      if (typeof initEv.conversation_id === "string" && initEv.conversation_id.trim()) {
        this.conversationId = initEv.conversation_id.trim();
      }
      this.emitActivity({
        conversationId: this.conversationId ?? undefined,
        source: "sdk_init",
        immediate: true,
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

      const isToolOrError = Boolean(toolName || su.error_message || su.state === "ERROR");
      this.emitActivity({
        conversationId: this.conversationId ?? undefined,
        source,
        stepIndex: typeof su.step_index === "number" ? su.step_index : undefined,
        stepType: typeof su.step_type === "string" ? su.step_type : undefined,
        state: typeof su.state === "string" ? su.state : undefined,
        errorMessage: typeof su.error_message === "string" ? su.error_message : undefined,
        immediate: isToolOrError,
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
        this.appendTextBuffer(su.text_delta);
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
        if (typeof res.response === "string" && res.response.length > 0) {
          this.finalResponse = capTailString(res.response, MAX_SDK_BUFFER_BYTES);
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
          immediate: true,
        });
        if (!this.textBuffer && typeof res.response === "string" && res.response.length > 0) {
          const capped = capTailString(res.response, MAX_SDK_BUFFER_BYTES);
          this.appendTextBuffer(capped);
          return capped;
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
    return this.textBuffer;
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

  isQuotaError(exitCode?: number | null, extraStderr?: string): boolean {
    const combined = [
      ...this.errorMessages,
      this.resultPayload?.error || "",
      extraStderr || "",
    ].join("\n");
    return isStrictAgyQuotaError(exitCode, combined);
  }
}
