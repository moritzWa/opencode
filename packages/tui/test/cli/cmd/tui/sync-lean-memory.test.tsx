/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const directory = "/tmp/opencode/packages/opencode"
const image = "data:image/png;base64," + "A".repeat(10_000)

function session(id: string, parentID?: string) {
  return { id, parentID, title: id, time: { created: 0, updated: 0 }, version: "1.15.13", directory }
}

function assistant(sessionID: string, id: string, created: number) {
  return {
    id,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: "msg_user",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, completed: created },
  }
}

function imageRead(sessionID: string, messageID: string) {
  return {
    id: `prt_${messageID}`,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: `call_${messageID}`,
    tool: "read",
    state: {
      status: "completed" as const,
      input: { filePath: "/tmp/shot.png" },
      output: "Image read successfully",
      title: "shot.png",
      metadata: {},
      time: { start: 1, end: 2 },
      attachments: [
        { id: `prt_${messageID}_file`, sessionID, messageID, type: "file" as const, mime: "image/png", url: image },
      ],
    },
  }
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

async function mountSessions(sessions: Record<string, { parentID?: string; messages: number }>, path: string) {
  return mount((url) => {
    const [, , id, rest] = url.pathname.split("/")
    const entry = id ? sessions[id] : undefined
    if (!id || !entry) return undefined
    if (!rest) return json(session(id, entry.parentID))
    if (rest === "message") {
      const limit = Number(url.searchParams.get("limit"))
      const history = Array.from({ length: entry.messages }, (_, index) => {
        const info = assistant(id, `msg_${id}_${String(index).padStart(3, "0")}`, index)
        return { info, parts: [imageRead(id, info.id)] }
      })
      return json(history.slice(-limit))
    }
    if (rest === "todo" || rest === "diff") return json([])
    return undefined
  }, path)
}

test("events for a session this client has not loaded are not kept", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mountSessions({}, tmp.path)

  try {
    sync.session.track("ses_open")
    const other = assistant("ses_other", "msg_other", 1)
    emit(global({ id: "evt_other", type: "message.updated", properties: { sessionID: "ses_other", info: other } }))
    emit(
      global({
        id: "evt_other_part",
        type: "message.part.updated",
        properties: { sessionID: "ses_other", time: 1, part: imageRead("ses_other", "msg_other") },
      }),
    )
    const open = assistant("ses_open", "msg_open", 1)
    emit(global({ id: "evt_open", type: "message.updated", properties: { sessionID: "ses_open", info: open } }))
    emit(
      global({
        id: "evt_open_part",
        type: "message.part.updated",
        properties: { sessionID: "ses_open", time: 1, part: imageRead("ses_open", "msg_open") },
      }),
    )
    await wait(() => sync.data.part["msg_open"]?.length === 1)

    expect(sync.data.message["ses_other"]).toBeUndefined()
    expect(sync.data.part["msg_other"]).toBeUndefined()
    const part = sync.data.part["msg_open"][0]
    expect(part.type === "tool" && part.state.status === "completed" && part.state.attachments?.[0]).toMatchObject({
      mime: "image/png",
      url: "",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("opening more sessions drops the oldest but keeps the subagents of those still kept", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, sync } = await mountSessions(
    {
      ses_a: { messages: 30 },
      ses_b: { messages: 30 },
      ses_b_child: { parentID: "ses_b", messages: 5 },
      ses_c: { messages: 30 },
      ses_d: { messages: 30 },
      ses_e: { messages: 30 },
    },
    tmp.path,
  )

  try {
    await sync.session.sync("ses_a", { firstPage: true })
    await sync.session.sync("ses_b", { firstPage: true })
    await sync.session.sync("ses_b_child")
    const part = sync.data.part["msg_ses_a_029"]?.[0]
    expect(part?.type === "tool" && part.state.status === "completed" && part.state.attachments?.[0].url).toBe("")
    expect(sync.session.partial("ses_a")).toBe(true)

    await sync.session.sync("ses_c", { firstPage: true })
    await sync.session.sync("ses_d", { firstPage: true })
    await sync.session.sync("ses_e", { firstPage: true })

    expect(sync.data.message["ses_a"]).toBeUndefined()
    expect(sync.data.part["msg_ses_a_029"]).toBeUndefined()
    expect(sync.session.partial("ses_a")).toBe(false)
    expect(sync.data.message["ses_b"]?.length).toBe(20)
    expect(sync.data.message["ses_b_child"]?.length).toBe(5)
    expect(sync.data.message["ses_e"]?.length).toBe(20)
  } finally {
    app.renderer.destroy()
  }
})

test("a first page that holds the whole session leaves nothing older to load", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, sync } = await mountSessions({ ses_short: { messages: 3 } }, tmp.path)

  try {
    await sync.session.sync("ses_short", { firstPage: true })
    expect(sync.data.message["ses_short"]?.length).toBe(3)
    expect(sync.session.partial("ses_short")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("a directory reload leaves the provider catalog to the dialogs that list it", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let catalogRequests = 0
  const { app, sync } = await mount((url) => {
    if (url.pathname !== "/provider") return undefined
    catalogRequests++
    return json({ all: [{ id: "acme", name: "Acme", env: [], models: {} }], default: {}, connected: ["acme"] })
  }, tmp.path)

  try {
    await sync.bootstrap()
    expect(catalogRequests).toBe(0)
    expect(sync.data.provider_next.all).toHaveLength(0)

    await Promise.all([sync.providerCatalog(), sync.providerCatalog()])
    expect(catalogRequests).toBe(1)
    expect(sync.data.provider_next.connected).toEqual(["acme"])

    await sync.bootstrap()
    await sync.providerCatalog()
    expect(catalogRequests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})
