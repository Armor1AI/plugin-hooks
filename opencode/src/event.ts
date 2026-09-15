import type {
  EnforceSection,
  ErrorHookPayload,
  HookEventName,
  PayloadAnnotations,
  PostToolSection,
  PromptHookPayload,
  Section,
  SessionStartHookPayload,
  Signal,
  StopHookPayload,
  TelemetrySection,
  ToolHookPayload,
  UsageHookPayload,
  UsageRow,
} from "./types.ts"
import { type McpResolution, resolveMcpTool, scanPatch, toAbsolute } from "./normalize.ts"

// ---------------------------------------------------------------------------
// Routing a tool call to a policy section
// ---------------------------------------------------------------------------

const ENFORCE_BY_TOOL: Readonly<Record<string, EnforceSection>> = {
  bash: "command_execution",
  read: "file_access_read",
  write: "file_access_write",
  edit: "file_access_write",
  apply_patch: "file_access_write",
  webfetch: "network_access",
  websearch: "network_access",
}

// Reads have no post section. Nothing changed, so there is nothing to report after.
const TELEMETRY_BY_TOOL: Readonly<Record<string, PostToolSection>> = {
  bash: "post_shell_execution",
  write: "post_write_file",
  edit: "post_write_file",
  apply_patch: "post_write_file",
  webfetch: "post_network_access",
  websearch: "post_network_access",
}

export type Classification =
  | { readonly kind: "none" }
  | { readonly kind: "builtin"; readonly section: EnforceSection }
  | { readonly kind: "mcp"; readonly section: "mcp"; readonly resolution: McpResolution }

export function classify(toolId: string, mcpServers: readonly string[]): Classification {
  const builtin = ENFORCE_BY_TOOL[toolId]
  if (builtin !== undefined) return { kind: "builtin", section: builtin }

  const resolution = resolveMcpTool(toolId, mcpServers)
  if (resolution.kind === "none") return { kind: "none" }

  return { kind: "mcp", section: "mcp", resolution }
}

export type AfterClassification =
  | { readonly kind: "none" }
  | { readonly kind: "builtin"; readonly section: PostToolSection }
  | { readonly kind: "mcp"; readonly section: "post_mcp"; readonly resolution: McpResolution }

export function classifyAfter(toolId: string, mcpServers: readonly string[]): AfterClassification {
  const builtin = TELEMETRY_BY_TOOL[toolId]
  if (builtin !== undefined) return { kind: "builtin", section: builtin }

  const resolution = resolveMcpTool(toolId, mcpServers)
  if (resolution.kind === "none") return { kind: "none" }

  return { kind: "mcp", section: "post_mcp", resolution }
}

// ---------------------------------------------------------------------------
// Shaping the event
// ---------------------------------------------------------------------------

export interface BuildContext {
  readonly tool: string
  readonly sessionID: string
  readonly turnID: string
  readonly callID: string
  readonly cwd: string
}

// Prompt, session and usage events fire outside any tool call, so no tool or call id.
export type SessionContext = Omit<BuildContext, "tool" | "callID">

export interface BuildResult<S> {
  readonly section: S
  readonly payloads: readonly ToolHookPayload[]
  readonly signals: readonly Signal[]
}

function str(args: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}

// Accept every known spelling. If OpenCode renames an argument, file-write enforcement
// must not silently stop matching.
const FILE_PATH_KEYS = ["filePath", "file_path", "path", "file"] as const
const PATCH_KEYS = ["patchText", "patch", "diff"] as const
const COMMAND_KEYS = ["command", "cmd"] as const
const OLD_STRING_KEYS = ["oldString", "old_string"] as const
const NEW_STRING_KEYS = ["newString", "new_string"] as const
const URL_KEYS = ["url"] as const
const QUERY_KEYS = ["query", "q"] as const

// Generic so each builder keeps its exact event and section type.
function envelope<E extends HookEventName, S extends Section>(ctx: SessionContext, event: E, section: S) {
  return {
    payload_version: 1 as const,
    client: "opencode" as const,
    hook_event_name: event,
    session_id: ctx.sessionID,
    turn_id: ctx.turnID,
    cwd: ctx.cwd,
    armor1: { section },
  }
}

