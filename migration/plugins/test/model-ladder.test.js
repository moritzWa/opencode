import { expect, test } from "bun:test"
import { modelLadder } from "../server.js"

const haiku = { providerID: "anthropic", id: "claude-haiku-5-5" }
const luna = { providerID: "openai", id: "gpt-6-luna" }
const models = { "opencode-memory-recall": [haiku, luna] }
const input = (body) => ({ path: { id: "ses_fork" }, body: { agent: "opencode-memory-recall", parts: [], ...body } })

test("an exhausted plan falls through to the next model and is skipped until its cooldown ends", async () => {
  let time = 0
  const ladder = modelLadder(models, () => time, new Map())
  const tried = []
  const attempt = async (call) => {
    tried.push(call.body.model.id)
    if (call.body.model.id === "claude-haiku-5-5") throw new Error("The usage limit has been reached")
    return { data: { info: { role: "assistant" } } }
  }
  expect(await ladder(input(), attempt)).toEqual({ data: { info: { role: "assistant" } } })
  await ladder(input(), attempt)
  time = 31 * 60 * 1000
  await ladder(input(), attempt)
  expect(tried).toEqual(["claude-haiku-5-5", "gpt-6-luna", "gpt-6-luna", "claude-haiku-5-5", "gpt-6-luna"])
})

test("a quota error on the assistant message also moves down the ladder; other errors do not", async () => {
  const ladder = modelLadder(models, () => 0, new Map())
  const quota = { data: { info: { error: { type: "provider.quota", message: "The usage limit has been reached" } } } }
  const tried = []
  const result = await ladder(input(), async (call) => {
    tried.push(call.body.model.id)
    return call.body.model.id === "gpt-6-luna" ? quota : { data: { info: { role: "assistant" } } }
  })
  expect(result.data.info.role).toBe("assistant")
  await expect(ladder({ ...input(), body: { ...input().body, agent: "opencode-memory-extract-other" } }, async () => {
    throw new Error("boom")
  })).rejects.toThrow("boom")
  await expect(modelLadder(models, () => 0, new Map())(input(), async () => { throw new Error("schema mismatch") })).rejects.toThrow("schema mismatch")
})

test("an explicit model or an agent without a ladder keeps its single attempt", async () => {
  const ladder = modelLadder(models, () => 0, new Map())
  const seen = []
  await ladder(input({ model: luna }), async (call) => { seen.push(call.body.model) })
  await ladder(input({ agent: "build" }), async (call) => { seen.push(call.body.model) })
  expect(seen).toEqual([luna, undefined])
})

test("only the Session's own Location reacts to its unlocated execution events", async () => {
  const { activate } = await import("../server.js")
  const { host } = await import("./host.js")
  const seen = []
  const instance = async (directory) => {
    const fixture = host(directory, { adrafinil: false, memory: { extract: { enabled: false }, recall: { enabled: false } } })
    fixture.sessions.set("ses_cronus", { id: "ses_cronus", location: { directory: "/repo/cronus" }, time: { created: 1, updated: 1 } })
    const close = await activate(fixture.context, [() => ({ event: async ({ event }) => seen.push([directory, event.type]) })])
    return { fixture, close }
  }
  const instances = [await instance("/repo/cronus"), await instance("/repo/arca")]
  for (const item of instances) item.fixture.event({ type: "session.execution.succeeded", data: { sessionID: "ses_cronus" } })
  await Bun.sleep(50)
  for (const item of instances) await item.close()
  expect(seen.filter(([, type]) => type === "session.idle")).toEqual([["/repo/cronus", "session.idle"]])
})
