// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const ENFORCE_SECTIONS = [
  "command_execution",
  "file_access_read",
  "file_access_write",
  "network_access",
  "mcp",
] as const

export type EnforceSection = (typeof ENFORCE_SECTIONS)[number]

export type TelemetrySection =
  | "post_shell_execution"
  | "post_write_file"
  | "post_network_access"
  | "post_mcp"
  | "before_submit_prompt"
  | "session_start"
  | "stop"
  | "stop_failure"
  | "model_token_usage"
  | "model_token_usage_subagent"
export type Section = EnforceSection | TelemetrySection

// Telemetry sections a builtin after-hook can produce. MCP and session-level are separate.
export type PostToolSection = Exclude<
  TelemetrySection,
  | "post_mcp"
  | "before_submit_prompt"
  | "session_start"
  | "stop"
  | "stop_failure"
  | "model_token_usage"
  | "model_token_usage_subagent"
>

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "StopFailure"
  | "SessionStart"
  | "Stop"
  | "TokenUsage"

export type PatchOp = "add" | "update" | "delete" | "move"

// Everything the plugin needs, derived from policies.json.
export interface AdapterConfig {
  readonly hooksPath: string
  // What this agent layout needs on the runner's environment, beyond the three below.
  readonly hookEnv: Readonly<Record<string, string>>
  readonly armorHome: string
  readonly settingsFile: string
  readonly telemetryEngine: string
  readonly specUname: string
  readonly policyEnabled: boolean
  readonly telemetryEnabled: boolean
  readonly timeoutMs: number
}

export interface PayloadAnnotations {
  readonly section: Section
  readonly scope?: "session" | "subagent"
  readonly opencode_tool?: string
  readonly patch_op?: PatchOp
  readonly patch_index?: number
  readonly patch_total?: number
  readonly patch_move_path?: string
  readonly mcp?: { readonly server: string; readonly tool: string }
}

interface BaseHookPayload {
  readonly payload_version: 1
  readonly client: "opencode"
  readonly hook_event_name: HookEventName
  readonly session_id: string
  readonly turn_id: string
  readonly cwd: string
  readonly armor1: PayloadAnnotations
}

export interface ToolHookPayload extends BaseHookPayload {
  readonly hook_event_name: "PreToolUse" | "PostToolUse"
  readonly call_id: string
  readonly tool_name: string
  readonly tool_input: Readonly<Record<string, unknown>>
  readonly tool_response?: unknown
}

export interface PromptHookPayload extends BaseHookPayload {
  readonly hook_event_name: "UserPromptSubmit"
  readonly prompt: string
}

export interface ErrorHookPayload extends BaseHookPayload {
  readonly hook_event_name: "StopFailure"
  readonly error: string
  readonly error_details: string
}

export interface SessionStartHookPayload extends BaseHookPayload {
  readonly hook_event_name: "SessionStart"
  readonly model: string
  readonly mode: string
  readonly agent: string
}

export interface StopHookPayload extends BaseHookPayload {
  readonly hook_event_name: "Stop"
  readonly status: string
}

export interface UsageHookPayload extends BaseHookPayload {
  readonly hook_event_name: "TokenUsage"
  readonly usage_record: string
  readonly agent_id?: string
}

export type HookPayload =
  | ToolHookPayload
  | PromptHookPayload
  | ErrorHookPayload
  | SessionStartHookPayload
  | StopHookPayload
  | UsageHookPayload

// ---------------------------------------------------------------------------
// Decisions and signals
// ---------------------------------------------------------------------------

export type Decision =
  // An allow may carry a note, appended to the tool result.
  | { readonly kind: "allow"; readonly context?: string }
  | { readonly kind: "deny"; readonly reason: string }
  // Carries the signal so callers need not infer it from the reason text.
  | { readonly kind: "degraded"; readonly signal: Signal; readonly reason: string }

export type Signal =
  | "config_missing"
  | "config_invalid"
  | "hook_spawn_failed"
  | "hook_timeout"
  | "hook_unparseable"
  | "hook_ask_downgraded"
  | "adapter_exception"
  | "mcp_ambiguous"
  | "patch_unparseable"

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface Counters {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
}

export interface UsageRow {
  readonly model: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}

export interface AssistantMessageLike {
  readonly id: string
  readonly sessionID: string
  readonly role?: string
  readonly modelID?: string
  readonly providerID?: string
  readonly cost?: number
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly reasoning?: number
    readonly cache?: { readonly read?: number; readonly write?: number }
  }
}

export interface UsageLedger {
  record(message: AssistantMessageLike): void
  flush(sessionID: string): UsageRow[]
  pendingSessions(): string[]
}
