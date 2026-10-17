import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Session } from "@opencode/schema/session"
import { Config } from "@opencode/core/config"
import { Global } from "@opencode/util/global"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { tempGlobalLayer } from "../../core/test/fixture/global"

for (const hint of ["header", "query"] as const) {
  it.live(`persists a deleted Session directory recovery from the requested ${hint} location`, () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-recovery-")))
      const source = AbsolutePath.make(path.join(root.path, "deleted-worktree"))
      const destination = AbsolutePath.make(path.join(root.path, "replacement"))
      yield* Effect.promise(() => Promise.all([fs.mkdir(source), fs.mkdir(destination)]))
      const handler = yield* ServerFetch.make(
        {
          app: { version: "test-version" },
          database: { path: ":memory:" },
          config: { directory: root.path, project: false },
          models: { fetch: false },
          fs: { filewatcher: false },
        },
        { overrides: [Global.node.replace(tempGlobalLayer), Config.node.replace(Config.testLayer())] },
      )
      const created = yield* Effect.promise(() =>
        handler(
          new Request("http://opencode.local/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Recover me", location: { directory: source } }),
          }),
        ),
      )
      expect(created.status).toBe(200)
      const decode = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))
      const session = decode(yield* Effect.promise(() => created.json())).data
      const get = (endpoint: string, directory?: string) => {
        const url = new URL(
          endpoint === "/instructions"
            ? `http://opencode.local/api/experimental/session/${session.id}/instructions/entries`
            : `http://opencode.local/api/session/${session.id}${endpoint}`,
        )
        if (directory && hint === "query") url.searchParams.set("location[directory]", directory)
        return Effect.promise(() =>
          handler(
            new Request(url, {
              headers: directory && hint === "header" ? { "x-opencode-directory": encodeURIComponent(directory) } : {},
            }),
          ),
        )
      }
      // A valid original placement must win over an unrelated requested directory.
      expect((yield* get("/instructions", destination)).status).toBe(200)
      const before = yield* get("")
      expect(decode(yield* Effect.promise(() => before.json())).data.location.directory).toBe(source)
      yield* Effect.promise(() => fs.rm(source, { recursive: true }))
      // A cached Location can still serve requests after its directory disappears.
      // Neither an absent hint nor a nonexistent destination may change placement.
      yield* get("/instructions")
      yield* get("/instructions", path.join(root.path, "also-missing"))
      const unchanged = yield* get("")
      expect(decode(yield* Effect.promise(() => unchanged.json())).data.location.directory).toBe(source)
      expect((yield* get("/instructions", destination)).status).toBe(200)
      const after = yield* get("")
      const recovered = decode(yield* Effect.promise(() => after.json())).data
      expect(recovered.location.directory).toBe(destination)
      expect(recovered.title).toBe("Recover me")
      // Subsequent routing needs no fallback hint: the move changed durable placement.
      expect((yield* get("/instructions")).status).toBe(200)
    }),
  )
}
