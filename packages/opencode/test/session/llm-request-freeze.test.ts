import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"

const model = {
  id: "test-model",
  providerID: "test",
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  capabilities: { temperature: false, reasoning: false, attachment: false, toolcall: true },
  options: {},
  limit: { context: 100_000, output: 8_000 },
} as any

// Stands in for a plugin that injects the live memory index (and sometimes recall) every call.
const memory = { section: "## MEMORY.md\n- note A" }
const plugin = {
  trigger: (name: string, _input: unknown, output: { system?: string[] }) =>
    Effect.sync(() => {
      if (name === "experimental.chat.system.transform") output.system?.push(memory.section)
      return output
    }),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

const prepare = (sessionID: string, messages: ModelMessage[], freezeSystem = true) =>
  Effect.runPromise(
    LLMRequestPrep.prepare({
      user: { id: "msg_user", sessionID, role: "user", time: { created: 1 }, agent: "build", model: {} } as any,
      sessionID,
      model,
      agent: { name: "build", mode: "primary", options: {}, permission: [], prompt: "base prompt" } as any,
      system: [],
      messages,
      tools: {},
      provider: { id: "test", options: {} } as any,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 8_000, client: "test" } as any,
      isWorkflow: false,
      freezeSystem,
    }),
  )

const history: ModelMessage[] = [{ role: "user", content: "first message" }]

test("freezeSystem keeps the first system prompt when live inputs change", async () => {
  memory.section = "## MEMORY.md\n- note A"
  const first = await prepare("ses_freeze", history)
  memory.section = "## MEMORY.md\n- note A, rewritten by another session"
  const second = await prepare("ses_freeze", [...history, { role: "assistant", content: "ok" }])

  expect(second.system).toEqual(first.system)
  expect(second.system.join("\n")).not.toContain("rewritten")
  expect(second.messages.at(-1)).toEqual({ role: "assistant", content: "ok" })
})

test("freezeSystem folds recalled context into the real user message", async () => {
  memory.section = "## MEMORY.md\n- note A"
  const first = await prepare("ses_recall", history)
  memory.section = "## MEMORY.md\n- note A\n\n## Recalled memories\nremember this"
  const second = await prepare("ses_recall", history)

  expect(second.system).toEqual(first.system)
  expect(second.messages.at(-1)).toEqual({
    role: "user",
    content: [
      { type: "text", text: "first message" },
      { type: "text", text: "<system-reminder>\n## Recalled memories\nremember this\n</system-reminder>" },
    ],
  })
})

test("shared index appends never replace the real user query", async () => {
  memory.section = "## MEMORY.md\n- note A"
  const first = await prepare("ses_index_append", history)
  memory.section += "\n- unrelated roommate memory"
  const messages: ModelMessage[] = [...history, { role: "assistant", content: "ok" }, { role: "user", content: "say ABC" }]
  const second = await prepare("ses_index_append", messages)
  expect(second.system).toEqual(first.system)
  expect(second.messages.filter((message) => message.role !== "system")).toEqual(
    messages.filter((message) => message.role !== "system"),
  )
  expect(second.messages.findLast((message) => message.role === "user")?.content).toBe("say ABC")
})

test("recall preserves multipart input and trailing tool results", async () => {
  memory.section = "## MEMORY.md\n- note A"
  await prepare("ses_recall_tools", history)
  memory.section += "\n- unrelated index append\n\n## Recalled Memories\nrelevant context"
  const messages: ModelMessage[] = [
    ...history,
    { role: "user", content: [{ type: "text", text: "actual query" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: {} }] },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "result" } }],
    },
  ]
  const result = await prepare("ses_recall_tools", messages)
  const actual = result.messages.filter((message) => message.role !== "system")
  expect(actual).toHaveLength(messages.length)
  expect(actual.slice(-2)).toEqual(messages.filter((message) => message.role !== "system").slice(-2))
  expect(JSON.stringify(actual[1])).toContain("actual query")
  expect(JSON.stringify(actual[1])).toContain("relevant context")
  expect(JSON.stringify(actual)).not.toContain("unrelated index append")
  expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "actual query" }] })
})

test("freezeSystem refreshes after compaction replaces the first message", async () => {
  memory.section = "## MEMORY.md\n- note A"
  await prepare("ses_compact", history)
  memory.section = "## MEMORY.md\n- note B"
  const compacted = await prepare("ses_compact", [{ role: "user", content: "summary of earlier work" }])

  expect(compacted.system.join("\n")).toContain("note B")
})

test("without freezeSystem the system prompt follows live inputs", async () => {
  memory.section = "## MEMORY.md\n- note A"
  await prepare("ses_live", history, false)
  memory.section = "## MEMORY.md\n- note B"
  const second = await prepare("ses_live", history, false)

  expect(second.system.join("\n")).toContain("note B")
})
