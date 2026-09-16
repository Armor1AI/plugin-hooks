import type { Counters } from "./types.ts"
import {
  V2_TOOLS,
  build,
  buildAfter,
  buildAfterMcp,
  buildError,
  buildPrompt,
  buildSessionStart,
  buildStop,
  buildUsage,
  classifyAfter,
  type BuildContext,
} from "./event.ts"
import { createAccumulator, createRuntime, errorDetails } from "./runtime.ts"
import { isRecord } from "./normalize.ts"

// ---------------------------------------------------------------------------
// V2 adapter
// ---------------------------------------------------------------------------
// Tool calls carry agent/messageID directly, so no turn-tracking maps.

interface V2ToolBefore {
  tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  input: unknown
}

interface V2ToolAfter {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly input: unknown
  readonly status: "completed" | "error"
  result?: Record<string, unknown>
  error?: unknown
}

interface V2Context {
  readonly location?: { readonly directory?: string }
  readonly tool: { hook(name: string, cb: (event: never) => void | Promise<void>): Promise<unknown> }
  readonly session: { hook(name: string, cb: (event: never) => void | Promise<void>): Promise<unknown> }
  readonly event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> }
  readonly mcp: { list(): Promise<unknown> }
}

const argsOf = (input: unknown): Record<string, unknown> => (isRecord(input) ? input : {})

// V2 bus events carry their payload under `data`. The flat fallback turns a shape change
// into missing telemetry rather than a crash.
export function field(event: unknown, name: string): unknown {
  if (!isRecord(event)) return undefined
  const data = event["data"]
  if (isRecord(data) && data[name] !== undefined) return data[name]
  return event[name]
}

// `cost` sits beside `tokens` in the event data, not inside it.
export function countersOfV2(tokens: unknown, cost: unknown): Counters {
  const t = isRecord(tokens) ? tokens : {}
  const cache = isRecord(t["cache"]) ? (t["cache"] as Record<string, unknown>) : {}
  const num = (v: unknown): number => (typeof v === "number" ? v : 0)
  return {
    input: num(t["input"]),
    output: num(t["output"]),
    reasoning: num(t["reasoning"]),
    cacheRead: num(cache["read"]),
    cacheWrite: num(cache["write"]),
    cost: num(cost),
  }
}

// V2 MCP calls surface only in the execute result metadata, as `server.tool` ids.
// A dotless id is a builtin called from code mode, not MCP.
export function mcpCallsOf(result: Record<string, unknown> | undefined): { server: string; tool: string; args: Record<string, unknown> }[] {
  const metadata = isRecord(result?.["metadata"]) ? (result["metadata"] as Record<string, unknown>) : undefined
  const calls = metadata?.["toolCalls"]
  if (!Array.isArray(calls)) return []

  const out: { server: string; tool: string; args: Record<string, unknown> }[] = []
  for (const entry of calls) {
    if (!isRecord(entry)) continue
    const id = typeof entry["tool"] === "string" ? entry["tool"] : ""
    const dot = id.indexOf(".")
    if (dot <= 0 || dot === id.length - 1) continue
    out.push({
      server: id.slice(0, dot),
      tool: id.slice(dot + 1),
      args: isRecord(entry["input"]) ? (entry["input"] as Record<string, unknown>) : {},
    })
  }
  return out
}

