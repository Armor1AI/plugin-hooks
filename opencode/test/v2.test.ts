import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { appendContextV2, countersOfV2, createV2Setup, field, mcpCallsOf, scanCodeMcp } from "../src/v2.ts"
import { createAccumulator } from "../src/runtime.ts"
import { V1_TOOLS, V2_TOOLS, build, classify, classifyAfter } from "../src/event.ts"

// Routing: V2 renamed bash to shell and added execute.

test("V2 routes shell and execute to command_execution", () => {
  assert.deepEqual(classify("shell", [], V2_TOOLS), { kind: "builtin", section: "command_execution" })
  assert.deepEqual(classify("execute", [], V2_TOOLS), { kind: "builtin", section: "command_execution" })
})

test("V2 does not know V1's bash, and V1 does not know V2's shell", () => {
  assert.deepEqual(classify("bash", [], V2_TOOLS), { kind: "none" })
  assert.deepEqual(classify("shell", [], V1_TOOLS), { kind: "none" })
})

test("file and network tools keep their V1 names on V2", () => {
  assert.deepEqual(classify("read", [], V2_TOOLS), { kind: "builtin", section: "file_access_read" })
  assert.deepEqual(classify("write", [], V2_TOOLS), { kind: "builtin", section: "file_access_write" })
  assert.deepEqual(classify("edit", [], V2_TOOLS), { kind: "builtin", section: "file_access_write" })
  assert.deepEqual(classify("webfetch", [], V2_TOOLS), { kind: "builtin", section: "network_access" })
  assert.deepEqual(classify("websearch", [], V2_TOOLS), { kind: "builtin", section: "network_access" })
})

test("V2 routes patch, its name for apply_patch, to the write sections", () => {
  assert.deepEqual(classify("patch", [], V2_TOOLS), { kind: "builtin", section: "file_access_write" })
  assert.deepEqual(classifyAfter("patch", [], V2_TOOLS), { kind: "builtin", section: "post_write_file" })
})

test("a V2 patch call yields one write payload per file, read from patchText", () => {
  // Verbatim from opencode 2.0.4 with GPT-5.6, which offered patch instead of write.
  const ctx = { tool: "patch", sessionID: "s", turnID: "t", callID: "c", cwd: "/work" }
  const args = {
    patchText: "*** Begin Patch\n*** Add File: /work/probe1.txt\n+hello\n*** Update File: secret.env\n@@\n-a\n+b\n*** End Patch",
  }
  const result = build(ctx, classify("patch", [], V2_TOOLS), args)
  assert.equal(result?.section, "file_access_write")
  assert.deepEqual(
    result?.payloads.map((p) => [p.tool_input["file_path"], p.armor1.patch_op]),
    [["/work/probe1.txt", "add"], ["/work/secret.env", "update"]],
  )
  assert.deepEqual(result?.signals, [])
})

test("V2 post sections cover shell and execute, and reads have none", () => {
  assert.deepEqual(classifyAfter("shell", [], V2_TOOLS), { kind: "builtin", section: "post_shell_execution" })
  assert.deepEqual(classifyAfter("execute", [], V2_TOOLS), { kind: "builtin", section: "post_shell_execution" })
  assert.deepEqual(classifyAfter("read", [], V2_TOOLS), { kind: "none" })
})

// Code mode reaches the policy as a command. The execute tool names its argument
// `code`; reading only command/cmd handed the policy an empty string.

test("the execute tool's code is what the policy sees as the command", () => {
  const ctx = { tool: "execute", sessionID: "s", turnID: "t", callID: "c", cwd: "/work" }
  const code = 'await tools["notion-server"]["API-get-self"]()'
  const result = build(ctx, classify("execute", [], V2_TOOLS), { code })

  assert.equal(result?.payloads[0]?.armor1.section, "command_execution")
  assert.deepEqual(result?.payloads[0]?.tool_input, { command: code })
})

test("a shell command still arrives as the command on V2", () => {
  const ctx = { tool: "shell", sessionID: "s", turnID: "t", callID: "c", cwd: "/work" }
  const result = build(ctx, classify("shell", [], V2_TOOLS), { command: "rm -rf /" })
  assert.deepEqual(result?.payloads[0]?.tool_input, { command: "rm -rf /" })
})

// Bus event shape: V2 nests the payload under `data`, not V1's `properties`.

