import { TuiEvent } from "@opencode/schema/tui-event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { SessionNotFoundError } from "../errors.js"

export const TuiGroup = HttpApiGroup.make("server.tui")
  .add(
    HttpApiEndpoint.post("tui.selectSession", "/api/tui/select-session", {
      payload: TuiEvent.SessionSelect.data,
      success: Schema.Boolean,
      error: SessionNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "tui.selectSession",
        summary: "Select a TUI session",
        description:
          "Publish a global session selection event. Supply client to target one attached TUI and targetDirectory to move it across directories before navigation.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("tui.executeCommand", "/api/tui/execute-command", {
      payload: Schema.Struct({ command: TuiEvent.CommandExecute.data.fields.command, client: Schema.String }),
      success: Schema.Boolean,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "tui.executeCommand",
        summary: "Execute a targeted TUI command",
        description: "Publish a global command event for one attached TUI identified by client.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "tui" }))
