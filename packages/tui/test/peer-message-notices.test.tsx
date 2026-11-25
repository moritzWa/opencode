import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test("peer messages collapse to one line and expand on click", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const session = {
    id: "ses_peer",
    title: "Peer messages",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const header = '[from another agent, not the user: "dashboard hover tooltip [ses_abc]" @ /Users/m/Code/data-leads; reply with send_message to="session-1"]'
  const messages = [
    { id: "user-0", type: "user", text: "Check the calendar", time: { created: 0 } },
    {
      id: "peer-0",
      type: "synthetic",
      text: "peer",
      description: `${header}\nNo Thursday conflict reported.\nSecond line of the report.`,
      metadata: { peerMessage: { version: 2, messageId: "m1" } },
      time: { created: 1 },
    },
    {
      id: "notice-0",
      type: "synthetic",
      text: "plain",
      description: "Plain notice stays as it is",
      metadata: {},
      time: { created: 2 },
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { mode: "off" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("From dashboard hover tooltip"))
    await setup.waitForVisualIdle()
    const collapsed = setup.captureCharFrame()
    expect(collapsed).toContain("From dashboard hover tooltip: No Thursday conflict reported.")
    expect(collapsed).not.toContain("from another agent")
    expect(collapsed).not.toContain("ses_abc")
    expect(collapsed).not.toContain("Second line of the report.")
    expect(collapsed).toContain("Plain notice stays as it is")

    const lines = collapsed.split("\n")
    const y = lines.findIndex((line) => line.includes("From dashboard hover tooltip"))
    await setup.mockMouse.click(lines[y].indexOf("From") + 1, y)
    await setup.waitForFrame((frame) => frame.includes("Second line of the report."))
    expect(setup.captureCharFrame()).toContain("No Thursday conflict reported.")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