function toolPayload(
  ctx: BuildContext,
  event: "PreToolUse" | "PostToolUse",
  input: Readonly<Record<string, unknown>>,
  armor1: PayloadAnnotations,
  response?: unknown,
): ToolHookPayload {
  return {
    payload_version: 1,
    client: "opencode",
    hook_event_name: event,
    session_id: ctx.sessionID,
    turn_id: ctx.turnID,
    call_id: ctx.callID,
    cwd: ctx.cwd,
    tool_name: ctx.tool,
    tool_input: input,
    ...(response !== undefined ? { tool_response: response } : {}),
    armor1,
  }
}

// The call arguments go in tool_input directly, because the policy counts their keys and
// bytes. The full tool id stays at the top level.
function mcpAnnotations(ctx: BuildContext, section: "mcp" | "post_mcp", resolution: McpResolution): PayloadAnnotations {
  return {
    section,
    opencode_tool: ctx.tool,
    ...(resolution.kind === "match"
      ? { mcp: { server: resolution.server, tool: resolution.tool } }
      : {}),
  }
}

// One list of paths a write touches, so the before and after sections always agree.
function writeTargets(
  ctx: BuildContext,
  section: EnforceSection | TelemetrySection,
  args: Readonly<Record<string, unknown>>,
): { inputs: Record<string, unknown>[]; annotations: PayloadAnnotations[]; signals: Signal[] } {
  if (ctx.tool !== "apply_patch") {
    const filePath = str(args, ...FILE_PATH_KEYS)
    if (filePath === undefined) return { inputs: [], annotations: [], signals: [] }

    const input: Record<string, unknown> = { file_path: toAbsolute(filePath, ctx.cwd) }
    const content = str(args, "content")
    const oldString = str(args, ...OLD_STRING_KEYS)
    const newString = str(args, ...NEW_STRING_KEYS)
    if (content !== undefined) input["content"] = content
    if (oldString !== undefined) input["old_string"] = oldString
    if (newString !== undefined) input["new_string"] = newString

    return { inputs: [input], annotations: [{ section, opencode_tool: ctx.tool }], signals: [] }
  }

  // apply_patch has no file path argument: every target is inside the patch text. It is
  // also the only write tool on GPT-class models, so missing this means no coverage there.
  const scan = scanPatch(str(args, ...PATCH_KEYS) ?? "")
  const inputs: Record<string, unknown>[] = []
  const annotations: PayloadAnnotations[] = []

  const flat: { path: string; op: PayloadAnnotations["patch_op"]; movePath?: string }[] = []
  for (const target of scan.targets) {
    flat.push({ path: target.path, op: target.op })
    if (target.movePath !== undefined) {
      flat.push({ path: target.movePath, op: target.op, movePath: target.movePath })
    }
  }

  flat.forEach((entry, index) => {
    inputs.push({ file_path: toAbsolute(entry.path, ctx.cwd) })
    annotations.push({
      section,
      opencode_tool: ctx.tool,
      ...(entry.op !== undefined ? { patch_op: entry.op } : {}),
      patch_index: index,
      patch_total: flat.length,
      ...(entry.movePath !== undefined
        ? { patch_move_path: toAbsolute(entry.movePath, ctx.cwd) }
        : {}),
    })
  })

  return { inputs, annotations, signals: scan.wellFormed ? [] : ["patch_unparseable"] }
}

function networkInput(
  ctx: BuildContext,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const url = str(args, ...URL_KEYS)
  return url !== undefined ? { url } : { query: str(args, ...QUERY_KEYS) ?? "" }
}

