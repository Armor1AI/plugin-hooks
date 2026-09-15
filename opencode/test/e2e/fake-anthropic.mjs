// Fake Anthropic Messages API. Exists purely to prove cache_creation_input_tokens reaches
// the adapter: the OpenAI-compatible wire format has no cache-write concept, so that
// counter can only be exercised through a provider that speaks Anthropic's protocol.
import http from "node:http"

const PORT = Number(process.env.PORT ?? 18474)
const USAGE_START = {
  input_tokens: 100,
  cache_creation_input_tokens: 60,
  cache_read_input_tokens: 40,
  output_tokens: 1,
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

http
  .createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      if (!req.url.includes("/messages")) return void res.writeHead(404).end("no")
      console.error("[anthropic] request")

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      sse(res, "message_start", {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-fake",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: USAGE_START,
        },
      })
      sse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      })
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 })
      sse(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      })
      sse(res, "message_stop", { type: "message_stop" })
      res.end()
    })
  })
  .listen(PORT, "127.0.0.1", () => console.error(`[anthropic] listening on ${PORT}`))
