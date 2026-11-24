import { Effect, Schema } from "effect"
import { Global } from "@opencode/util/global"
import { Database } from "../src/database/database"
import { SessionStore } from "../src/session/store"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { sql } from "drizzle-orm"
import path from "node:path"
import { realpathSync } from "node:fs"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"

if (!process.argv[2]) throw new Error("Pass the directory containing the verified backup and before.json")
const root = path.resolve(process.argv[2])
if (process.env.OPENCODE_DB !== `${root}/candidate.db`) throw new Error("Only the validation copy may be opened")
const before = Schema.decodeUnknownSync(
  Schema.Struct({
    source: Schema.String,
    candidate: Schema.String,
    counts: Schema.Struct({ session_message: Schema.Number }),
  }),
)(await Bun.file(path.join(root, "before.json")).json())
if (
  realpathSync(before.candidate) !== realpathSync(`${root}/candidate.db`) ||
  realpathSync(before.source) === realpathSync(before.candidate)
)
  throw new Error("Backup provenance does not identify an isolated copy")
const global = Global.layerWith({
  config: `${root}/config`,
  data: `${root}/data`,
  cache: `${root}/cache`,
  state: `${root}/state`,
  tmp: `${root}/tmp`,
  bin: `${root}/bin`,
  log: `${root}/log`,
  repos: `${root}/repos`,
})
// Build only Database. A full server would resume copied execution claims and could run tools.
await Effect.gen(function* () {
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const ids = yield* database.db.all<{ id: string }>(sql`SELECT id FROM session_v2 ORDER BY time_updated DESC`)
  const decoded = yield* Effect.forEach(
    ids,
    (row) =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make(row.id)
        if (!(yield* store.get(sessionID))) throw new Error("Session disappeared during upgrade validation")
        let count = 0
        let cursor: SessionMessage.ID | undefined
        while (true) {
          const page = yield* store.messagesWithRefs({
            sessionID,
            limit: 500,
            order: "asc",
            cursor: cursor ? { id: cursor, direction: "next" } : undefined,
          })
          const last = page.at(-1)
          if (!last) return count
          count += page.length
          cursor = last.id
        }
      }),
    { concurrency: 1 },
  )
  yield* Effect.forEach(ids.slice(0, 20), (row) => store.context(Session.ID.make(row.id)), { concurrency: 1 })
  const messages = decoded.reduce((sum, count) => sum + count, 0)
  if (messages !== before.counts.session_message) throw new Error("Decoded message total differs from the backup")
  yield* database.db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  yield* Effect.promise(() =>
    Bun.write(
      `${root}/decode.json`,
      JSON.stringify(
        {
          sessions: ids.length,
          messages,
          coverage: "all-message-pages",
          contexts: Math.min(ids.length, 20),
        },
        null,
        2,
      ),
    ),
  )
  console.log("Candidate Database layer migrated the isolated copy and checkpointed it")
}).pipe(
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node]), [
      Database.node.replace(Database.configured({ path: `${root}/candidate.db` })),
      Global.node.replace(global),
    ]),
  ),
  Effect.scoped,
  Effect.runPromise,
)
