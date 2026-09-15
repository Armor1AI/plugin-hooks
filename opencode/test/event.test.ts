import { test } from "node:test"
import assert from "node:assert/strict"
import { build, buildAfter, buildError, buildPrompt, buildSessionStart, buildStop, classify, classifyAfter } from "../src/event.ts"

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("maps the five enforcement surfaces", () => {
  assert.deepEqual(classify("bash", []), { kind: "builtin", section: "command_execution" })
  assert.deepEqual(classify("read", []), { kind: "builtin", section: "file_access_read" })
  assert.deepEqual(classify("write", []), { kind: "builtin", section: "file_access_write" })
  assert.deepEqual(classify("edit", []), { kind: "builtin", section: "file_access_write" })
  assert.deepEqual(classify("apply_patch", []), { kind: "builtin", section: "file_access_write" })
  assert.deepEqual(classify("webfetch", []), { kind: "builtin", section: "network_access" })
  assert.deepEqual(classify("websearch", []), { kind: "builtin", section: "network_access" })
})

test("ignores tools with no policy surface in phase 1", () => {
  for (const tool of ["glob", "grep", "todowrite", "task", "skill", "lsp", "question"]) {
    assert.deepEqual(classify(tool, []), { kind: "none" }, tool)
  }
})

test("classifies MCP tools when the server is configured", () => {
  const result = classify("github_create_issue", ["github"])
  assert.equal(result.kind, "mcp")
})

test("a builtin name always wins over an MCP prefix", () => {
  const result = classify("read", ["read"])
  assert.deepEqual(result, { kind: "builtin", section: "file_access_read" })
})

const after = (tool: string, servers: string[] = []) => {
  const result = classifyAfter(tool, servers)
  return result.kind === "none" ? undefined : result.section
}

test("after-phase mapping covers the post sections", () => {
  assert.equal(after("bash"), "post_shell_execution")
  assert.equal(after("write"), "post_write_file")
  assert.equal(after("edit"), "post_write_file")
  assert.equal(after("apply_patch"), "post_write_file")
  assert.equal(after("webfetch"), "post_network_access")
  assert.equal(after("websearch"), "post_network_access")
})

test("read has no post section, matching Claude Code", () => {
  assert.equal(after("read"), undefined)
})

test("mcp tools map to post_mcp when the server is configured", () => {
  assert.equal(after("github_create_issue", ["github"]), "post_mcp")
  assert.equal(after("github_create_issue"), undefined)
})

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

const ctx = { tool: "bash", sessionID: "ses_1", turnID: "msg_1", callID: "call_1", cwd: "/work" }

test("command payload carries the command", () => {
  const result = build(ctx, classify("bash", []), { command: "rm -rf /" })
  assert.equal(result?.payloads.length, 1)
  assert.deepEqual(result?.payloads[0]?.tool_input, { command: "rm -rf /" })
  assert.equal(result?.payloads[0]?.armor1.section, "command_execution")
})

test("read payload resolves a relative path against cwd", () => {
  const result = build({ ...ctx, tool: "read" }, classify("read", []), { filePath: "sub/.env" })
  assert.deepEqual(result?.payloads[0]?.tool_input, { file_path: "/work/sub/.env" })
})

test("apply_patch expands to one payload per target", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "+x",
    "*** Delete File: b.txt",
    "*** End Patch",
  ].join("\n")
  const result = build({ ...ctx, tool: "apply_patch" }, classify("apply_patch", []), { patchText })

  assert.equal(result?.payloads.length, 2)
  assert.deepEqual(
    result?.payloads.map((p) => p.tool_input),
    [{ file_path: "/work/a.txt" }, { file_path: "/work/b.txt" }],
  )
  assert.equal(result?.payloads[0]?.armor1.patch_op, "add")
  assert.equal(result?.payloads[1]?.armor1.patch_op, "delete")
  assert.equal(result?.payloads[0]?.armor1.patch_total, 2)
})

test("a move produces payloads for both source and destination", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Update File: old.txt",
    "*** Move to: new.txt",
    "*** End Patch",
  ].join("\n")
  const result = build({ ...ctx, tool: "apply_patch" }, classify("apply_patch", []), { patchText })

  assert.deepEqual(
    result?.payloads.map((p) => p.tool_input),
    [{ file_path: "/work/old.txt" }, { file_path: "/work/new.txt" }],
  )
})

test("a malformed patch yields no targets and raises a signal", () => {
  const result = build({ ...ctx, tool: "apply_patch" }, classify("apply_patch", []), {
    patchText: "garbage",
  })
  assert.deepEqual(result?.payloads, [])
  assert.deepEqual(result?.signals, ["patch_unparseable"])
})

test("mcp payload carries the resolved server", () => {
  const result = build(
    { ...ctx, tool: "github_create_issue" },
    classify("github_create_issue", ["github"]),
    { title: "x" },
  )
  assert.deepEqual(result?.payloads[0]?.armor1.mcp, { server: "github", tool: "create_issue" })
})

test("webfetch payload carries the url", () => {
  const result = build({ ...ctx, tool: "webfetch" }, classify("webfetch", []), {
    url: "https://example.com",
  })
  assert.deepEqual(result?.payloads[0]?.tool_input, { url: "https://example.com" })
})

test("every payload carries session and turn ids", () => {
  const result = build(ctx, classify("bash", []), { command: "ls" })
  assert.equal(result?.payloads[0]?.session_id, "ses_1")
  assert.equal(result?.payloads[0]?.turn_id, "msg_1")
  assert.equal(result?.payloads[0]?.hook_event_name, "PreToolUse")
})

