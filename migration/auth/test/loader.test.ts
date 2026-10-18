import { expect } from "bun:test"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const core = process.env.AUTH_RECOVERY_CORE_ROOT ?? fileURLToPath(new URL("../../../packages/core/", import.meta.url))
const root = fileURLToPath(new URL("../", import.meta.url))
const { Effect } = await import(`${core}/node_modules/effect/dist/index.js`)
const { testEffect } = await import(`${core}/test/lib/effect.ts`)
const { PluginTestLayer } = await import(`${core}/test/plugin/fixture.ts`)
const { Config } = await import(`${core}/src/config.ts`)
const { ConfigPluginSource } = await import(`${core}/src/config/plugin/source.ts`)
const { PluginModule } = await import(`${core}/src/plugin/module.ts`)
const { AbsolutePath } = await import(`${core}/src/schema.ts`)
const { Document, Info } = await import(`${core}/../schema/src/config.ts`)
const { Host } = await import(`${core}/../plugin/src/host.ts`)
const { ensurePluginRuntime } = await import(`${core}/../plugin/src/runtime.ts`)
ensurePluginRuntime()

const it = testEffect(PluginTestLayer)
it.live("configured auth directory normalizes and loads through native ConfigPluginSource and PluginModule", () => Effect.gen(function* () {
  const sources = yield* ConfigPluginSource.Service
  const operations = yield* sources.operations()
  const operation = operations.find((item: { type: string; target: string }) => item.type === "add" && item.target === root.replace(/\/$/, ""))
  expect(operation).toBeDefined()
  const modules = yield* PluginModule.make()
  const loaded = yield* modules.load(operation, { install: false })
  expect(loaded.id).toBe("local.claude-subscription")
  expect(typeof loaded.effect).toBe("function")
  const local = Host.resolve({ directory: root })
  const packaged = Host.resolve({ directory: root, name: "@local/opencode-subscription-auth" })
  expect(local.server).toBe(new URL("../server.ts", import.meta.url).href)
  expect(packaged.server).toBe(local.server)
  expect(local.tui).toBeUndefined()
  expect(packaged.tui).toBeUndefined()
}).pipe(
  Effect.provide(ConfigPluginSource.layer),
  Effect.provide(Config.testLayer([new Document({ type: "document", path: AbsolutePath.make(join(root, "opencode.json")), info: new Info({ plugins: [{ package: "./" }] }) })])),
))
