import { Bus } from "@opencode/core/bus"
import { Session } from "@opencode/core/session"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { missingSession } from "./session-error"

export const TuiHandler = HttpApiBuilder.group(Api, "server.tui", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const bus = yield* Bus.Service
    return handlers
      .handle(
        "tui.selectSession",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.payload.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // The selected TUI may currently be attached to another Location.
          yield* bus.publish(TuiEvent.SessionSelect, ctx.payload, { global: true })
          return true
        }),
      )
      .handle(
        "tui.executeCommand",
        Effect.fn(function* (ctx) {
          yield* bus.publish(TuiEvent.CommandExecute, ctx.payload, { global: true })
          return true
        }),
      )
  }),
)
