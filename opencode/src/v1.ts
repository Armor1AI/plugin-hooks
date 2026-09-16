import type { AssistantMessageLike } from "./types.ts"
import {
  V1_TOOLS,
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
import { createLedger, createRuntime, errorDetails } from "./runtime.ts"
import { isRecord } from "./normalize.ts"

// ---------------------------------------------------------------------------
// V1 adapter
// ---------------------------------------------------------------------------

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

export const Armor1Plugin = async ({ directory }: PluginInput) => {
  const rt = createRuntime(directory)

  // Tool hooks carry no turn id, so the user message id is remembered per session and
  // stamped onto that turn.
  const turns = new Map<string, string>()
  const turnOf = (sessionID: string): string => turns.get(sessionID) ?? ""

  const ledger = createLedger()
  const parents = new Map<string, string | undefined>()
  const started = new Set<string>()

  const flushUsage = async (sessionID: string): Promise<void> => {
    const rows = ledger.flush(sessionID)
    if (rows.length === 0) return

    const parentID = parents.get(sessionID)
    const scope = parentID !== undefined && parentID !== "" ? "subagent" : "session"
    await rt.send(
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

  return {
    config: async (input?: { mcp?: Record<string, unknown> }): Promise<void> => {
      await rt.guard("config", async () => {
        rt.setMcpServers(Object.keys(input?.mcp ?? {}))
      })
    },

    "tool.execute.before": async (input: ToolBeforeInput, output: ToolOutput): Promise<void> => {
      const denial = await rt.evaluate(
        context(input.sessionID, input.tool, input.callID),
        output.args ?? {},
        V1_TOOLS,
      )
      // The only throw on the V1 path.
      if (denial !== undefined) throw new Error(denial)
    },

    "tool.execute.after": async (input: ToolAfterInput, output: ToolAfterOutput): Promise<void> => {
      // Runs for every tool before telemetry, so a slow or failing hook cannot cost the
      // model its context.
      await rt.guard("inject", async () => {
        const contexts = rt.takeContext(input.callID)
        if (contexts !== undefined && contexts.length > 0) appendContextV1(output, contexts)
      })

      await rt.emit(async () => {
        const classification = classifyAfter(input.tool, [], V1_TOOLS)
        if (classification.kind === "none") return

        const ctx = context(input.sessionID, input.tool, input.callID)
        const result =
          classification.kind === "mcp"
            ? buildAfterMcp(ctx, classification.resolution, input.args ?? {}, output)
            : buildAfter(ctx, classification.section, input.args ?? {})

        for (const signal of result.signals) rt.signals.record(signal)
        for (const payload of result.payloads) await rt.send(classification.section, payload)
      })
    },

    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput): Promise<void> => {
      await rt.guard("chat.message", async () => {
        // input.messageID is absent in `opencode run`; the user message carries the id.
        const turnID = output.message?.id ?? input.messageID
        if (turnID !== undefined) turns.set(input.sessionID, turnID)

        // session.created carries no model/agent, so emit session_start from the first
        // prompt, where both are known.
        if (!started.has(input.sessionID)) {
          started.add(input.sessionID)
          await rt.emit(async () => {
            // `opencode run` leaves these off the hook input; the user message carries them.
            const source = output.message?.model ?? input.model
            const provider = source?.providerID ?? ""
            const modelID = source?.modelID ?? ""
            const model = provider === "" ? modelID : `${provider}/${modelID}`
            await rt.send(
              "session_start",
              buildSessionStart(
                { sessionID: input.sessionID, turnID: turnOf(input.sessionID), cwd: directory },
                model,
                output.message?.agent ?? input.agent ?? "",
              ),
            )
          })
        }

        await rt.emit(async () => {
          const prompt = (output.parts ?? [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
          if (prompt === "") return
          await rt.send(
            "before_submit_prompt",
            buildPrompt({ sessionID: input.sessionID, turnID: turnOf(input.sessionID), cwd: directory }, prompt),
          )
        })
      })
    },

    dispose: async (): Promise<void> => {
      // dispose is awaited during teardown, the one flush point the process exit cannot
      // cut short.
      for (const sessionID of ledger.pendingSessions()) {
        await rt.emit(() => flushUsage(sessionID))
      }
    },

    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      await rt.guard("event", async () => {
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
          await rt.emit(async () => {
            await rt.send("stop", buildStop({ sessionID, turnID: turnOf(sessionID), cwd: directory }))
          })
          await rt.emit(() => flushUsage(sessionID))
          rt.clearContext()
          return
        }

        if (event.type !== "session.error") return
        await rt.emit(async () => {
          const sessionID = typeof properties["sessionID"] === "string" ? properties["sessionID"] : ""
          const raw = properties["error"]
          const error = isRecord(raw) && typeof raw["name"] === "string" ? raw["name"] : "UnknownError"
          await rt.send(
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

// The after hook's output object becomes the tool result: builtin tools a string `output`,
// MCP tools a raw result with a `content` array.
function appendContextV1(output: ToolAfterOutput, contexts: readonly string[]): void {
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
