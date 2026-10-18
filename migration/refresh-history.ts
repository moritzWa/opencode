import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { mkdir } from "node:fs/promises"
import { Database } from "../packages/core/src/database/database.ts"
import { V1Migration } from "../packages/core/src/database/v1-migration.bun.ts"
import { Global } from "../packages/util/src/global.ts"
import { importLegacyCredentials } from "../packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts"
import { importLegacyMcpCredentials } from "../packages/core/src/database/migration/20261017223000_import_legacy_mcp_credentials.ts"

const require = createRequire(path.resolve(import.meta.dir, "../packages/core/package.json"))
const { Effect, Layer } = await import(pathToFileURL(require.resolve("effect")).href)
const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"))
const root = positional[0] ?? path.join(os.homedir(), ".local/share/opencode-v2-migration")
const source = positional[1]
const credentialsOnly = process.argv.includes("--credentials-only")
const profile = await Bun.file(path.join(root, "profile.json")).json()
const target = profile.environment.OPENCODE_DB
if (path.resolve(target) === path.join(os.homedir(), ".local/share/opencode/opencode.db")) {
  throw new Error("Refusing the live V1 database")
}
// A stopped server is an operational precondition. Refuse any open handle,
// rather than assuming an old supervisor record proves that it has stopped.
const handles = Bun.spawnSync(["lsof", "-t", "--", target], { stdout: "pipe", stderr: "pipe" })
if (handles.exitCode === 0 && handles.stdout.toString().trim()) {
  throw new Error(`Candidate database is still open by PID(s): ${handles.stdout.toString().trim()}`)
}
if (handles.exitCode !== 0 && handles.exitCode !== 1) throw new Error("Unable to verify candidate database handles")

await mkdir(path.join(root, "runtime/maintenance-tmp"), { recursive: true, mode: 0o700 })
const global = Layer.succeed(Global.Service, Global.make({
  home: os.homedir(),
  data: path.join(root, "data/opencode"),
  config: path.join(root, "config/opencode"),
  cache: path.join(root, "cache/opencode"),
  state: path.join(root, "state/opencode"),
  tmp: path.join(root, "runtime/maintenance-tmp"),
}))
const database = Database.layer({ path: target }).pipe(Layer.provide(global))
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* Database.Service
    const credentialImport = yield* store.db.transaction((tx) => Effect.gen(function* () {
      yield* importLegacyCredentials(tx, path.join(root, "data/opencode/auth.json"))
      return yield* importLegacyMcpCredentials(tx, path.join(root, "data/opencode/mcp-auth.json"))
    }))
    if (credentialsOnly) return { credentialImport }
    const staged = source ? (yield* V1Migration.stageSource({ sourceDatabasePath: path.resolve(source) })) : undefined
    const imported = yield* V1Migration.run({ refresh: true, nextDatabasePath: false })
    return { credentialImport, staged, imported }
  }).pipe(Effect.provide(Layer.merge(global, database)), Effect.scoped),
)
await Bun.write(path.join(root, "runtime", credentialsOnly ? "credential-import.json" : "history-refresh.json"), JSON.stringify({ created: new Date().toISOString(), source, target, ...result }, null, 2) + "\n")
console.log(credentialsOnly ? "Offline credential import complete" : "Offline history refresh complete", result)
