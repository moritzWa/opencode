import { expect, test } from "bun:test"
import { InputRenderable, MarkdownRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"
import { agent, model } from "./fixture/local"

const session = {
  id: "ses_parity",
  title: "A complete terminal session title longer than forty characters, preserved verbatim",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const messages = [
  { id: "user", type: "user", text: "Needle and needle", time: { created: 0 } },
  {
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "demo", id: "model" },
    content: [
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "Needle needle\n\n- filled list" },
    ],
    finish: "stop",
    time: { created: 1, completed: 2 },
  },
]

test.each([100, 44])("find, exact occurrence navigation, and real source anchors at width %s", async (width) => {
  await using setup = await createAppFixture({
    width,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, keybinds: { "session.search": "f6" } },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({ data: messages.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      return undefined
    },
  })
  await setup.ready
  await waitForHighlightedFrame(setup, (frame) => frame.includes("filled list"))
  const find = (node: Renderable, id: string): Renderable | undefined =>
    node.id === id
      ? node
      : node
          .getChildren()
          .map((child) => find(child as Renderable, id))
          .find(Boolean)
  const source = find(setup.renderer.root, "message:assistant:part:1")
  expect(source).toBeDefined()
  expect(source?.getChildren().some((node) => node instanceof MarkdownRenderable)).toBe(true)
  expect(find(setup.renderer.root, `session:${session.id}:transcript`)).toBeDefined()
  expect(find(setup.renderer.root, `session:${session.id}:bottom`)).toBeDefined()
  expect(setup.captureCharFrame()).toContain("● filled list")
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable instanceof InputRenderable)
  await setup.mockInput.typeText("needle")
  await setup.waitForFrame((frame) => frame.includes("1/4"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("2/4"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("3/4"))
  setup.mockInput.pressArrow("up")
  await setup.waitForFrame((frame) => frame.includes("2/4"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("2/4"))
})

test.each([true, false])("double Escape restores the submitted prompt only when accepted=%s", async (accepted) => {
  const admitted = Promise.withResolvers<void>()
  const withdrawn = Promise.withResolvers<string>()
  const interrupted = Promise.withResolvers<void>()
  let submitted: { id: string; text: string } | undefined
  await using setup = await createAppFixture({
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${session.id}`)
        return json({ data: { ...session, agent: "build", model: { providerID: "provider", id: "allowed" } } })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/model") return json({ location: { directory }, data: [model("allowed")] })
      if (url.pathname === "/api/agent") return json({ location: { directory }, data: [agent("build")] })
      if (url.pathname === `/api/session/${session.id}/prompt`) {
        const body = (await request.json()) as { id: string; text: string }
        submitted = body
        admitted.resolve()
        return json({
          data: {
            id: body.id,
            sessionID: session.id,
            type: "user",
            delivery: "steer",
            payload: { text: body.text },
            time: { created: 1 },
          },
        })
      }
      if (url.pathname.endsWith("/withdraw")) {
        withdrawn.resolve(url.pathname)
        return json({ accepted })
      }
      if (url.pathname.endsWith("/interrupt")) {
        interrupted.resolve()
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  await setup.mockInput.typeText("restore this exact prompt")
  setup.mockInput.pressEnter()
  await admitted.promise
  await setup.waitForFrame(() => {
    const input = setup.renderer.currentFocusedRenderable
    return input instanceof TextareaRenderable && input.plainText === ""
  })
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  expect(await withdrawn.promise).toContain(`/inbox/${submitted?.id}/withdraw`)
  if (!accepted) await interrupted.promise
  await setup.waitForFrame(() => {
    const input = setup.renderer.currentFocusedRenderable
    return input instanceof TextareaRenderable && input.plainText === (accepted ? "restore this exact prompt" : "")
  })
})

test("targeted commands and cross-directory selection affect only the matching attached TUI", async () => {
  const target = { ...session, id: "ses_other", title: "Other directory", location: { directory: "/other/project" } }
  const fetch = (url: URL) => {
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${target.id}`) return json({ data: target })
    if (url.pathname.endsWith("/message")) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname.endsWith("/inbox")) return json({ data: [] })
    return undefined
  }
  await using first = await createAppFixture({ clientID: "first", args: { sessionID: session.id }, config: { animations: false, tabs: { mode: "off" } }, fetch })
  await using second = await createAppFixture({ clientID: "second", args: { sessionID: session.id }, config: { animations: false, tabs: { mode: "off" } }, fetch })
  await Promise.all([first.ready, second.ready])
  await waitForHighlightedFrame(first, (frame) => frame.includes("filled list"))
  await waitForHighlightedFrame(second, (frame) => frame.includes("filled list"))
  const command = {
    id: "evt_target_command",
    created: 1,
    type: "tui.command.execute" as const,
    data: { command: "session.search", client: "first" },
  }
  first.events.emit(command)
  second.events.emit(command)
  await first.waitForFrame((frame) => frame.includes("Search messages"))
  await second.renderOnce()
  expect(second.captureCharFrame()).not.toContain("Search messages")
  const select = {
    id: "evt_target_select",
    created: 2,
    type: "tui.session.select" as const,
    data: { sessionID: target.id, client: "first", targetDirectory: target.location.directory },
  }
  first.events.emit(select)
  second.events.emit(select)
  await first.waitForFrame(() => Boolean(first.renderer.root.findDescendantById(`session:${target.id}:transcript`)))
  await second.renderOnce()
  expect(second.renderer.root.findDescendantById(`session:${session.id}:transcript`)).toBeDefined()
  expect(second.renderer.root.findDescendantById(`session:${target.id}:transcript`)).toBeUndefined()
})
