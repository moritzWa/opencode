import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Config } from "@opencode/core/config"
import { Session } from "@opencode/schema/session"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const options = {
  app: { version: "test" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
  password: "tui-test-secret",
} as const
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${btoa(`opencode:${options.password}`)}`,
}

it.live("authenticates selection, advertises support, and broadcasts targeted cross-directory events", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options, {
      overrides: [Global.node.replace(tempGlobalLayer), Config.node.replace(Config.testLayer())],
    })
    const post = (path: string, body: unknown) =>
      Effect.promise(() =>
        handler(new Request(`http://opencode.local${path}`, { method: "POST", headers, body: JSON.stringify(body) })),
      )
    const created = yield* post("/api/session", { location: { directory: "/target-project" } })
    expect(created.status).toBe(200)
    const session = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
      yield* Effect.promise(() => created.json()),
    ).data
    const info = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/info", { headers })))
    expect(yield* Effect.promise(() => info.json())).toMatchObject({
      capabilities: { tuiSessionSelect: true, tuiExecuteCommand: true },
    })

    const payload = { sessionID: session.id, client: "pane-2", targetDirectory: session.location.directory }
    const unauthorized = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/tui/select-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      ),
    )
    expect(unauthorized.status).toBe(401)

    const streams = yield* Effect.forEach(["/old-project", "/unrelated-project"], (directory) =>
      Effect.gen(function* () {
        const abort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()))
        const client = OpenCode.make({
          baseUrl: "http://opencode.local",
          headers: { ...headers, "x-opencode-directory": encodeURIComponent(directory) },
          fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
            preconnect: fetch.preconnect,
          }),
        })
        const reader = client.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]()
        const next = Effect.promise(async () => {
          const chunk = await reader.next()
          if (chunk.done) throw new Error("Expected another SSE event")
          return chunk.value
        })
        expect((yield* next).type).toBe("server.connected")
        return next
      }),
    )
    const selected = yield* post("/api/tui/select-session", payload)
    expect(selected.status).toBe(200)
    expect(yield* Effect.promise(() => selected.json())).toBe(true)
    for (const next of streams) {
      const event = Schema.decodeUnknownSync(TuiEvent.SessionSelect)(yield* next)
      expect(event.data).toEqual(payload)
      expect(event.location).toBeUndefined()
    }

    const broadcastCommand = yield* post("/api/tui/execute-command", { command: "speech.pause" })
    expect(broadcastCommand.status).toBe(400)
    const command = { command: "speech.pause", client: "pane-2" }
    const executed = yield* post("/api/tui/execute-command", command)
    expect(executed.status).toBe(200)
    expect(yield* Effect.promise(() => executed.json())).toBe(true)
    for (const next of streams) {
      const event = Schema.decodeUnknownSync(TuiEvent.CommandExecute)(yield* next)
      expect(event.data).toEqual(command)
      expect(event.location).toBeUndefined()
    }

    const untargeted = yield* post("/api/tui/select-session", { sessionID: session.id })
    expect(untargeted.status).toBe(200)
    const missingID = Session.ID.create()
    const missing = yield* post("/api/tui/select-session", { sessionID: missingID, client: "pane-2" })
    expect(missing.status).toBe(404)
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({
      _tag: "SessionNotFoundError",
      sessionID: missingID,
    })
  }).pipe(Effect.scoped),
)