test("field reads from data, which is where V2 puts the payload", () => {
  const event = { type: "session.step.ended", data: { sessionID: "ses_1", cost: 0.5 } }
  assert.equal(field(event, "sessionID"), "ses_1")
  assert.equal(field(event, "cost"), 0.5)
})

test("field falls back to the top level and tolerates junk", () => {
  assert.equal(field({ sessionID: "flat" }, "sessionID"), "flat")
  assert.equal(field({ data: { a: 1 } }, "missing"), undefined)
  assert.equal(field(null, "sessionID"), undefined)
  assert.equal(field("nonsense", "sessionID"), undefined)
})

// Token counters. cost sits beside tokens, not inside it.

test("countersOfV2 maps the nested cache block and takes cost separately", () => {
  const counters = countersOfV2({ input: 60, output: 20, reasoning: 3, cache: { read: 40, write: 7 } }, 0.25)
  assert.deepEqual(counters, {
    input: 60, output: 20, reasoning: 3, cacheRead: 40, cacheWrite: 7, cost: 0.25,
  })
})

test("countersOfV2 defaults everything missing to zero", () => {
  assert.deepEqual(countersOfV2(undefined, undefined), {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  })
  assert.equal(countersOfV2({ input: "not a number" }, null).input, 0)
})

// Token accumulation: session.step.ended is a per-step delta, safe to sum.
// session.usage.updated is the running total and would double count.

const counters = (input: number, output: number, cacheRead = 0) => ({
  input, output, reasoning: 0, cacheRead, cacheWrite: 0, cost: 0,
})

test("accumulator sums per-step deltas into one row per model", () => {
  const usage = createAccumulator()
  usage.add("ses_1", "test/m1", counters(60, 20, 40))
  usage.add("ses_1", "test/m1", counters(200, 77, 300))

  const rows = usage.flush("ses_1")
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.input_tokens, 260)
  assert.equal(rows[0]!.output_tokens, 97)
  assert.equal(rows[0]!.cache_read_input_tokens, 340)
})

test("accumulator groups by model and keeps sessions apart", () => {
  const usage = createAccumulator()
  usage.add("ses_1", "a/one", counters(10, 1))
  usage.add("ses_1", "b/two", counters(20, 2))
  usage.add("ses_2", "a/one", counters(99, 9))

  const first = usage.flush("ses_1")
  assert.equal(first.length, 2)
  assert.deepEqual(first.map((r) => r.model).sort(), ["a/one", "b/two"])
  assert.deepEqual(usage.flush("ses_2").map((r) => r.input_tokens), [99])
})

test("a flush empties the session, so a turn is never counted twice", () => {
  const usage = createAccumulator()
  usage.add("ses_1", "m", counters(10, 1))
  assert.equal(usage.flush("ses_1").length, 1)
  assert.deepEqual(usage.flush("ses_1"), [])
  assert.deepEqual(usage.pendingSessions(), [])
})

test("empty counters are dropped and an unknown session is safe", () => {
  const usage = createAccumulator()
  usage.add("ses_1", "m", counters(0, 0))
  assert.deepEqual(usage.flush("ses_1"), [])
  assert.deepEqual(usage.flush("never-seen"), [])
})

// MCP on V2 arrives in the execute result as `server.tool`, dot-separated.

const withCalls = (calls: unknown) => ({ metadata: { toolCalls: calls } })

test("mcpCallsOf splits the real V2 id on the first dot", () => {
  const calls = mcpCallsOf(withCalls([{ tool: "notion-server.API-get-self", status: "completed" }]))
  assert.deepEqual(calls, [{ server: "notion-server", tool: "API-get-self", args: {} }])
})

test("mcpCallsOf keeps dots in the tool half", () => {
  const calls = mcpCallsOf(withCalls([{ tool: "srv.group.tool", status: "completed" }]))
  assert.deepEqual(calls[0], { server: "srv", tool: "group.tool", args: {} })
})

test("mcpCallsOf carries arguments when the entry has them", () => {
  const calls = mcpCallsOf(withCalls([{ tool: "s.t", input: { query: "hi" } }]))
  assert.deepEqual(calls[0]!.args, { query: "hi" })
})

test("mcpCallsOf ignores builtin tools called from code mode", () => {
  assert.deepEqual(mcpCallsOf(withCalls([{ tool: "search", status: "completed" }])), [])
})

