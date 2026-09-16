import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveMcpTool, sanitize, scanPatch } from "../src/normalize.ts"

// MCP tool ids

test("sanitize matches OpenCode's rule", () => {
  assert.equal(sanitize("my.server@1"), "my_server_1")
  assert.equal(sanitize("keep-dash_and9"), "keep-dash_and9")
})

test("resolves a configured server prefix", () => {
  const result = resolveMcpTool("github_create_issue", ["github", "linear"])
  assert.deepEqual(result, { kind: "match", server: "github", tool: "create_issue" })
})

test("resolves a server whose name needed sanitizing", () => {
  const result = resolveMcpTool("my_server_do_thing", ["my.server"])
  assert.deepEqual(result, { kind: "match", server: "my.server", tool: "do_thing" })
})

test("prefers the longest matching server prefix", () => {
  const result = resolveMcpTool("acme_prod_deploy", ["acme", "acme_prod"])
  assert.deepEqual(result, { kind: "match", server: "acme_prod", tool: "deploy" })
})

test("a dash is preserved, so dot and dash names do not collide", () => {
  const result = resolveMcpTool("my_server_run", ["my.server", "my-server"])
  assert.deepEqual(result, { kind: "match", server: "my.server", tool: "run" })
})

test("reports ambiguity when two servers sanitize identically", () => {
  const result = resolveMcpTool("my_server_run", ["my.server", "my/server"])
  assert.equal(result.kind, "ambiguous")
  if (result.kind !== "ambiguous") return
  assert.deepEqual([...result.servers].sort(), ["my.server", "my/server"])
})

test("returns none for a builtin tool", () => {
  assert.deepEqual(resolveMcpTool("todowrite", ["github"]), { kind: "none" })
})

test("does not match a bare server name with no tool suffix", () => {
  assert.deepEqual(resolveMcpTool("github_", ["github"]), { kind: "none" })
})

// Patch bodies

test("extracts add, update and delete targets", () => {
  const scan = scanPatch(
    [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+const a = 1",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n"),
  )

  assert.equal(scan.wellFormed, true)
  assert.deepEqual(scan.targets, [
    { op: "add", path: "src/new.ts" },
    { op: "update", path: "src/existing.ts" },
    { op: "delete", path: "src/gone.ts" },
  ])
})

test("attaches a move destination to the preceding update", () => {
  const scan = scanPatch(
    ["*** Begin Patch", "*** Update File: a.txt", "*** Move to: b.txt", "@@", "*** End Patch"].join("\n"),
  )
  assert.deepEqual(scan.targets, [{ op: "move", path: "a.txt", movePath: "b.txt" }])
})

test("rejects a patch without markers", () => {
  const scan = scanPatch("*** Update File: a.txt")
  assert.equal(scan.wellFormed, false)
  assert.deepEqual(scan.targets, [])
})

test("handles CRLF line endings", () => {
  const scan = scanPatch("*** Begin Patch\r\n*** Delete File: x.txt\r\n*** End Patch\r\n")
  assert.deepEqual(scan.targets, [{ op: "delete", path: "x.txt" }])
})

test("ignores headers outside the markers", () => {
  const scan = scanPatch(
    ["*** Add File: before.txt", "*** Begin Patch", "*** Add File: inside.txt", "*** End Patch", "*** Add File: after.txt"].join("\n"),
  )
  assert.deepEqual(scan.targets, [{ op: "add", path: "inside.txt" }])
})

test("skips headers with an empty path", () => {
  const scan = scanPatch(["*** Begin Patch", "*** Add File:   ", "*** End Patch"].join("\n"))
  assert.deepEqual(scan.targets, [])
})
