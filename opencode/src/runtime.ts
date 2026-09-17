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
import { build, classify, type BuildContext, type ToolTables } from "./event.ts"
import { loadConfig, runHook } from "./hook.ts"
import { isRecord } from "./normalize.ts"

// ---------------------------------------------------------------------------
// Degradation signals
// ---------------------------------------------------------------------------
// Names which failure a catch site swallowed.
export interface SignalSink {
  record(signal: Signal): void
}

export function createSink(): SignalSink {
  return {
    record() {},
  }
}

export function errorDetails(data: unknown): string {
  if (isRecord(data) && typeof data["message"] === "string") return data["message"]
  if (data === undefined) return ""
  try {
    return JSON.stringify(data)
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// The version-agnostic core
// ---------------------------------------------------------------------------
// In Armor1 terms; shared by both adapters, which differ only in how a call arrives.

export interface Runtime {
  readonly signals: SignalSink
  readonly directory: string
  readonly enabled: boolean
  // The after hooks classify MCP tools too, so they need the same list evaluate uses.
  readonly mcpServers: readonly string[]
  setMcpServers(names: readonly string[]): void
  send(section: Section, payload: HookPayload): Promise<Decision | undefined>
  evaluate(ctx: BuildContext, args: Record<string, unknown>, tools: ToolTables): Promise<string | undefined>
  takeContext(callID: string): readonly string[] | undefined
  clearContext(): void
  guard(label: string, run: () => Promise<void>): Promise<void>
  emit(run: () => Promise<void>): Promise<void>
}

export function createRuntime(directory: string): Runtime {
  const signals = createSink()

  const loaded = loadConfig()
  let config: AdapterConfig | undefined
  if (loaded.kind === "ok") config = loaded.config
  // No policy assigned is the normal unenforced state, not a failure.
  else if (loaded.kind === "invalid") signals.record("config_invalid")
  else if (loaded.kind === "missing") signals.record("config_missing")

  let mcpServers: readonly string[] = []

  // A note from an allow decision, held until the after hook where it can be appended.
  const pendingContext = new Map<string, string[]>()

  const send = async (section: Section, payload: HookPayload): Promise<Decision | undefined> => {
    if (config === undefined) return undefined
    const decision = await runHook(config, section, payload)
    if (decision.kind === "degraded") {
      signals.record(decision.signal)
    }
    return decision
  }

  // A crash is indistinguishable from a policy denial, so no exception may escape any
  // hook body. True on both APIs: a throw in before or after aborts the tool call.
  const guard = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch {
      signals.record("adapter_exception")
    }
  }

  // Telemetry paths additionally do nothing when the adapter is disabled.
  const emit = (run: () => Promise<void>): Promise<void> =>
    guard("emit", async () => {
      if (config === undefined) return
      await run()
    })

  // Never throws: a thrown error would read as a denial, so failure resolves to "no
  // denial" and is recorded.
  const evaluate = async (
    ctx: BuildContext,
    args: Record<string, unknown>,
    tools: ToolTables,
  ): Promise<string | undefined> => {
    try {
      if (config === undefined) return undefined

      const classification = classify(ctx.tool, mcpServers, tools)
      if (classification.kind === "none") return undefined

      const result = build(ctx, classification, args)
      if (result === undefined) return undefined

      for (const signal of result.signals) signals.record(signal)

      for (const payload of result.payloads) {
        const decision = await send(result.section, payload)
        if (decision?.kind === "deny") return decision.reason
        if (decision?.kind === "allow" && decision.context !== undefined) {
          const existing = pendingContext.get(ctx.callID) ?? []
          existing.push(decision.context)
          pendingContext.set(ctx.callID, existing)
        }
      }
      return undefined
    } catch {
      signals.record("adapter_exception")
      return undefined
    }
  }

  return {
    signals,
    directory,
    get enabled() {
      return config !== undefined
    },
    get mcpServers() {
      return mcpServers
    },
    setMcpServers(names) {
      mcpServers = names
    },
    send,
    evaluate,
    takeContext(callID) {
      const contexts = pendingContext.get(callID)
      pendingContext.delete(callID)
      return contexts
    },
    clearContext() {
      pendingContext.clear()
    },
    guard,
    emit,
  }
}

// ---------------------------------------------------------------------------
// Token ledger (V1 only)
// ---------------------------------------------------------------------------
// V1 reports a running total per message, so deltas are computed here.

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

function add(running: Counters, diff: Counters): Counters {
  return {
    input: running.input + diff.input,
    output: running.output + diff.output,
    reasoning: running.reasoning + diff.reasoning,
    cacheRead: running.cacheRead + diff.cacheRead,
    cacheWrite: running.cacheWrite + diff.cacheWrite,
    cost: running.cost + diff.cost,
  }
}

function rowsOf(byModel: Map<string, Counters>): UsageRow[] {
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
}

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
        byModel.set(entry.model, add(byModel.get(entry.model) ?? ZERO, diff))
      }

      return rowsOf(byModel)
    },

    pendingSessions() {
      return [...sessions.keys()]
    },
  }
}

// ---------------------------------------------------------------------------
// Token accumulator (V2 only)
// ---------------------------------------------------------------------------
// session.step.ended is a per-step delta, safe to sum; usage.updated would double count.

export interface UsageAccumulator {
  add(sessionID: string, model: string, counters: Counters): void
  flush(sessionID: string): UsageRow[]
  pendingSessions(): string[]
}

export function createAccumulator(): UsageAccumulator {
  const sessions = new Map<string, Map<string, Counters>>()

  return {
    add(sessionID, model, counters) {
      if (isEmpty(counters)) return
      let byModel = sessions.get(sessionID)
      if (byModel === undefined) {
        byModel = new Map<string, Counters>()
        sessions.set(sessionID, byModel)
      }
      byModel.set(model, add(byModel.get(model) ?? ZERO, counters))
    },

    flush(sessionID) {
      const byModel = sessions.get(sessionID)
      if (byModel === undefined) return []
      sessions.delete(sessionID)
      return rowsOf(byModel)
    },

    pendingSessions() {
      return [...sessions.keys()]
    },
  }
}
