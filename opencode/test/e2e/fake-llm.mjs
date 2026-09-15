// Minimal OpenAI-compatible streaming endpoint that replays a scripted list of tool calls.
// Requests without a tool list are OpenCode's title generation and get plain text back,
// otherwise the first scripted turn is silently consumed by it.
import http from "node:http"
import { appendFileSync, readFileSync } from "node:fs"

const PORT = Number(process.env.PORT ?? 18473)
const SCRIPT = JSON.parse(readFileSync(process.env.SCENARIO, "utf8")).steps

let step = 0

const USAGE = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 40 },
}

const chunk = (delta, finish, usage) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "test-model",
  choices: [{ index: 0, delta: delta ?? {}, ...(finish ? { finish_reason: finish } : {}) }],
  ...(usage ? { usage } : {}),
})
const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

http
  .createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      if (req.url.includes("/page")) {
        res.writeHead(200, { "content-type": "text/plain" })
        return void res.end("armor1 e2e fetchable page")
      }
      if (!req.url.includes("chat/completions")) return void res.writeHead(404).end("no")
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {}
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0
      if (process.env.MESSAGES_FILE && parsed.messages) {
        appendFileSync(process.env.MESSAGES_FILE, JSON.stringify(parsed.messages) + "\n")
      }

      if (!hasTools) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        send(res, chunk({ role: "assistant" }))
        send(res, chunk({ content: "Test Session" }))
        send(res, chunk({}, "stop"))
        res.write("data: [DONE]\n\n")
        return void res.end()
      }

      const s = SCRIPT[Math.min(step, SCRIPT.length - 1)]
      step++
      console.error(`[llm] step ${step}: ${s.tool ?? (s.httpError ? "http " + s.httpError : "text")}`)

      if (s.httpError) {
        res.writeHead(s.httpError, { "content-type": "application/json" })
        return void res.end(JSON.stringify({ error: { message: "armor1 e2e induced failure" } }))
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      send(res, chunk({ role: "assistant" }))

      if (s.tool) {
        send(res, chunk({ tool_calls: [{ index: 0, id: `c${step}`, type: "function", function: { name: s.tool, arguments: "" } }] }))
        send(res, chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(s.args) } }] }))
        send(res, chunk({}, "tool_calls", USAGE))
      } else {
        send(res, chunk({ content: s.text ?? "done" }))
        send(res, chunk({}, "stop", USAGE))
      }
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  .listen(PORT, "127.0.0.1", () => console.error(`[llm] listening on ${PORT}`))
