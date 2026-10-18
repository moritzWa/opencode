import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

const todos = [
  { content: "Old completed work", status: "completed", priority: "low" },
  { content: "Current running work", status: "in_progress", priority: "high" },
  { content: "Next pending work", status: "pending", priority: "medium" },
  { content: "Cancelled approach", status: "cancelled", priority: "low" },
]
const session = {
  id: "ses_todo",
  title: "Todo parity",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const tool = (id: string, name: string, input: Record<string, unknown>, metadata = {}) => ({
  type: "tool",
  id,
  name,
  state: { status: "completed", input, metadata, content: [{ type: "text", text: "Completed" }] },
})

test.each([100, 44])(
  "historical TodoWrite is a native checklist and preserves ordinary read/write cards at width %s",
  async (width) => {
    const message = {
      id: "msg_historical_todos",
      type: "assistant",
      agent: "build",
      model: { providerID: "openai", id: "model" },
      content: [
        tool("read_before", "read", { path: "before.ts" }),
        tool("legacy_todo", "todowrite", { todos }, { todos }),
        tool("write_after", "write", { path: "after.ts", content: "export const after = true" }),
        tool("clear_todo", "todowrite", { todos: [] }, { todos: [] }),
      ],
      time: { created: 1, completed: 2 },
      finish: "stop",
    }
    await using setup = await createAppFixture({
      width,
      height: 42,
      args: { sessionID: session.id },
      config: {
        animations: false,
        tabs: { mode: "off" },
        session: { sidebar: "hide", grouping: "none", verbosity: "high" },
      },
      fetch: (url) => {
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname.endsWith("/message")) return json({ data: [message], cursor: {} })
        if (url.pathname.endsWith("/inbox")) return json({ data: [] })
        return undefined
      },
    })
    await setup.ready
    await waitForHighlightedFrame(setup, (frame) => frame.includes("Todo list cleared") && frame.includes("after.ts"))
    const frame = setup.captureCharFrame()
    expect(frame.match(/# Todos/g)).toHaveLength(2)
    expect(frame).toContain("[✓] Old completed work")
    expect(frame).toContain("[•] Current running work")
    expect(frame).toContain("[ ] Next pending work")
    expect(frame).toContain("[ ] Cancelled approach")
    expect(frame).toContain("before.ts")
    expect(frame).toContain("after.ts")
    expect(frame).not.toContain("todos=[object")
  },
)

const plugin = process.env.OPENCODE_TODO_PLUGIN
test.skipIf(!plugin)(
  "portable sidebar collapses, follows Session selection and refetches on reconnect without stale overwrite",
  async () => {
    const other = { ...session, id: "ses_other_todo" }
    const states = new Map([
      [session.id, { sessionID: session.id, todos, revision: 0 }],
      [
        other.id,
        {
          sessionID: other.id,
          todos: [{ content: "Other Session only", status: "pending", priority: "high" }],
          revision: 0,
        },
      ],
    ])
    let gets = 0
    const recovered = Promise.withResolvers<void>()
    await using setup = await createAppFixture({
      width: 140,
      height: 35,
      args: { sessionID: session.id },
      config: { animations: false, tabs: { mode: "off" }, plugins: [plugin ?? ""] },
      fetch: async (url, request) => {
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${other.id}`) return json({ data: other })
        if (url.pathname.endsWith("/message") || url.pathname.endsWith("/inbox")) return json({ data: [], cursor: {} })
        if (url.pathname === "/api/rpc/moritz-todo/get") {
          gets++
          const input = (await request.json()) as { input: { sessionID: string } }
          const state = states.get(input.input.sessionID)
          if (state?.revision === 3) recovered.resolve()
          return json({ output: state })
        }
        return undefined
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Current running work"))
    const rows = setup.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes("▼ Todo"))
    const x = rows[y].indexOf("Todo")
    await setup.mockMouse.click(x, y)
    await setup.waitForFrame((frame) => !frame.includes("Current running work"))
    await setup.mockMouse.click(x, y)
    await setup.waitForFrame((frame) => frame.includes("Current running work"))
    setup.events.emit({
      id: "evt_select_other_todo",
      created: 1,
      type: "tui.session.select",
      data: { sessionID: other.id, targetDirectory: directory },
    })
    await setup.waitForFrame((frame) => frame.includes("Other Session only") && !frame.includes("Current running work"))
    const changed = {
      sessionID: other.id,
      todos: [{ content: "Live RPC update", status: "in_progress", priority: "high" }],
      revision: 2,
    }
    states.set(other.id, changed)
    setup.events.emit({
      id: "evt_todos_changed",
      created: 2,
      type: "rpc.moritz-todo.changed",
      location: { directory },
      data: changed,
    })
    await setup.waitForFrame((frame) => frame.includes("Live RPC update"))
    setup.events.emit({
      id: "evt_stale_todos",
      created: 3,
      type: "rpc.moritz-todo.changed",
      location: { directory },
      data: { ...changed, todos: [], revision: 1 },
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Live RPC update")
    states.set(other.id, {
      ...changed,
      todos: [{ content: "Recovered after reconnect", status: "pending", priority: "medium" }],
      revision: 3,
    })
    setup.events.disconnect()
    await recovered.promise
    await setup.waitForFrame((frame) => frame.includes("Recovered after reconnect"))
    expect(gets).toBeGreaterThanOrEqual(3)
    states.set(other.id, { ...changed, todos: [], revision: 4 })
    setup.events.emit({
      id: "evt_clear_todos",
      created: 4,
      type: "rpc.moritz-todo.changed",
      location: { directory },
      data: { ...changed, todos: [], revision: 4 },
    })
    await setup.waitForFrame((frame) => !frame.includes("Recovered after reconnect"))
  },
)
