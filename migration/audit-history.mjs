import { Database } from "bun:sqlite"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { V1Migration } from "../packages/core/src/database/v1-migration.bun.ts"

const root = process.argv[2] ?? path.join(os.homedir(), ".local/share/opencode-v2-migration")
const profile = await Bun.file(path.join(root, "profile.json")).json()
const db = new Database(profile.environment.OPENCODE_DB, { readonly: true })
db.run("PRAGMA query_only = ON")
db.run("BEGIN")
const state = db.query("SELECT value FROM kv WHERE key='migration.v1-v2'").get()
if (JSON.parse(state?.value ?? "null")?.phase !== "completed") throw new Error("Import must finish before audit")

const warnings = {}
const failures = []
const aliases = []
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const fingerprint = (type, data) => createHash("sha256").update(canonical([type, data])).digest("hex")
const counts = { sessions: 0, expected: 0, present: 0, exact: 0, sourceIDProjections: 0, exactSourceIDProjections: 0, equivalentDerivedNotices: 0, missing: 0, changed: 0 }
for (const source of db.query("SELECT id FROM session ORDER BY id").all()) {
  const session = db.query("SELECT * FROM session_v2 WHERE id=?").get(source.id)
  if (!session) {
    failures.push({ sessionID: source.id, reason: "missing-session" })
    continue
  }
  const messages = db.query("SELECT id,session_id,time_created,time_updated,data FROM message WHERE session_id=?").all(source.id)
  const rawIDs = new Set(messages.map((message) => message.id))
  const projected = V1Migration.transformSession({
    session,
    messages,
    parts: db.query("SELECT id,message_id,session_id,time_created,time_updated,data FROM part WHERE session_id=?").all(source.id),
  })
  for (const warning of projected.warnings) warnings[warning.reason] = (warnings[warning.reason] ?? 0) + 1
  const actual = new Map(
    db.query("SELECT id,type,data FROM session_message WHERE session_id=?").all(source.id).map((row) => [row.id, { ...row, data: JSON.parse(row.data) }]),
  )
  const receipt = JSON.parse(db.query("SELECT value FROM kv WHERE key=?").get(`migration.v1-v2.session.${source.id}`)?.value ?? "null")
  counts.sessions++
  counts.expected += projected.messages.length
  for (const expected of projected.messages) {
    if (rawIDs.has(expected.id)) counts.sourceIDProjections++
    const row = actual.get(expected.id)
    if (row === undefined) {
      // Incremental import deliberately retains one existing generated tool-
      // rename notice. Its ID/time follows the old last-message anchor. This
      // exception is never available to an original source projection, and
      // both old/new provenance hashes must prove the exact derived notice.
      const matches = [...actual.values()].filter((item) => item.type === "system" && item.data.text === expected.data.text)
      if (expected.type === "system" && !rawIDs.has(expected.id) && projected.messages.at(-1) === expected &&
          typeof expected.data.text === "string" && expected.data.text.startsWith("The available tools have changed.\n\n") &&
          db.query("SELECT id FROM message WHERE id=? LIMIT 1").get(expected.id) === null &&
          receipt?.messages[expected.id] === fingerprint(expected.type, expected.data) && matches.length === 1 &&
          !rawIDs.has(matches[0].id) && receipt?.messages[matches[0].id] === fingerprint(matches[0].type, matches[0].data)) {
        counts.equivalentDerivedNotices++
        counts.present++
        aliases.push({ sessionID: source.id, expectedID: expected.id, existingID: matches[0].id, textHash: createHash("sha256").update(expected.data.text).digest("hex") })
        continue
      }
      counts.missing++
      if (failures.length < 30) failures.push({ sessionID: source.id, messageID: expected.id, reason: "missing-message" })
      continue
    }
    counts.present++
    if (row.type !== expected.type || canonical(row.data) !== canonical(expected.data)) {
      counts.changed++
      if (failures.length < 30) failures.push({ sessionID: source.id, messageID: expected.id, reason: "changed-message" })
      continue
    }
    counts.exact++
    if (rawIDs.has(expected.id)) counts.exactSourceIDProjections++
  }
}
const report = { created: new Date().toISOString(), counts, warnings, aliases, failures }
await Bun.write(path.join(root, "runtime/history-audit.json"), JSON.stringify(report, null, 2) + "\n")
db.run("ROLLBACK")
db.close()
console.log(JSON.stringify(report, null, 2))
if (failures.length || counts.missing || counts.changed) process.exitCode = 1
