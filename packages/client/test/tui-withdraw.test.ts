import { expect, test } from "bun:test"
import { OpenCode } from "../src/promise/index"

test("generated Promise client exposes targeted TUI selection and explicit withdrawal acceptance", async () => {
  const requests: Request[] = []
  const client = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json(request.url.endsWith("/withdraw") ? { accepted: false } : true)
    },
  })
  const payload = { sessionID: "ses_target", client: "pane-2", targetDirectory: "/target-project" }
  expect(await client.tui.selectSession(payload)).toBe(true)
  expect(await client.tui.executeCommand({ command: "speech.pause", client: "pane-2" })).toBe(true)
  expect(await client.session.inbox.withdraw({ sessionID: "ses_target", id: "msg_pending" })).toEqual({
    accepted: false,
  })
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["POST", "/api/tui/select-session"],
    ["POST", "/api/tui/execute-command"],
    ["POST", "/api/session/ses_target/inbox/msg_pending/withdraw"],
  ])
  expect(await requests[0]?.json()).toEqual(payload)
})
