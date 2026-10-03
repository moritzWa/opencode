export * as TuiEvent from "./tui-event"

import { Effect, Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { PositiveInt } from "./schema"
import { SessionID } from "./session-id"

const DEFAULT_TOAST_DURATION = 5000

export const PromptAppend = Event.define({ type: "tui.prompt.append", schema: { text: Schema.String } })

export const CommandExecute = Event.define({
  type: "tui.command.execute",
  schema: {
    command: Schema.Union([
      Schema.Literals([
        "session.list",
        "session.new",
        "session.share",
        "session.interrupt",
        "session.compact",
        "session.page.up",
        "session.page.down",
        "session.line.up",
        "session.line.down",
        "session.half.page.up",
        "session.half.page.down",
        "session.first",
        "session.last",
        "prompt.clear",
        "prompt.submit",
        "agent.cycle",
      ]),
      Schema.String,
    ]),
  },
})

export const ToastShow = Event.define({
  type: "tui.toast.show",
  schema: {
    title: optional(Schema.String),
    message: Schema.String,
    variant: Schema.Literals(["info", "success", "warning", "error"]),
    duration: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TOAST_DURATION))).annotate({
      description: "Duration in milliseconds",
    }),
  },
})

export const SessionSelect = Event.define({
  type: "tui.session.select",
  schema: {
    sessionID: SessionID.annotate({ description: "Session ID to navigate to" }),
    client: optional(
      Schema.String.annotate({
        description: "Only the TUI started with this --client id navigates. Omit to navigate every attached TUI.",
      }),
    ),
    targetDirectory: optional(
      Schema.String.annotate({
        description:
          "Directory to move the TUI to before showing the session, reloading its agents, commands, and file search. Omit to keep the TUI's directory.",
      }),
    ),
  },
})

export const Definitions = Event.inventory(PromptAppend, CommandExecute, ToastShow, SessionSelect)
