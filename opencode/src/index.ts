import type {
  AdapterConfig,
  AssistantMessageLike,
  Counters,
  Decision,
  HookPayload,
  Section,
  Signal,
  UsageLedger,
  UsageRow,
} from "./types.ts"
import { classify, classifyAfter, build, buildAfter, buildAfterMcp, buildError, buildPrompt, buildSessionStart, buildStop, buildUsage, type BuildContext } from "./event.ts"
import { loadConfig, runHook } from "./hook.ts"
import { isRecord } from "./normalize.ts"

// ---------------------------------------------------------------------------
// Degradation signals
// ---------------------------------------------------------------------------
// Names which failure a catch site swallowed. Phase 3 emits these for real.
export interface SignalSink {
  record(signal: Signal): void
}

export function createSink(): SignalSink {
  return {
    record() {},
  }
}

// ---------------------------------------------------------------------------
// Token ledger
// ---------------------------------------------------------------------------

interface Entry {
  model: string
  current: Counters
  emitted: Counters
}

const ZERO: Counters = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

function countersOf(message: AssistantMessageLike): Counters {
  const tokens = message.tokens
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cache?.read ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0,
    cost: message.cost ?? 0,
  }
}

function delta(current: Counters, emitted: Counters): Counters {
  return {
    input: current.input - emitted.input,
    output: current.output - emitted.output,
    reasoning: current.reasoning - emitted.reasoning,
    cacheRead: current.cacheRead - emitted.cacheRead,
    cacheWrite: current.cacheWrite - emitted.cacheWrite,
    cost: current.cost - emitted.cost,
  }
}

function isEmpty(counters: Counters): boolean {
  return (
    counters.input === 0 &&
    counters.output === 0 &&
    counters.reasoning === 0 &&
    counters.cacheRead === 0 &&
    counters.cacheWrite === 0
  )
}

export function modelName(message: AssistantMessageLike): string {
  const provider = message.providerID ?? ""
  const model = message.modelID ?? ""
  if (provider === "") return model
  return `${provider}/${model}`
}

// Each update carries the message's running total, not a delta, and the same message
// updates many times. Emitting the difference is what stops double counting.
export function createLedger(): UsageLedger {
  const sessions = new Map<string, Map<string, Entry>>()

  return {
    record(message) {
      if (message.role !== undefined && message.role !== "assistant") return
      if (message.tokens === undefined) return

      let entries = sessions.get(message.sessionID)
      if (entries === undefined) {
        entries = new Map<string, Entry>()
        sessions.set(message.sessionID, entries)
      }

      const existing = entries.get(message.id)
      if (existing === undefined) {
        entries.set(message.id, { model: modelName(message), current: countersOf(message), emitted: ZERO })
        return
      }
      existing.current = countersOf(message)
      if (existing.model === "") existing.model = modelName(message)
    },

    flush(sessionID) {
      const entries = sessions.get(sessionID)
      if (entries === undefined) return []

      const byModel = new Map<string, Counters>()
      for (const entry of entries.values()) {
        const diff = delta(entry.current, entry.emitted)
        entry.emitted = entry.current
        if (isEmpty(diff)) continue

        const running = byModel.get(entry.model) ?? ZERO
        byModel.set(entry.model, {
          input: running.input + diff.input,
          output: running.output + diff.output,
          reasoning: running.reasoning + diff.reasoning,
          cacheRead: running.cacheRead + diff.cacheRead,
          cacheWrite: running.cacheWrite + diff.cacheWrite,
          cost: running.cost + diff.cost,
        })
      }

      return [...byModel.entries()].map(([model, counters]) => ({
        model,
        fast_mode: false,
        input_tokens: counters.input,
        output_tokens: counters.output,
        cache_read_input_tokens: counters.cacheRead,
        cache_creation_input_tokens: counters.cacheWrite,
        reasoning_tokens: counters.reasoning,
        cost: counters.cost,
      }))
    },

    pendingSessions() {
      return [...sessions.keys()]
    },
  }
}

interface ToolBeforeInput {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
}

interface ToolAfterInput extends ToolBeforeInput {
  readonly args?: Record<string, unknown>
}

// Builtin tools deliver { title, output, metadata }, MCP tools the raw CallToolResult.
// Mutable on purpose: OpenCode hands this same object back to the model.
type ToolAfterOutput = Record<string, unknown> | undefined

interface ToolOutput {
  args?: Record<string, unknown>
}

interface ChatMessageInput {
  readonly sessionID: string
  readonly messageID?: string
  readonly agent?: string
  readonly model?: { readonly providerID?: string; readonly modelID?: string }
}

