import { expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("withdraws admitted input and returns explicit acceptance, rejection, and session errors", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: ":memory:" },
        config: { project: false, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [Global.node.replace(tempGlobalLayer), Config.node.replace(Config.testLayer())] },
    )
    const post = (path: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )
    const created = yield* post("/api/session", { location: { directory: directory.path } })
    expect(created.status).toBe(200)
    const sessionID = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
      yield* Effect.promise(() => created.json()),
    ).data.id
    const id = SessionMessage.ID.create()
    const admitted = yield* post(`/api/session/${sessionID}/prompt`, { id, text: "Edit me", resume: false })
    expect(admitted.status).toBe(200)
    const withdrawn = yield* post(`/api/session/${sessionID}/inbox/${id}/withdraw`)
    expect(withdrawn.status).toBe(200)
    expect(yield* Effect.promise(() => withdrawn.json())).toEqual({ accepted: true })
    const repeated = yield* post(`/api/session/${sessionID}/inbox/${id}/withdraw`)
    expect(repeated.status).toBe(200)
    expect(yield* Effect.promise(() => repeated.json())).toEqual({ accepted: false })
    const missingID = Session.ID.create()
    const missing = yield* post(`/api/session/${missingID}/inbox/${id}/withdraw`)
    expect(missing.status).toBe(404)
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({
      _tag: "SessionNotFoundError",
      sessionID: missingID,
    })
  }).pipe(Effect.scoped),
)
