import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { sql } from "drizzle-orm"
import { Effect, Layer, Logger } from "effect"
import type { Scope } from "effect"
import type { SqlClient } from "effect/sql"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { DatabaseMigration } from "@opencode/core/database/migration"
import { migrations } from "@opencode/core/database/migration.gen"
import schema from "@opencode/core/database/schema.gen"
import migration, {
  importLegacyMcpCredentials,
} from "@opencode/core/database/migration/20261017223000_import_legacy_mcp_credentials"
import { Integration } from "@opencode/core/integration"
import { McpIdentity } from "@opencode/core/mcp/identity"
import { McpOAuth } from "@opencode/core/mcp/oauth"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const url = "https://mcp.slack.example/mcp"
const entry = {
  serverUrl: url,
  tokens: { accessToken: "legacy-access", refreshToken: "legacy-refresh", scope: "channels:read chat:write" },
  clientInfo: {
    clientId: "legacy-client",
    clientSecret: "legacy-client-secret",
    clientIdIssuedAt: 1700000000,
    clientSecretExpiresAt: 0,
  },
  codeVerifier: "transient-verifier",
  oauthState: "transient-state",
}

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Global.Service | Scope.Scope>, data: string) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provideService(Global.Service, Global.make({ data })),
        Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      ),
    ),
  )

// The current schema with every older migration recorded models an already-migrated rehearsal DB.
const database = Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.transaction((tx) => schema.up(tx))
  yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
  yield* Effect.forEach(
    migrations.filter((item) => item.id !== migration.id),
    (item) => db.run(sql`INSERT INTO migration (id, time_completed) VALUES (${item.id}, 1)`),
  )
  return db
})

const native = <A, E>(db: Effect.Success<typeof makeDb>, effect: Effect.Effect<A, E, Credential.Service>) =>
  effect.pipe(
    Effect.provide(
      LayerNode.compile(Credential.node, {
        replacements: [Database.node.replace(Layer.succeed(Database.Service, { db }))],
      }),
    ),
  )

