import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "@opencode/core/config"
import { Skill } from "@opencode/core/skill"
import { Document, Info } from "@opencode/schema/config"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("reports canonical location-scoped discovery diagnostics without changing the skill list", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const first = path.join(root.path, "first")
    const second = path.join(root.path, "second")
    const sources = [
      { path: path.join(first, "shared", "SKILL.md"), text: "---\nname: Shared\ndescription: First\n---\nFirst" },
      { path: path.join(second, "shared", "SKILL.md"), text: "---\nname: Shared\ndescription: Second\n---\nSecond" },
      { path: path.join(first, "manual", "SKILL.md"), text: "---\nname: Manual\n---\nManual" },
      { path: path.join(first, "broken", "SKILL.md"), text: "---\nname: [invalid\n---\nBroken" },
    ]
    yield* Effect.promise(() =>
      Promise.all(
        sources.map(async (source) => {
          await fs.mkdir(path.dirname(source.path), { recursive: true })
          await Bun.write(source.path, source.text)
        }),
      ),
    )
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: ":memory:" },
        config: { project: false, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      {
        overrides: [
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(
            Config.testLayer([new Document({ type: "document", info: new Info({ skills: [first, second] }) })]),
          ),
        ],
      },
    )
    const get = (endpoint: string) =>
      Effect.promise(async () => {
        const url = new URL(`http://opencode.local/api/skill${endpoint}`)
        url.searchParams.set("location[directory]", root.path)
        const response = await handler(new Request(url))
        expect(response.status).toBe(200)
        return response.json()
      })
    const report = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Skill.Diagnostic) }))(
      yield* get("/diagnostics"),
    )
    expect(report.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: sources[0]?.path, status: "shadowed", id: "shared" }),
        expect.objectContaining({ path: sources[1]?.path, status: "loaded", id: "shared" }),
        expect.objectContaining({ path: sources[2]?.path, status: "unadvertised", id: "manual" }),
        expect.objectContaining({ path: sources[3]?.path, status: "skipped" }),
      ]),
    )
    const before = yield* get("")
    expect(yield* get("/diagnostics")).toMatchObject({ data: report.data })
    expect(yield* get("")).toEqual(before)
  }).pipe(Effect.scoped),
)