// Reads MCP server/tool from the code text before execution. Only literal keys parse;
// a dynamic key like tools[name] yields no call, flagged `dynamic` (counted, never blocked).
const ACCESS = "(?:\\[\\s*[\"'`]([^\"'`]+)[\"'`]\\s*\\]|\\.([A-Za-z_$][\\w$]*))"
const LITERAL_PAIR = new RegExp(`\\btools${ACCESS}${ACCESS}`, "g")
const TOOLS_REF = /\btools\s*[.[]/g

export function scanCodeMcp(
  code: string,
  servers: readonly string[],
): { calls: { server: string; tool: string }[]; dynamic: boolean; unknown: string[] } {
  const pairs: { server: string; tool: string }[] = []
  for (const match of code.matchAll(LITERAL_PAIR)) {
    const server = match[1] ?? match[2]
    const tool = match[3] ?? match[4]
    if (server === undefined || tool === undefined) continue
    pairs.push({ server, tool })
  }
  // A readable pair that is not a configured server (e.g. tools.browser.evaluate) is
  // dropped, not counted as dynamic.
  return {
    calls: pairs.filter((pair) => servers.includes(pair.server)),
    dynamic: [...code.matchAll(TOOLS_REF)].length > pairs.length,
    unknown: [...new Set(pairs.map((pair) => pair.server).filter((server) => !servers.includes(server)))],
  }
}

export function createV2Setup() {
  return async (ctx: V2Context): Promise<() => void> => {
    // `location` is this instance's project dir. process.cwd() would be the service's own
    // cwd (the user's home), wrong for every payload.
    const directory = ctx.location?.directory ?? process.cwd()
    const rt = createRuntime(directory)

    const usage = createAccumulator()
    const turns = new Map<string, string>()
    // Sessions already reported, so teardown does not send a second stop.
    const ended = new Set<string>()
    const models = new Map<string, string>()
    const started = new Set<string>()
    // Every instance hears every bus event, but only its own session's hooks. Report a
    // session only if this instance saw a hook for it, else two open projects double every
    // stop and token row. The prompt hook precedes the first step.ended, so none is dropped.
    const owned = (sessionID: string): boolean => turns.has(sessionID) || started.has(sessionID)
    const turnOf = (sessionID: string): string => turns.get(sessionID) ?? ""

    // MCP servers aren't loaded at setup, so this list starts empty and is re-read when code
    // mode names an unknown one. Single-flight (concurrent mcp.list() deadlocks) and bounded.
    let mcpServers: readonly string[] = []
    let listing: Promise<void> | undefined
    const refreshMcpServers = (): Promise<void> => {
      listing ??= (async () => {
        try {
          const listed = await Promise.race([
            ctx.mcp.list(),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000).unref?.()),
          ])
          const data = isRecord(listed) ? listed["data"] : undefined
          if (Array.isArray(data) && data.length > 0) {
            mcpServers = data.map((entry) => (isRecord(entry) && typeof entry["name"] === "string" ? entry["name"] : ""))
            rt.setMcpServers(mcpServers)
          }
        } catch {
          rt.signals.record("adapter_exception")
        } finally {
          listing = undefined
        }
      })()
      return listing
    }
    // Unknown after a refresh, so we do not re-list on every call.
    const notServers = new Set<string>()
    await refreshMcpServers()

    const context = (sessionID: string, tool: string, callID: string, messageID: string): BuildContext => ({
      tool,
      sessionID,
      turnID: messageID !== "" ? messageID : turnOf(sessionID),
      callID,
      cwd: directory,
    })

    const flushUsage = async (sessionID: string): Promise<void> => {
      const rows = usage.flush(sessionID)
      if (rows.length === 0) return
      await rt.send(
        "model_token_usage",
        buildUsage({ sessionID, turnID: turnOf(sessionID), cwd: directory }, "session", rows),
      )
    }

    await ctx.tool.hook("execute.before", async (event: V2ToolBefore) => {
      const denial = await rt.evaluate(
        context(event.sessionID, event.tool, event.id, event.messageID),
        argsOf(event.input),
        V2_TOOLS,
      )
      // The only throw on the V2 path.
      if (denial !== undefined) throw new Error(denial)

      if (event.tool !== "execute") return

      // Code mode is the only route to MCP on V2, so gate `mcp` from the program text too.
      // A crash must not read as a denial, so the scan runs in guard and the throw follows.
      let mcpDenial: string | undefined
      await rt.guard("mcp_code", async () => {
        const code = typeof argsOf(event.input)["code"] === "string" ? (argsOf(event.input)["code"] as string) : ""
        let scan = scanCodeMcp(code, mcpServers)
        if (scan.unknown.some((server) => !notServers.has(server))) {
          await refreshMcpServers()
          scan = scanCodeMcp(code, mcpServers)
          for (const server of scan.unknown) notServers.add(server)
        }
        if (scan.dynamic) rt.signals.record("mcp_code_dynamic")

        for (const call of scan.calls) {
          const built = build(
            context(event.sessionID, `${call.server}.${call.tool}`, event.id, event.messageID),
            { kind: "mcp", section: "mcp", resolution: { kind: "match", server: call.server, tool: call.tool } },
            {},
          )
          if (built === undefined) continue
          for (const payload of built.payloads) {
            const decision = await rt.send("mcp", payload)
            if (decision?.kind === "deny") {
              mcpDenial = decision.reason
              return
            }
          }
        }
      })
      if (mcpDenial !== undefined) throw new Error(mcpDenial)
    })

    await ctx.tool.hook("execute.after", async (event: V2ToolAfter) => {
      await rt.guard("inject", async () => {
        const contexts = rt.takeContext(event.id)
        if (contexts !== undefined && contexts.length > 0 && event.status === "completed") {
          appendContextV2(event.result, contexts)
        }
      })

      await rt.emit(async () => {
        const classification = classifyAfter(event.tool, [], V2_TOOLS)
        if (classification.kind === "none") return

        const ctxBuild = context(event.sessionID, event.tool, event.id, event.messageID)
        const result =
          classification.kind === "mcp"
            ? buildAfterMcp(ctxBuild, classification.resolution, argsOf(event.input), event.result)
            : buildAfter(ctxBuild, classification.section, argsOf(event.input))

        for (const signal of result.signals) rt.signals.record(signal)
        for (const payload of result.payloads) await rt.send(classification.section, payload)
      })

      // Code mode can invoke MCP tools the tool hook never sees individually.
      if (event.tool === "execute" && event.status === "completed") {
        await rt.emit(async () => {
          for (const call of mcpCallsOf(event.result)) {
            const mcpCtx = context(event.sessionID, `${call.server}.${call.tool}`, event.id, event.messageID)
            const built = buildAfterMcp(mcpCtx, { kind: "match", server: call.server, tool: call.tool }, call.args, event.result)
            for (const signal of built.signals) rt.signals.record(signal)
            for (const payload of built.payloads) await rt.send("post_mcp", payload)
          }
        })
      }
    })

    await ctx.session.hook("prompt", async (event: { sessionID: string; messageID: string; prompt?: unknown }) => {
      await rt.guard("prompt", async () => {
        if (event.messageID !== undefined) turns.set(event.sessionID, event.messageID)
        const text = isRecord(event.prompt) && typeof event.prompt["text"] === "string" ? event.prompt["text"] : ""
        if (text === "") return
        await rt.emit(async () => {
          await rt.send(
            "before_submit_prompt",
            buildPrompt({ sessionID: event.sessionID, turnID: turnOf(event.sessionID), cwd: directory }, text),
          )
        })
      })
    })

    // The prompt hook has no model/agent; the context hook does. Emit session_start from
    // the first context hook per session.
    await ctx.session.hook(
      "context",
      async (event: { sessionID: string; agent?: string; model?: { id?: string; providerID?: string } }) => {
        await rt.guard("context", async () => {
          const provider = event.model?.providerID ?? ""
          const id = event.model?.id ?? ""
          const model = provider === "" ? id : `${provider}/${id}`
          models.set(event.sessionID, model)
          if (started.has(event.sessionID)) return
          started.add(event.sessionID)
          await rt.emit(async () => {
            await rt.send(
              "session_start",
              buildSessionStart(
                { sessionID: event.sessionID, turnID: turnOf(event.sessionID), cwd: directory },
                model,
                event.agent ?? "",
              ),
            )
          })
        })
      },
    )

    // `opencode run` exits the moment a turn ends, so teardown must await the in-flight
    // send or stop_failure is lost.
    const aborter = new AbortController()
    let inflight: Promise<void> = Promise.resolve()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: aborter.signal })) {
          inflight = inflight.then(() => rt.guard("event", () => onBusEvent(event)))
          await inflight
        }
      } catch {
        rt.signals.record("adapter_exception")
      }
    })()

    const onBusEvent = async (event: unknown): Promise<void> => {
      const type = isRecord(event) && typeof event["type"] === "string" ? event["type"] : ""
      const sessionID = typeof field(event, "sessionID") === "string" ? (field(event, "sessionID") as string) : ""
      if (sessionID === "") return
      if (!owned(sessionID)) return

      // Per-step deltas. session.usage.updated is the running total; emitting it would
      // double count.
      if (type === "session.step.ended") {
        usage.add(sessionID, models.get(sessionID) ?? "", countersOfV2(field(event, "tokens"), field(event, "cost")))
        return
      }

      if (type === "session.execution.succeeded" || type === "session.execution.interrupted") {
        ended.add(sessionID)
        await rt.emit(async () => {
          await rt.send("stop", buildStop({ sessionID, turnID: turnOf(sessionID), cwd: directory }))
        })
        await rt.emit(() => flushUsage(sessionID))
        rt.clearContext()
        return
      }

      if (type !== "session.execution.failed") return
      ended.add(sessionID)
      await rt.emit(async () => {
        const raw = field(event, "error")
        const name = isRecord(raw) && typeof raw["name"] === "string" ? raw["name"] : "UnknownError"
        await rt.send(
          "stop_failure",
          buildError({ sessionID, turnID: turnOf(sessionID), cwd: directory }, name, errorDetails(raw)),
        )
      })
      await rt.emit(() => flushUsage(sessionID))
    }

    return async () => {
      // Drain before aborting: aborting first raced session.execution.succeeded and lost
      // the stop.
      await inflight
      aborter.abort()
      for (const sessionID of usage.pendingSessions()) {
        if (!owned(sessionID)) continue
        if (!ended.has(sessionID)) {
          ended.add(sessionID)
          await rt.emit(async () => {
            await rt.send("stop", buildStop({ sessionID, turnID: turnOf(sessionID), cwd: directory }))
          })
        }
        await rt.emit(() => flushUsage(sessionID))
      }
    }
  }
}

// V2 results carry a typed `content` parts array rather than V1's string `output`.
export function appendContextV2(result: Record<string, unknown> | undefined, contexts: readonly string[]): void {
  if (result === undefined) return
  const text = contexts.join("\n")
  const content = result["content"]
  if (Array.isArray(content)) {
    content.push({ type: "text", text })
    return
  }
  result["content"] = [{ type: "text", text }]
}
