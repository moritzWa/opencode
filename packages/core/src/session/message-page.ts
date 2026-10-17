export * as SessionMessagePage from "./message-page.js"

import { Effect, Schema } from "effect"
import { SessionMessage } from "./message.js"
import type { MessagesInput } from "./store.js"

export type Input = Omit<MessagesInput, "cursor"> & { cursor?: string }

export class InvalidCursorError extends Schema.TaggedError<InvalidCursorError>()(
  "SessionMessagePage.InvalidCursorError",
  {
    message: Schema.String,
  },
) {}

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Literals(["asc", "desc"]),
  direction: Schema.Literals(["previous", "next"]),
})
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))
const encodeCursor = (message: SessionMessage.Info, order: "asc" | "desc", direction: "previous" | "next") =>
  Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")

/** Raw projected history, including pre-compaction messages and unsettled assistant output. */
export const list = Effect.fn("SessionMessagePage.list")(function* <E, R>(
  input: Input,
  messages: (input: MessagesInput) => Effect.Effect<SessionMessage.Info[], E, R>,
) {
  if (input.cursor && input.order !== undefined)
    return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
  const decoded = input.cursor
    ? yield* decodeCursor(Buffer.from(input.cursor, "base64url").toString("utf8")).pipe(
        Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
      )
    : undefined
  const order = decoded?.order ?? input.order ?? "desc"
  const data = yield* messages({
    sessionID: input.sessionID,
    limit: input.limit ?? 50,
    order,
    type: input.type,
    cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
  })
  const first = data[0]
  const last = data.at(-1)
  return {
    data,
    cursor: {
      previous: first ? encodeCursor(first, order, "previous") : undefined,
      next: last ? encodeCursor(last, order, "next") : undefined,
    },
  }
})
