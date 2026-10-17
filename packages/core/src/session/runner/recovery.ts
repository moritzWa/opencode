export * as SessionRunnerRecovery from "./recovery.js"

import type { SessionRecovery } from "@opencode/plugin/effect/session"
import { and, desc, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Bus } from "../../bus.js"
import { Database } from "../../database/database.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessageTable } from "../sql.js"
import { SessionSchema } from "../schema.js"

/** Recovery belongs to the existing process-local drain. There is no detached
 * event listener, timer, outbox dispatcher, abort, or second execution owner. */
export const make = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const hooks = yield* PluginHooks.Service
  const userMessageID = Effect.fn("SessionRunnerRecovery.userMessageID")(function* (sessionID: SessionSchema.ID) {
    const row = yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    return row?.id
  })
  const recover = Effect.fn("SessionRunnerRecovery.recover")(function* (input: Omit<SessionRecovery, "decision">) {
    if (!(yield* hooks.has("session", "recovery", input.model.providerID))) return false
    const previous = yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, input.sessionID),
          eq(SessionMessageTable.type, "synthetic"),
          sql`json_extract(${SessionMessageTable.data}, '$.metadata.recovery.userMessageID') = ${input.userMessageID}`,
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (previous) return false
    const event: SessionRecovery = { ...input }
    yield* hooks.trigger("session", "recovery", event)
    if (!event.decision) return false
    // This checkpoint observes a user interrupt received while policy awaited
    // provider inventory. A cancelled drain never dispatches a later recovery.
    yield* Effect.yieldNow
    if ((yield* userMessageID(input.sessionID)) !== input.userMessageID) return false
    const decision = event.decision
    if (decision.model.providerID === input.model.providerID && decision.model.id === input.model.id) return false
    yield* bus.publishAll([
      [SessionEvent.ModelSelected, { sessionID: input.sessionID, model: decision.model, previous: input.model }],
      [
        SessionEvent.Synthetic,
        {
          sessionID: input.sessionID,
          text: "The previous model could not continue. Continue the outstanding request from the recorded history without repeating completed content or tools.",
          description: `Model recovery: ${input.model.providerID}/${input.model.id} → ${decision.model.providerID}/${decision.model.id}`,
          metadata: {
            recovery: {
              userMessageID: input.userMessageID,
              assistantMessageID: input.assistantMessageID,
              reason: decision.reason,
            },
          },
        },
      ],
    ])
    // publishAll is one DB transaction: a crash observes both model and marker
    // or neither. Existing execution restart claims resume the recorded history.
    return true
  })
  return { recover, userMessageID }
})