interface ChatMessageOutput {
  readonly message?: {
    readonly id?: string
    readonly agent?: string
    readonly model?: { readonly providerID?: string; readonly modelID?: string }
  }
  readonly parts?: readonly { readonly type?: string; readonly text?: string }[]
}

interface PluginInput {
  readonly directory: string
}

interface BusEvent {
  readonly type: string
  readonly properties?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const Armor1Plugin = async ({ directory }: PluginInput) => {
  const signals = createSink()

  const loaded = loadConfig()
  let config: AdapterConfig | undefined
  if (loaded.kind === "ok") config = loaded.config
  // No OpenCode policy assigned is normal, not a failure, so it records nothing.
  else if (loaded.kind === "invalid") signals.record("config_invalid")
  else if (loaded.kind === "missing") signals.record("config_missing")

  let mcpServers: readonly string[] = []

  // Tool hooks carry no turn id, so the user message id is remembered per session and
  // stamped onto everything else in that turn.
  const turns = new Map<string, string>()
  const turnOf = (sessionID: string): string => turns.get(sessionID) ?? ""

  // Totals arrive on assistant messages, accumulated here and flushed each turn.
  const ledger = createLedger()
  const parents = new Map<string, string | undefined>()
  const started = new Set<string>()

  // A note from an allowed decision, held until the after hook, which is where the object
  // the model reads can still be appended to.
  const pendingContext = new Map<string, string[]>()

  const flushUsage = async (sessionID: string): Promise<void> => {
    const rows = ledger.flush(sessionID)
    if (rows.length === 0) return

    const parentID = parents.get(sessionID)
    const scope = parentID !== undefined && parentID !== "" ? "subagent" : "session"
    await send(
      scope === "subagent" ? "model_token_usage_subagent" : "model_token_usage",
      buildUsage(
        { sessionID, turnID: turnOf(sessionID), cwd: directory },
        scope,
        rows,
        scope === "subagent" ? sessionID : undefined,
      ),
    )
  }

  const context = (sessionID: string, tool: string, callID: string): BuildContext => ({
    tool,
    sessionID,
    turnID: turnOf(sessionID),
    callID,
    cwd: directory,
  })

  const send = async (section: Section, payload: HookPayload): Promise<Decision | undefined> => {
    if (config === undefined) return undefined
    const decision = await runHook(config, section, payload)
    if (decision.kind === "degraded") {
      signals.record(decision.signal)
    }
    return decision
  }

  // Never throws. A thrown error is indistinguishable from a policy denial to OpenCode,
  // so any failure here resolves to "no denial" and is recorded instead.
  const evaluate = async (input: ToolBeforeInput, output: ToolOutput): Promise<string | undefined> => {
    try {
      if (config === undefined) return undefined

      const classification = classify(input.tool, mcpServers)
      if (classification.kind === "none") return undefined

      const result = build(context(input.sessionID, input.tool, input.callID), classification, output.args ?? {})
      if (result === undefined) return undefined

      for (const signal of result.signals) signals.record(signal)

      for (const payload of result.payloads) {
        const decision = await send(result.section, payload)
        if (decision?.kind === "deny") return decision.reason
        if (decision?.kind === "allow" && decision.context !== undefined) {
          const existing = pendingContext.get(input.callID) ?? []
          existing.push(decision.context)
          pendingContext.set(input.callID, existing)
        }
      }
      return undefined
    } catch (error) {
      signals.record("adapter_exception")
      return undefined
    }
  }

  // A crash looks exactly like a policy denial to OpenCode, so no exception may escape.
  // Every hook body is wrapped.
  const guard = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      signals.record("adapter_exception")
    }
  }

  // Telemetry paths additionally do nothing when the adapter is disabled.
  const emit = (run: () => Promise<void>): Promise<void> =>
    guard("emit", async () => {
      if (config === undefined) return
      await run()
    })

  return {
    config: async (input?: { mcp?: Record<string, unknown> }): Promise<void> => {
      await guard("config", async () => {
        mcpServers = Object.keys(input?.mcp ?? {})
      })
    },

    "tool.execute.before": async (input: ToolBeforeInput, output: ToolOutput): Promise<void> => {
      const denial = await evaluate(input, output)
      // The only throw in the plugin.
      if (denial !== undefined) throw new Error(denial)
    },

    "tool.execute.after": async (input: ToolAfterInput, output: ToolAfterOutput): Promise<void> => {
      // Runs for every tool, before any telemetry, so a slow or failing hook cannot cost
      // the model its context. Tools with no telemetry section still get it.
      await guard("inject", async () => {
        const contexts = pendingContext.get(input.callID)
        pendingContext.delete(input.callID)
        if (contexts !== undefined && contexts.length > 0) appendContext(output, contexts)
      })

      await emit(async () => {
        const classification = classifyAfter(input.tool, mcpServers)
        if (classification.kind === "none") return

        const ctx = context(input.sessionID, input.tool, input.callID)
        const result =
          classification.kind === "mcp"
            ? buildAfterMcp(ctx, classification.resolution, input.args ?? {}, output)
            : buildAfter(ctx, classification.section, input.args ?? {})

        for (const signal of result.signals) signals.record(signal)
        for (const payload of result.payloads) await send(classification.section, payload)
      })
    },

    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput): Promise<void> => {
      await guard("chat.message", async () => {
      // input.messageID is optional and absent in `opencode run`; the user message
      // object always carries the id.
      const turnID = output.message?.id ?? input.messageID
      if (turnID !== undefined) turns.set(input.sessionID, turnID)

      // session.created fires earlier but carries no model or agent, so session_start is
      // emitted from the first prompt instead, where both are known.
      if (!started.has(input.sessionID)) {
        started.add(input.sessionID)
        await emit(async () => {
          // As with the message id, `opencode run` leaves these off the hook input but the
          // user message itself always carries them.
          const source = output.message?.model ?? input.model
          const provider = source?.providerID ?? ""
          const modelID = source?.modelID ?? ""
          const model = provider === "" ? modelID : `${provider}/${modelID}`
          await send(
            "session_start",
            buildSessionStart(
              { sessionID: input.sessionID, turnID: turnOf(input.sessionID), cwd: directory },
              model,
              output.message?.agent ?? input.agent ?? "",
            ),
          )
        })
      }

      await emit(async () => {
        const prompt = (output.parts ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
        if (prompt === "") return
        await send(
          "before_submit_prompt",
          buildPrompt({ sessionID: input.sessionID, turnID: turnOf(input.sessionID), cwd: directory }, prompt),
        )
      })
      })
    },

    dispose: async (): Promise<void> => {
      // Unlike the event hook, dispose is awaited during teardown, so it is the one
      // flush point that cannot be cut short by the process exiting.
      for (const sessionID of ledger.pendingSessions()) {
        await emit(() => flushUsage(sessionID))
      }
    },

    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      await guard("event", async () => {
      const properties = event?.properties ?? {}
      if (event?.type === undefined) return

      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties["info"]
        if (isRecord(info) && typeof info["id"] === "string") {
          const parentID = info["parentID"]
          parents.set(info["id"], typeof parentID === "string" ? parentID : undefined)
        }
        return
      }

      if (event.type === "message.updated") {
        const info = properties["info"]
        if (isRecord(info) && typeof info["id"] === "string" && typeof info["sessionID"] === "string") {
          ledger.record(info as unknown as AssistantMessageLike)
        }
        return
      }

      if (event.type === "session.idle") {
        const sessionID = typeof properties["sessionID"] === "string" ? properties["sessionID"] : ""
        if (sessionID === "") return
        await emit(async () => {
          await send(
            "stop",
            buildStop({ sessionID, turnID: turnOf(sessionID), cwd: directory }),
          )
        })
        await emit(() => flushUsage(sessionID))
        pendingContext.clear()
        return
      }

      if (event.type !== "session.error") return
      await emit(async () => {
        const sessionID = typeof properties["sessionID"] === "string" ? properties["sessionID"] : ""
        const raw = properties["error"]
        const error = isRecord(raw) && typeof raw["name"] === "string" ? raw["name"] : "UnknownError"
        await send(
          "stop_failure",
          buildError(
            { sessionID, turnID: turnOf(sessionID), cwd: directory },
            error,
            errorDetails(isRecord(raw) ? raw["data"] : undefined),
          ),
        )
      })
      })
    },
  }
}

function errorDetails(data: unknown): string {
  if (isRecord(data) && typeof data["message"] === "string") return data["message"]
  if (data === undefined) return ""
  try {
    return JSON.stringify(data)
  } catch {
    return ""
  }
}

// The after hook's output object is what OpenCode returns as the tool result. Builtin tools
// carry a string `output`; MCP tools carry the raw result with a `content` array.
function appendContext(output: ToolAfterOutput, contexts: readonly string[]): void {
  if (output === undefined) return
  const text = contexts.join("\n")

  if (typeof output["output"] === "string") {
    output["output"] = `${output["output"]}\n\n${text}`
    return
  }

  const content = output["content"]
  if (Array.isArray(content)) {
    content.push({ type: "text", text })
  }
}
