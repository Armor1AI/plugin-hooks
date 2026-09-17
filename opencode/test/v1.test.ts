import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Armor1Plugin } from "../src/v1.ts"
import { createLedger, modelName } from "../src/runtime.ts"

// Token ledger

const message = (over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant",
  providerID: "anthropic",
  modelID: "claude-sonnet-5",
  cost: 0.01,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 60 } },
  ...over,
})

test("model name joins provider and model", () => {
  assert.equal(modelName(message()), "anthropic/claude-sonnet-5")
  assert.equal(modelName({ id: "m", sessionID: "s", modelID: "solo" }), "solo")
})

test("maps the four counters every client reports and nothing else", () => {
  const ledger = createLedger()
  ledger.record(message())
  const rows = ledger.flush("ses_1")

  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    model: "anthropic/claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 60,
  })
})

test("repeated updates of one message are not double counted", () => {
  const ledger = createLedger()
  ledger.record(message({ tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  ledger.record(message({ tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }))
  ledger.record(message({ tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }))

  const rows = ledger.flush("ses_1")
  assert.equal(rows[0]?.input_tokens, 100)
  assert.equal(rows[0]?.output_tokens, 20)
})

test("a message updated after a flush reports only the delta", () => {
  const ledger = createLedger()
  ledger.record(message({ tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }))
  assert.equal(ledger.flush("ses_1")[0]?.input_tokens, 100)

  ledger.record(message({ tokens: { input: 130, output: 25, reasoning: 0, cache: { read: 0, write: 0 } } }))
  const second = ledger.flush("ses_1")
  assert.equal(second[0]?.input_tokens, 30)
  assert.equal(second[0]?.output_tokens, 5)
})

test("a flush with nothing new returns no rows", () => {
  const ledger = createLedger()
  ledger.record(message())
  ledger.flush("ses_1")
  assert.deepEqual(ledger.flush("ses_1"), [])
})

test("sums across messages and groups by model", () => {
  const ledger = createLedger()
  ledger.record(message({ id: "a", tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  ledger.record(message({ id: "b", tokens: { input: 20, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }))
  ledger.record(
    message({ id: "c", modelID: "claude-haiku", tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }),
  )

  const rows = ledger.flush("ses_1").sort((x, y) => x.model.localeCompare(y.model))
  assert.equal(rows.length, 2)
  assert.equal(rows.find((r) => r.model.endsWith("claude-haiku"))?.input_tokens, 7)
  assert.equal(rows.find((r) => r.model.endsWith("claude-sonnet-5"))?.input_tokens, 30)
})

test("sessions are kept separate", () => {
  const ledger = createLedger()
  ledger.record(message({ id: "a", sessionID: "ses_1" }))
  ledger.record(message({ id: "b", sessionID: "ses_2" }))

  assert.equal(ledger.flush("ses_1").length, 1)
  assert.equal(ledger.flush("ses_2").length, 1)
  assert.deepEqual(ledger.pendingSessions().sort(), ["ses_1", "ses_2"])
})

test("ignores user messages and messages with no token block", () => {
  const ledger = createLedger()
  ledger.record({ id: "u", sessionID: "ses_1", role: "user" })
  ledger.record({ id: "n", sessionID: "ses_1", role: "assistant" })
  assert.deepEqual(ledger.flush("ses_1"), [])
})

test("flushing an unknown session is safe", () => {
  assert.deepEqual(createLedger().flush("nope"), [])
})

// Nothing may throw

// The adapter must never throw except a deliberate denial: OpenCode cannot tell a
// crash from a deny in tool.execute.before.
// Point both candidate homes (ARMOR1_HOME and the ~/.armor1 fallback) at paths that cannot
// exist, so a live policy on the developer box cannot leak in.
const load = () => {
  process.env["ARMOR1_HOME"] = "/nonexistent/armor1"
  process.env["HOME"] = "/nonexistent/home"
  return Armor1Plugin({ directory: "/work" })
}

test("every hook tolerates malformed input without throwing", async () => {
  const hooks = (await load()) as Record<string, (...args: unknown[]) => Promise<void>>

  const calls: [string, unknown[]][] = [
    ["config", [undefined]],
    ["config", [{}]],
    ["config", [{ mcp: null }]],
    ["tool.execute.before", [{ tool: "bash", sessionID: "s", callID: "c" }, {}]],
    ["tool.execute.before", [{ tool: "bash", sessionID: "s", callID: "c" }, { args: null }]],
    ["tool.execute.after", [{ tool: "bash", sessionID: "s", callID: "c" }, undefined]],
    ["chat.message", [{ sessionID: "s" }, {}]],
    ["chat.message", [{ sessionID: "s" }, { parts: null }]],
    ["chat.message", [{ sessionID: "s" }, { message: null, parts: [{ type: "text" }] }]],
    ["event", [{ event: { type: "session.idle", properties: { sessionID: "s" } } }]],
    ["event", [{ event: { type: "message.updated", properties: { info: null } } }]],
    ["event", [{ event: { type: "session.error", properties: {} } }]],
    ["event", [{ event: {} }]],
    ["dispose", []],
  ]

  for (const [name, args] of calls) {
    const hook = hooks[name]
    assert.ok(hook, `missing hook ${name}`)
    await assert.doesNotReject(() => hook(...args), `${name} threw on ${JSON.stringify(args)}`)
  }
})

test("tool.execute.before does not block when the adapter is disabled", async () => {
  const hooks = (await load()) as Record<string, (...args: unknown[]) => Promise<void>>
  await assert.doesNotReject(() =>
    hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /" } }),
  )
})

// The after hook classifies MCP tools with the server list too. It used to be handed an
// empty list, so an MCP call was reported on the way in (mcp) but never on the way out
// (post_mcp). Drives a real recording hooks.sh so the sent sections are observed.
test("V1 after hook resolves an MCP tool and sends post_mcp", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armor1-v1-mcp-"))
  const policies = path.join(home, "current", "policies")
  fs.mkdirSync(policies, { recursive: true })
  fs.writeFileSync(path.join(policies, "policies.json"), JSON.stringify({
    telemetry_engine: "interpreter",
    policies: { "opencode-policy": { spec_uname: "opencode-policy", remediation_mode: true, telemetry_mode: true } },
  }))
  const log = path.join(home, "sections.log")
  fs.writeFileSync(path.join(policies, "hooks.sh"),
    `#!/bin/bash\nwhile [[ $# -gt 0 ]]; do case "$1" in --hook) echo "$2" >> ${log}; shift 2 ;; *) shift ;; esac; done\ncat >/dev/null\nprintf '{"decision":"allow"}\\n'\n`)
  fs.chmodSync(path.join(policies, "hooks.sh"), 0o755)
  process.env["ARMOR1_HOME"] = home

  const hooks = await Armor1Plugin({ directory: "/work" })
  await hooks["config"]!({ mcp: { "notion-server": { command: "x" } } })
  const call = { sessionID: "s", tool: "notion-server_API-get-self", callID: "c1", args: {} }
  await hooks["tool.execute.before"]!(call, { args: {} })
  await hooks["tool.execute.after"]!(call, { output: "ok" })

  const sections = fs.readFileSync(log, "utf8").trim().split("\n")
  assert.deepEqual(sections, ["mcp", "post_mcp"], `sections: ${JSON.stringify(sections)}`)
})
