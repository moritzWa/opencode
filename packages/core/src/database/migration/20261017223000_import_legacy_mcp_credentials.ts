import { readFile } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Credential } from "@opencode/schema/credential"
import { Integration } from "@opencode/schema/integration"
import { Global } from "@opencode/util/global"
import { McpIdentity } from "../../mcp/identity.js"
import type { DatabaseMigration } from "../migration.js"

// V1 token expiry is epoch seconds (possibly fractional); native OAuth stores integer milliseconds.
const Seconds = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER / 1000),
)
const LegacyEntry = Schema.Struct({
  serverUrl: Schema.String,
  tokens: Schema.Struct({
    accessToken: Schema.String.check(Schema.isMinLength(1)),
    refreshToken: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Seconds),
    scope: Schema.optional(Schema.String),
  }),
  clientInfo: Schema.optional(
    Schema.Struct({
      clientId: Schema.String.check(Schema.isMinLength(1)),
      clientSecret: Schema.optional(Schema.String),
      clientIdIssuedAt: Schema.optional(Seconds),
      clientSecretExpiresAt: Schema.optional(Seconds),
    }),
  ),
})
const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const decodeEntry = Schema.decodeUnknownOption(LegacyEntry)

const migration: DatabaseMigration.Migration = {
  id: "20261017223000_import_legacy_mcp_credentials",
  up(tx) {
    return Effect.gen(function* () {
      const global = yield* Global.Service
      yield* importLegacyMcpCredentials(tx, path.join(global.data, "mcp-auth.json"))
    })
  },
}
export default migration

/** Run in a transaction to retry a file copied after its one-shot migration already completed. */
export function importLegacyMcpCredentials(tx: Parameters<DatabaseMigration.Migration["up"]>[0], filepath: string) {
  return Effect.gen(function* () {
    const result = { imported: 0, existing: 0, skipped: 0 }
    const content = yield* Effect.tryPromise({
      try: () => readFile(filepath, "utf8"),
      catch: (error) => ({
        missing: typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
      }),
    }).pipe(
      Effect.catch((error) =>
        error.missing ? Effect.succeed(undefined) : Effect.fail(new Error("Could not read legacy MCP credential file")),
      ),
    )
    if (content === undefined) return result
    const input = Option.getOrUndefined(decodeFile(content))
    if (!input) return yield* Effect.fail(new Error("Legacy MCP credential file must contain a JSON object"))

    for (const [name, raw] of Object.entries(input)) {
      const entry = Option.getOrUndefined(decodeEntry(raw))
      const url = entry && URL.canParse(entry.serverUrl) ? new URL(entry.serverUrl) : undefined
      if (!name || !entry || !url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
        result.skipped++
        continue
      }
      // Preserve the exact stored URL: native registration hashes config.url without normalization.
      const integrationID = McpIdentity.id(name, entry.serverUrl)
      if (yield* tx.get(sql`SELECT id FROM credential WHERE integration_id = ${integrationID}`)) {
        result.existing++
        continue
      }
      const client = entry.clientInfo
      const credential = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make(integrationID),
        access: entry.tokens.accessToken,
        refresh: entry.tokens.refreshToken ?? "",
        expires: Math.floor((entry.tokens.expiresAt ?? 0) * 1000),
        metadata: {
          serverUrl: entry.serverUrl,
          tokenType: "Bearer",
          ...(entry.tokens.scope ? { scope: entry.tokens.scope } : {}),
          ...(client
            ? {
                client: {
                  client_id: client.clientId,
                  ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
                  ...(client.clientIdIssuedAt === undefined ? {} : { client_id_issued_at: client.clientIdIssuedAt }),
                  ...(client.clientSecretExpiresAt === undefined
                    ? {}
                    : { client_secret_expires_at: client.clientSecretExpiresAt }),
                },
              }
            : {}),
        },
      })
      const now = Date.now()
      // Query errors can contain bound parameters. Replace them before migration logging sees them.
      yield* tx
        .run(
          sql`
        INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
        VALUES (${Credential.ID.create()}, ${integrationID}, 'OAuth', ${JSON.stringify(credential)}, 1, ${now}, ${now})
      `,
        )
        .pipe(Effect.mapError(() => new Error("Could not import legacy MCP credential")))
      result.imported++
    }
    return result
  })
}