test("post_shell_execution mirrors the pre-hook command", () => {
  const result = buildAfter(ctx, "post_shell_execution", { command: "echo hi" })
  assert.equal(result.payloads.length, 1)
  assert.equal(result.payloads[0]?.hook_event_name, "PostToolUse")
  assert.deepEqual(result.payloads[0]?.tool_input, { command: "echo hi" })
})

test("post_write_file carries the fields the diff size is derived from", () => {
  const result = buildAfter({ ...ctx, tool: "edit" }, "post_write_file", {
    filePath: "/work/a.ts",
    oldString: "before",
    newString: "after",
  })
  assert.deepEqual(result.payloads[0]?.tool_input, {
    file_path: "/work/a.ts",
    old_string: "before",
    new_string: "after",
  })
})

test("post_write_file on write carries content", () => {
  const result = buildAfter({ ...ctx, tool: "write" }, "post_write_file", {
    filePath: "/work/a.ts",
    content: "body",
  })
  assert.deepEqual(result.payloads[0]?.tool_input, { file_path: "/work/a.ts", content: "body" })
})

test("post_write_file expands a patch the same way the pre-hook does", () => {
  const patchText = ["*** Begin Patch", "*** Add File: a.txt", "+x", "*** Delete File: b.txt", "*** End Patch"].join("\n")
  const pre = build({ ...ctx, tool: "apply_patch" }, classify("apply_patch", []), { patchText })
  const post = buildAfter({ ...ctx, tool: "apply_patch" }, "post_write_file", { patchText })
  assert.deepEqual(
    post.payloads.map((p) => p.tool_input),
    pre?.payloads.map((p) => p.tool_input),
  )
  assert.equal(post.payloads[0]?.hook_event_name, "PostToolUse")
})

test("post_network_access distinguishes fetch from search", () => {
  const fetched = buildAfter({ ...ctx, tool: "webfetch" }, "post_network_access", { url: "https://a.test" })
  assert.deepEqual(fetched.payloads[0]?.tool_input, { url: "https://a.test" })
  assert.equal(fetched.payloads[0]?.tool_name, "webfetch")

  const searched = buildAfter({ ...ctx, tool: "websearch" }, "post_network_access", { query: "cats" })
  assert.deepEqual(searched.payloads[0]?.tool_input, { query: "cats" })
  assert.equal(searched.payloads[0]?.tool_name, "websearch")
})

test("prompt payload", () => {
  const p = buildPrompt({ sessionID: "ses_1", turnID: "msg_1", cwd: "/work" }, "hello there")
  assert.equal(p.hook_event_name, "UserPromptSubmit")
  assert.equal(p.prompt, "hello there")
  assert.equal(p.armor1.section, "before_submit_prompt")
})

test("error payload", () => {
  const p = buildError({ sessionID: "ses_1", turnID: "", cwd: "/work" }, "ProviderAuthError", "bad key")
  assert.equal(p.hook_event_name, "StopFailure")
  assert.equal(p.error, "ProviderAuthError")
  assert.equal(p.error_details, "bad key")
})

test("session_start carries model and agent, with mode left empty", () => {
  const p = buildSessionStart({ sessionID: "ses_1", turnID: "msg_1", cwd: "/work" }, "opencode/big-pickle", "build")
  assert.equal(p.hook_event_name, "SessionStart")
  assert.equal(p.model, "opencode/big-pickle")
  assert.equal(p.agent, "build")
  assert.equal(p.mode, "")
  assert.equal(p.cwd, "/work")
  assert.equal(p.armor1.section, "session_start")
})

test("stop always reports completed, matching Claude Code's vocabulary", () => {
  // Claude Code emits "completed" or "retry" here, and "failed" lives in stopFailure.
  // OpenCode has no retry signal, so any other value would be an invention.
  const p = buildStop({ sessionID: "ses_1", turnID: "msg_1", cwd: "/work" })
  assert.equal(p.status, "completed")
  assert.equal(p.hook_event_name, "Stop")
  assert.equal(p.armor1.section, "stop")
})

test("file path is read defensively across naming variants", () => {
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const result = build({ ...ctx, tool: "read" }, classify("read", []), { [key]: "/work/a.env" })
    assert.deepEqual(result?.payloads[0]?.tool_input, { file_path: "/work/a.env" }, key)
  }
})

test("patch text is read defensively across naming variants", () => {
  const patch = ["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch"].join("\n")
  for (const key of ["patchText", "patch", "diff"]) {
    const result = build({ ...ctx, tool: "apply_patch" }, classify("apply_patch", []), { [key]: patch })
    assert.equal(result?.payloads.length, 1, key)
    assert.deepEqual(result?.payloads[0]?.tool_input, { file_path: "/work/gone.txt" }, key)
  }
})

test("command and edit strings are read defensively", () => {
  assert.deepEqual(build(ctx, classify("bash", []), { cmd: "ls" })?.payloads[0]?.tool_input, { command: "ls" })
  const edited = build({ ...ctx, tool: "edit" }, classify("edit", []), {
    file_path: "/work/a.ts",
    old_string: "a",
    new_string: "b",
  })
  assert.deepEqual(edited?.payloads[0]?.tool_input, {
    file_path: "/work/a.ts",
    old_string: "a",
    new_string: "b",
  })
})

test("an empty string does not mask a later valid key", () => {
  const result = build({ ...ctx, tool: "read" }, classify("read", []), { filePath: "", path: "/work/real.txt" })
  assert.deepEqual(result?.payloads[0]?.tool_input, { file_path: "/work/real.txt" })
})

test("a write with no recognisable path yields no payload rather than an empty one", () => {
  const result = build({ ...ctx, tool: "write" }, classify("write", []), { somethingElse: 1 })
  assert.deepEqual(result?.payloads, [])
})