test("mcpCallsOf rejects malformed ids and junk metadata", () => {
  assert.deepEqual(mcpCallsOf(withCalls([{ tool: ".leading" }, { tool: "trailing." }, { tool: "" }, null, 7])), [])
  assert.deepEqual(mcpCallsOf(withCalls("not an array")), [])
  assert.deepEqual(mcpCallsOf({}), [])
  assert.deepEqual(mcpCallsOf(undefined), [])
})

// Context injection: V2 results carry a typed content parts array, not a string.

test("appendContextV2 pushes a text part onto an existing content array", () => {
  const result: Record<string, unknown> = { content: [{ type: "text", text: "tool output" }] }
  appendContextV2(result, ["Armor1 note: allowed"])
  assert.deepEqual(result["content"], [
    { type: "text", text: "tool output" },
    { type: "text", text: "Armor1 note: allowed" },
  ])
})

test("appendContextV2 creates the array when the result has none", () => {
  const result: Record<string, unknown> = {}
  appendContextV2(result, ["one", "two"])
  assert.deepEqual(result["content"], [{ type: "text", text: "one\ntwo" }])
})

test("appendContextV2 is a no-op on an absent result", () => {
  assert.doesNotThrow(() => appendContextV2(undefined, ["x"]))
})

// The adapter itself, driven through a fake context.

interface Registered { tool: Record<string, Function>; session: Record<string, Function> }

const fakeCtx = (registered: Registered) => ({
  location: { directory: "/work" },
  tool: { hook: async (name: string, cb: Function) => { registered.tool[name] = cb } },
  session: { hook: async (name: string, cb: Function) => { registered.session[name] = cb } },
  event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
  mcp: { list: async () => ({ data: [] }) },
})

// Both candidate homes must be empty: ARMOR1_HOME and the ~/.armor1 fallback, which on a
// developer box can hold a live enforcing policy.
const setup = async () => {
  process.env["ARMOR1_HOME"] = "/nonexistent/armor1"
  process.env["HOME"] = "/nonexistent/home"
  const registered: Registered = { tool: {}, session: {} }
  const cleanup = await createV2Setup()(fakeCtx(registered) as never)
  return { registered, cleanup }
}

test("setup registers both tool hooks and both session hooks", async () => {
  const { registered, cleanup } = await setup()
  assert.deepEqual(Object.keys(registered.tool).sort(), ["execute.after", "execute.before"])
  assert.deepEqual(Object.keys(registered.session).sort(), ["context", "prompt"])
  await cleanup()
})

test("execute.before does not block when the adapter is disabled", async () => {
  const { registered, cleanup } = await setup()
  await assert.doesNotReject(() =>
    registered.tool["execute.before"]!({
      tool: "shell", sessionID: "s", agent: "build", messageID: "m", id: "c",
      input: { command: "rm -rf /" },
    }),
  )
  await cleanup()
})