export function build(
  ctx: BuildContext,
  classification: Classification,
  args: Readonly<Record<string, unknown>>,
): BuildResult<EnforceSection> | undefined {
  if (classification.kind === "none") return undefined

  if (classification.kind === "mcp") {
    const resolution = classification.resolution
    return {
      section: "mcp",
      payloads: [toolPayload(ctx, "PreToolUse", args, mcpAnnotations(ctx, "mcp", resolution))],
      signals: resolution.kind === "ambiguous" ? ["mcp_ambiguous"] : [],
    }
  }

  const section = classification.section

  if (section === "command_execution") {
    return {
      section,
      payloads: [
        toolPayload(ctx, "PreToolUse", { command: str(args, ...COMMAND_KEYS) ?? "" }, {
          section,
          opencode_tool: ctx.tool,
        }),
      ],
      signals: [],
    }
  }

  if (section === "network_access") {
    return {
      section,
      payloads: [
        toolPayload(ctx, "PreToolUse", networkInput(ctx, args), { section, opencode_tool: ctx.tool }),
      ],
      signals: [],
    }
  }

  if (section === "file_access_read") {
    const filePath = str(args, ...FILE_PATH_KEYS)
    if (filePath === undefined) return { section, payloads: [], signals: [] }
    return {
      section,
      payloads: [
        toolPayload(ctx, "PreToolUse", { file_path: toAbsolute(filePath, ctx.cwd) }, {
          section,
          opencode_tool: ctx.tool,
        }),
      ],
      signals: [],
    }
  }

  const targets = writeTargets(ctx, section, args)
  return {
    section,
    payloads: targets.inputs.map((input, index) =>
      toolPayload(ctx, "PreToolUse", input, targets.annotations[index]!),
    ),
    signals: targets.signals,
  }
}

export function buildAfterMcp(
  ctx: BuildContext,
  resolution: McpResolution,
  args: Readonly<Record<string, unknown>>,
  response: unknown,
): BuildResult<"post_mcp"> {
  return {
    section: "post_mcp",
    payloads: [toolPayload(ctx, "PostToolUse", args, mcpAnnotations(ctx, "post_mcp", resolution), response ?? "")],
    signals: resolution.kind === "ambiguous" ? ["mcp_ambiguous"] : [],
  }
}

export function buildAfter(
  ctx: BuildContext,
  section: PostToolSection,
  args: Readonly<Record<string, unknown>>,
): BuildResult<TelemetrySection> {
  if (section === "post_shell_execution") {
    return {
      section,
      payloads: [
        toolPayload(ctx, "PostToolUse", { command: str(args, ...COMMAND_KEYS) ?? "" }, {
          section,
          opencode_tool: ctx.tool,
        }),
      ],
      signals: [],
    }
  }

  if (section === "post_network_access") {
    return {
      section,
      payloads: [
        toolPayload(ctx, "PostToolUse", networkInput(ctx, args), { section, opencode_tool: ctx.tool }),
      ],
      signals: [],
    }
  }

  const targets = writeTargets(ctx, section, args)
  return {
    section,
    payloads: targets.inputs.map((input, index) =>
      toolPayload(ctx, "PostToolUse", input, targets.annotations[index]!),
    ),
    signals: targets.signals,
  }
}

export function buildPrompt(
  ctx: SessionContext,
  prompt: string,
): PromptHookPayload {
  return {
    ...envelope(ctx, "UserPromptSubmit", "before_submit_prompt"),
    prompt,
  }
}

export function buildError(
  ctx: SessionContext,
  error: string,
  details: string,
): ErrorHookPayload {
  return {
    ...envelope(ctx, "StopFailure", "stop_failure"),
    error,
    error_details: details,
  }
}

export function buildUsage(
  ctx: SessionContext,
  scope: "session" | "subagent",
  rows: readonly UsageRow[],
  agentID?: string,
): UsageHookPayload {
  const section = scope === "subagent" ? "model_token_usage_subagent" : "model_token_usage"
  return {
    ...envelope(ctx, "TokenUsage", section),
    model_usage: rows,
    ...(agentID !== undefined ? { agent_id: agentID } : {}),
    armor1: { section, scope },
  }
}

export function buildSessionStart(
  ctx: SessionContext,
  model: string,
  agent: string,
): SessionStartHookPayload {
  return {
    ...envelope(ctx, "SessionStart", "session_start"),
    model,
    // OpenCode cannot tell a fresh start from a resume, so mode is always empty.
    mode: "",
    agent,
  }
}

export function buildStop(ctx: SessionContext): StopHookPayload {
  return {
    ...envelope(ctx, "Stop", "stop"),
    // Always "completed". A failed turn is reported by stop_failure, not by this field.
    status: "completed",
  }
}
