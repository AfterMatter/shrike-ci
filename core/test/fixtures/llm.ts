// Fake OpenAI compatible gateway for the pi backend tests: reads a file
// through a tool call, then answers with it and fixed token usage.
const port = Number(process.argv[2]);
const seen = process.argv[3]!;

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;

const USAGE = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 400 } };

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as { model: string; messages: { role: string; content: unknown }[] };
    await Bun.write(seen, JSON.stringify({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), model: body.model, tools: (body as { tools?: { function: { name: string } }[] }).tools?.map((tool) => tool.function.name) ?? [] }));
    const result = body.messages.find((message) => message.role === "tool");
    const events = result
      ? [chunk({ role: "assistant", content: `read: ${JSON.stringify(result.content)}` }), chunk({}, "stop"), chunk({}, null, USAGE)]
      : [
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }] }),
          chunk({}, "tool_calls"),
          chunk({}, null, USAGE),
        ];
    return new Response(`${events.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`listening on ${port}`);