test("every V2 hook tolerates malformed input without throwing", async () => {
  const { registered, cleanup } = await setup()
  const base = { tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c" }

  const calls: [Function, unknown][] = [
    [registered.tool["execute.before"]!, { ...base, input: null }],
    [registered.tool["execute.before"]!, { ...base, input: "not an object" }],
    [registered.tool["execute.after"]!, { ...base, status: "completed", result: undefined }],
    [registered.tool["execute.after"]!, { ...base, tool: "execute", status: "error", error: null }],
    [registered.tool["execute.after"]!, { ...base, tool: "execute", status: "completed", result: { metadata: null } }],
    [registered.session["prompt"]!, { sessionID: "s", messageID: "m", prompt: null }],
    [registered.session["prompt"]!, { sessionID: "s", messageID: "m" }],
    [registered.session["context"]!, { sessionID: "s" }],
    [registered.session["context"]!, { sessionID: "s", model: null, agent: undefined }],
  ]

  for (const [hook, arg] of calls) {
    await assert.doesNotReject(() => hook(arg) as Promise<void>, `threw on ${JSON.stringify(arg)}`)
  }
  await cleanup()
})

test("cleanup is safe to await", async () => {
  const { cleanup } = await setup()
  await assert.doesNotReject(async () => { await cleanup() })
})

// Before the call only the program exists, so the pair is read from the code text.
// What cannot be read is counted and allowed, not blocked.

const SERVERS = ["notion-server", "github"]

test("scanCodeMcp reads the bracket form a real model wrote", () => {
  const scan = scanCodeMcp('return await tools["notion-server"]["API-get-self"]()', SERVERS)
  assert.deepEqual(scan.calls, [{ server: "notion-server", tool: "API-get-self" }])
  assert.equal(scan.dynamic, false)
})

test("scanCodeMcp reads dot access and mixed access", () => {
  assert.deepEqual(scanCodeMcp("await tools.github.get_issue({})", SERVERS).calls, [
    { server: "github", tool: "get_issue" },
  ])
  assert.deepEqual(scanCodeMcp('await tools.github["get-issue"]({})', SERVERS).calls, [
    { server: "github", tool: "get-issue" },
  ])
})

test("scanCodeMcp gates every call in one program", () => {
  const scan = scanCodeMcp(
    'await tools["notion-server"]["API-get-self"](); await tools.github.get_issue({})',
    SERVERS,
  )
  assert.deepEqual(scan.calls, [
    { server: "notion-server", tool: "API-get-self" },
    { server: "github", tool: "get_issue" },
  ])
  assert.equal(scan.dynamic, false)
})

test("scanCodeMcp drops builtin namespaces without calling them dynamic", () => {
  const scan = scanCodeMcp('await tools.browser.evaluate({}); await tools.opencode.session_rename({})', SERVERS)
  assert.deepEqual(scan.calls, [])
  assert.equal(scan.dynamic, false)
})

test("scanCodeMcp reports the concatenation dodge as dynamic, and allows it", () => {
  const scan = scanCodeMcp('const s = "not" + "ion-server"; await tools[s]["API-get-self"]({})', SERVERS)
  assert.deepEqual(scan.calls, [])
  assert.equal(scan.dynamic, true)
})

test("scanCodeMcp reports an aliased server as dynamic", () => {
  const scan = scanCodeMcp('const t = tools["notion-server"]; await t["API-get-self"]()', SERVERS)
  assert.deepEqual(scan.calls, [])
  assert.equal(scan.dynamic, true)
})

test("scanCodeMcp ignores a server that is not configured, and names it", () => {
  const scan = scanCodeMcp('await tools["other-server"]["x"]()', SERVERS)
  assert.deepEqual(scan.calls, [])
  assert.deepEqual(scan.unknown, ["other-server"])
})

test("scanCodeMcp handles code with no tools reference", () => {
  assert.deepEqual(scanCodeMcp("return 1 + 1", SERVERS), { calls: [], dynamic: false, unknown: [] })
  assert.deepEqual(scanCodeMcp("", SERVERS), { calls: [], dynamic: false, unknown: [] })
})

// In service mode two instances share the bus; only the one dispatched a session's
// hooks may report it, or every stop and token row doubles.

// A real ARMOR1_HOME whose hooks.sh records the sections it was called with, so the test
// observes what was actually sent rather than what the adapter intended to send.
const busRig = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armor1-v2-bus-"))
  const policies = path.join(home, "current", "policies")
  fs.mkdirSync(policies, { recursive: true })
  fs.writeFileSync(
    path.join(policies, "policies.json"),
    JSON.stringify({
      telemetry_engine: "interpreter",
      policies: { "opencode-policy": { spec_uname: "opencode-policy", remediation_mode: true, telemetry_mode: true } },
    }),
  )
  const log = path.join(home, "sections.log")
  fs.writeFileSync(
    path.join(policies, "hooks.sh"),
    `#!/bin/bash\nwhile [[ $# -gt 0 ]]; do case "$1" in --hook) echo "$2" >> ${log}; shift 2 ;; *) shift ;; esac; done\ncat >/dev/null\nprintf '{"decision":"allow"}\\n'\n`,
  )
  fs.chmodSync(path.join(policies, "hooks.sh"), 0o755)
  return { home, log, sections: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) }
}

// V2 bus events carry their payload under `data`, not V1's `properties`.
const turnOf = (sessionID: string) => [
  { type: "session.step.ended", data: { sessionID, tokens: { input: 10, output: 5 } } },
  { type: "session.execution.succeeded", data: { sessionID } },
]
const TURN = turnOf("s")

