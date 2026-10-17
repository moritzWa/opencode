import { SessionMessagePage } from "@opencode/core/session/message-page"
import { Session } from "@opencode/core/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { InvalidCursorError } from "@opencode/protocol/errors"
import { failedMessageDecode, missingSession } from "./session-error"

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle("session.messages", (ctx) =>
      SessionMessagePage.list({ sessionID: ctx.params.sessionID, ...ctx.query }, session.messages).pipe(
        Effect.catchTag(
          "SessionMessagePage.InvalidCursorError",
          (error) => new InvalidCursorError({ message: error.message }),
        ),
        Effect.catchTag("Session.NotFoundError", missingSession),
        Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
      ),
    )
  }),
)
