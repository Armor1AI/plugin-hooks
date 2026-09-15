// Minimal stdio MCP server for e2e. Newline-delimited JSON-RPC 2.0, no dependencies.
// Registered under a server name containing a dot so the adapter's sanitize and
// longest-prefix resolution are exercised.
import readline from "node:readline"

const TOOLS = [
  { name: "echo_text", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "delete_thing", description: "Pretend to delete something", inputSchema: { type: "object", properties: { target: { type: "string" }, force: { type: "boolean" } }, required: ["target"] } },
]

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
const reply = (id, result) => send({ jsonrpc: "2.0", id, result })

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // notification

  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "armor1-e2e-mcp", version: "0.1.0" },
      })
    case "tools/list":
      return reply(msg.id, { tools: TOOLS })
    case "tools/call": {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      if (name === "echo_text") {
        return reply(msg.id, { content: [{ type: "text", text: `echoed: ${args.text ?? ""}` }] })
      }
      if (name === "delete_thing") {
        return reply(msg.id, { content: [{ type: "text", text: `deleted ${args.target ?? ""}` }] })
      }
      return reply(msg.id, { content: [{ type: "text", text: "unknown tool" }], isError: true })
    }
    case "ping":
      return reply(msg.id, {})
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
  }
})