// The adapter drains the subscription itself, so hold events behind `gate` and wait
// for `drained` before teardown, or the teardown races delivery.
const busSetup = async (home: string, events: unknown[] = TURN, directory = "/work") => {
  process.env["ARMOR1_HOME"] = home
  const registered: Registered = { tool: {}, session: {} }
  let open: () => void
  let finished: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  const drained = new Promise<void>((resolve) => { finished = resolve })
  const ctx = {
    ...fakeCtx(registered),
    location: { directory },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          try {
            await gate
            for (const event of events) yield event
          } finally {
            finished()
          }
        },
      }),
    },
  }
  const cleanup = await createV2Setup()(ctx as never)
  return { registered, cleanup, sendTurn: async () => { open(); await drained } }
}

test("a copy that was never dispatched a hook reports nothing", async () => {
  const rig = busRig()
  const { cleanup, sendTurn } = await busSetup(rig.home)

  await sendTurn()
  await cleanup()

  assert.deepEqual(rig.sections(), [], "the ghost copy emitted telemetry")
})

test("the copy that owns the hooks reports the turn exactly once", async () => {
  const rig = busRig()
  const { registered, cleanup, sendTurn } = await busSetup(rig.home)

  await registered.session["prompt"]!({ sessionID: "s", messageID: "msg_1", prompt: { text: "hi" } })
  await sendTurn()
  await cleanup()

  const sections = rig.sections()
  assert.equal(sections.filter((s) => s === "stop").length, 1)
  assert.equal(sections.filter((s) => s === "model_token_usage").length, 1)
})

test("two instances for two projects each report only their own session", async () => {
  // The service keeps one instance per project directory and every instance hears every
  // bus event. Both instances here have seen a hook, so a per-instance flag would let each
  // report both sessions. Per-session ownership must yield exactly one row per turn.
  const rig = busRig()
  const both = [...turnOf("a"), ...turnOf("b")]
  const A = await busSetup(rig.home, both, "/project-a")
  const B = await busSetup(rig.home, both, "/project-b")

  await A.registered.session["prompt"]!({ sessionID: "a", messageID: "msg_a", prompt: { text: "hi" } })
  await B.registered.session["prompt"]!({ sessionID: "b", messageID: "msg_b", prompt: { text: "hi" } })
  await A.sendTurn()
  await B.sendTurn()
  await A.cleanup()
  await B.cleanup()

  const sections = rig.sections()
  assert.equal(sections.filter((s) => s === "stop").length, 2, `stops: ${JSON.stringify(sections)}`)
  assert.equal(sections.filter((s) => s === "model_token_usage").length, 2)
})

test("an MCP server missing at setup is picked up when code mode first names it", async () => {
  // The service has no MCP servers loaded when setup runs. The list must be re-read on
  // demand, or the gate silently sees an empty allowlist forever.
  const rig = busRig()
  process.env["ARMOR1_HOME"] = rig.home
  const registered: Registered = { tool: {}, session: {} }
  let listCalls = 0
  const ctx = {
    ...fakeCtx(registered),
    mcp: { list: async () => ({ data: ++listCalls === 1 ? [] : [{ name: "notion-server" }] }) },
  }
  const cleanup = await createV2Setup()(ctx as never)

  await registered.tool["execute.before"]!({
    tool: "execute", sessionID: "s", agent: "build", messageID: "m", id: "c",
    input: { code: 'await tools["notion-server"]["API-get-self"]({})' },
  })
  await cleanup()

  assert.equal(listCalls, 2, "the list was not re-read")
  assert.deepEqual(rig.sections(), ["command_execution", "mcp"])
})

test("a namespace that is not a server triggers one refresh, not one per call", async () => {
  const rig = busRig()
  process.env["ARMOR1_HOME"] = rig.home
  const registered: Registered = { tool: {}, session: {} }
  let listCalls = 0
  const ctx = { ...fakeCtx(registered), mcp: { list: async () => { listCalls++; return { data: [] } } } }
  const cleanup = await createV2Setup()(ctx as never)

  const call = { tool: "execute", sessionID: "s", agent: "build", messageID: "m", id: "c", input: { code: "const f = tools.browser.evaluate" } }
  await registered.tool["execute.before"]!(call)
  await registered.tool["execute.before"]!({ ...call, id: "c2" })
  await cleanup()

  assert.equal(listCalls, 2, "setup plus exactly one refresh")
  assert.deepEqual(rig.sections().filter((s) => s === "mcp"), [])
})