describe("legacy MCP credential migration", () => {
  test("upgrades an existing database and native connectProvider reads tokens and registered client without login", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "mcp-auth.json")
    const expiresAt = Date.now() / 1000 + 3600.123
    const content = JSON.stringify({ slack: { ...entry, tokens: { ...entry.tokens, expiresAt } } })
    await Bun.write(filepath, content)
    await run(
      Effect.gen(function* () {
        const db = yield* database
        yield* DatabaseMigration.apply(db)
        const stored = yield* db.get<{ integration_id: string; value: string; active: number }>(
          sql`SELECT integration_id, value, active FROM credential`,
        )
        expect(stored?.integration_id).toBe(McpIdentity.id("slack", url))
        expect(stored?.active).toBe(1)
        expect(JSON.parse(stored?.value ?? "null")).toEqual({
          type: "oauth",
          methodID: McpIdentity.id("slack", url),
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: Math.floor(expiresAt * 1000),
          metadata: {
            serverUrl: url,
            tokenType: "Bearer",
            scope: entry.tokens.scope,
            client: {
              client_id: "legacy-client",
              client_secret: "legacy-client-secret",
              client_id_issued_at: 1700000000,
              client_secret_expires_at: 0,
            },
          },
        })
        yield* native(
          db,
          Effect.gen(function* () {
            const provider = yield* McpOAuth.connectProvider({
              config: { type: "remote", url },
              integrationID: Integration.ID.make(McpIdentity.id("slack", url)),
            })
            const tokens = yield* Effect.promise(async () => provider.tokens())
            expect(tokens).toMatchObject({
              access_token: "legacy-access",
              refresh_token: "legacy-refresh",
              token_type: "Bearer",
              scope: entry.tokens.scope,
            })
            expect(tokens?.expires_in).toBeGreaterThan(3500)
            expect(tokens?.expires_in).toBeLessThanOrEqual(3601)
            expect(yield* Effect.promise(async () => provider.clientInformation())).toEqual({
              client_id: "legacy-client",
              client_secret: "legacy-client-secret",
              client_id_issued_at: 1700000000,
              client_secret_expires_at: 0,
            })
            expect(provider.state).toBeUndefined()
            yield* Effect.promise(async () => {
              await expect(provider.codeVerifier()).rejects.toThrow("Missing PKCE code verifier")
            })
          }),
        )
        const before = yield* db.all(sql`SELECT * FROM credential`)
        yield* DatabaseMigration.apply(db)
        yield* db.transaction((tx) => importLegacyMcpCredentials(tx, filepath))
        expect(yield* db.all(sql`SELECT * FROM credential`)).toEqual(before)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${migration.id}`)).toEqual({
          count: 1,
        })
      }),
      tmp.path,
    )
    expect(await Bun.file(filepath).text()).toBe(content)
  })

  test("retains nonexpiring/expired tokens and isolates server names and exact URLs", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "mcp-auth.json")
    const expired = Date.now() / 1000 - 60
    await Bun.write(
      filepath,
      JSON.stringify({
        slack: entry,
        "slack-other-account": { ...entry, tokens: { accessToken: "other-account", expiresAt: 0 } },
        "slack-other-url": { ...entry, serverUrl: url + "/", tokens: { accessToken: "other-url", expiresAt: expired } },
      }),
    )
    await run(
      Effect.gen(function* () {
        const db = yield* database
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM credential`)).toEqual({ count: 3 })
        yield* native(
          db,
          Effect.gen(function* () {
            for (const [name, serverUrl, access] of [
              ["slack", url, "legacy-access"],
              ["slack-other-account", url, "other-account"],
              ["slack-other-url", url + "/", "other-url"],
            ] as const) {
              const provider = yield* McpOAuth.connectProvider({
                config: { type: "remote", url: serverUrl },
                integrationID: Integration.ID.make(McpIdentity.id(name, serverUrl)),
              })
              const tokens = yield* Effect.promise(async () => provider.tokens())
              expect(tokens?.access_token).toBe(access)
              if (name === "slack-other-url") {
                expect(tokens?.expires_in).toBe(0)
                continue
              }
              expect(tokens).not.toHaveProperty("expires_in")
            }
          }),
        )
      }),
      tmp.path,
    )
  })

  test("skips missing tokens and invalid URLs/values without overwriting any existing V2 credential", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "mcp-auth.json")
    await Bun.write(
      filepath,
      JSON.stringify({
        slack: entry,
        missingTokens: { serverUrl: url, clientInfo: entry.clientInfo },
        missingUrl: { tokens: entry.tokens },
        invalidUrl: { ...entry, serverUrl: "not a URL" },
        fileUrl: { ...entry, serverUrl: "file:///tmp/mcp" },
        badExpiry: { ...entry, tokens: { ...entry.tokens, expiresAt: -1 } },
        excessiveExpiry: { ...entry, tokens: { ...entry.tokens, expiresAt: Number.MAX_VALUE } },
        emptyToken: { ...entry, tokens: { accessToken: "" } },
        invalidClient: { ...entry, clientInfo: { clientId: 42 } },
      }),
    )
    await run(
      Effect.gen(function* () {
        const db = yield* database
        const value = JSON.stringify({ type: "key", key: "existing-v2-secret" })
        yield* db.run(
          sql`INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES ('cred_existing', ${McpIdentity.id("slack", url)}, 'V2', ${value}, 0, 1, 2)`,
        )
        const before = yield* db.all(sql`SELECT * FROM credential`)
        expect(yield* db.transaction((tx) => importLegacyMcpCredentials(tx, filepath))).toEqual({
          imported: 0,
          existing: 1,
          skipped: 8,
        })
        expect(yield* db.all(sql`SELECT * FROM credential`)).toEqual(before)
      }),
      tmp.path,
    )
  })

  test("supports a file copied after migration completion through the explicit helper without changing markers", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "mcp-auth.json")
    await run(
      Effect.gen(function* () {
        const db = yield* database
        yield* DatabaseMigration.apply(db)
        const markers = yield* db.all(sql`SELECT * FROM migration ORDER BY id`)
        yield* Effect.promise(() => Bun.write(filepath, JSON.stringify({ slack: entry })))
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM credential`)).toEqual({ count: 0 })
        expect(yield* db.transaction((tx) => importLegacyMcpCredentials(tx, filepath))).toEqual({
          imported: 1,
          existing: 0,
          skipped: 0,
        })
        expect(yield* db.all(sql`SELECT * FROM migration ORDER BY id`)).toEqual(markers)
        expect(yield* db.transaction((tx) => importLegacyMcpCredentials(tx, filepath))).toEqual({
          imported: 0,
          existing: 1,
          skipped: 0,
        })
      }),
      tmp.path,
    )
  })

  test("sanitizes malformed-file and SQL failures, rolls back, and permits retry without logging secrets", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "mcp-auth.json")
    const output = new Array<ReturnType<typeof Logger.formatStructured.log>>()
    await Bun.write(filepath, JSON.stringify({ slack: entry }))
    await run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.run(
          sql`CREATE TRIGGER deny_mcp BEFORE INSERT ON credential BEGIN SELECT RAISE(ABORT, 'legacy-client-secret'); END`,
        )
        const failed = yield* Effect.exit(DatabaseMigration.apply(db))
        expect(failed._tag).toBe("Failure")
        expect(String(failed)).toContain("Could not import legacy MCP credential")
        for (const secret of [
          entry.tokens.accessToken,
          entry.tokens.refreshToken,
          entry.clientInfo.clientSecret,
          entry.codeVerifier,
          entry.oauthState,
        ]) {
          expect(String(failed)).not.toContain(secret)
          expect(JSON.stringify(output)).not.toContain(secret)
        }
        expect(yield* db.get(sql`SELECT count(*) AS count FROM credential`)).toEqual({ count: 0 })
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toBeUndefined()
        yield* db.run(sql`DROP TRIGGER deny_mcp`)
        yield* DatabaseMigration.apply(db)
        yield* Effect.promise(() => Bun.write(filepath, '{"slack":{"tokens":{"accessToken":"legacy-access"'))
        const malformed = yield* Effect.exit(db.transaction((tx) => importLegacyMcpCredentials(tx, filepath)))
        expect(String(malformed)).toContain("Legacy MCP credential file must contain a JSON object")
        expect(String(malformed)).not.toContain("legacy-access")
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.map(Logger.formatStructured, (value) => {
              output.push(value)
            }),
          ]),
        ),
      ),
      tmp.path,
    )
  })
})
