import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionID } from "../src/session-id.js"
import { TuiEvent } from "../src/tui-event.js"

test("session selection preserves targeting and omits undefined optional fields", () => {
  const sessionID = SessionID.create()
  const encode = Schema.encodeSync(TuiEvent.SessionSelect.data)
  expect(encode({ sessionID, client: undefined, targetDirectory: undefined })).toEqual({ sessionID })
  const input = { sessionID, client: "pane-2", targetDirectory: "/target-project" }
  expect(encode(Schema.decodeUnknownSync(TuiEvent.SessionSelect.data)(input))).toEqual(input)
})

test("TUI commands support a target while retaining untargeted event producers", () => {
  const encode = Schema.encodeSync(TuiEvent.CommandExecute.data)
  expect(encode({ command: "speech.pause", client: undefined })).toEqual({ command: "speech.pause" })
  expect(encode({ command: "speech.pause", client: "pane-2" })).toEqual({ command: "speech.pause", client: "pane-2" })
})
