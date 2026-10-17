# V1 history continuity during the V2 trial

Use a copied database and an offline maintenance process. Keep the daily-driver V1 database separate. Retain every source snapshot and back up the candidate before each refresh.

## Why the original importer cannot be reset

At frozen baseline `86c7f7c840`, `migration.v1-v2 = completed` is a permanent latch. Later V1 sessions and later messages in existing sessions are not imported. Removing the marker deletes all event rows, replaces session-message projections, and resets event sequences during the next import.

[Import V1 sessions created after migration completes, upstream PR #54272](https://github.com/anomalyco/opencode/pull/54272) was open when inspected. It tracks newly created session IDs. It deliberately does not rescan previously imported sessions, so it cannot synchronize ongoing V1 conversations. Its old-marker adoption also starts tracking at the current lowest ID rather than recovering all missed rows. This branch does not adopt that narrower fix.

## Supported offline operations

Both operations run on Bun and take their target from `Database.Service`. Neither starts a server, execution coordinator, job processor, provider, or model call.

```ts
V1Migration.stageSource({ sourceDatabasePath: "/absolute/path/to/v1-snapshot.db" })
// Effect<{ sessions: number; messages: number; parts: number }, never, Database.Service>

V1Migration.run({ refresh: true, nextDatabasePath: false })
// Effect<{ readonly status: "completed" }, never, Database.Service | Global.Service>
```

`stageSource` opens the external V1 snapshot read-only and holds a SQLite read transaction. It copies shared columns into the candidate's legacy `session`, `message`, and `part` tables. It inserts missing projects without overwriting existing project metadata. Each source session stages in one target transaction. Counts report source rows scanned, not only changed rows. Unchanged rows avoid SQL updates. Source rows absent from a newer snapshot remain in the candidate, including messages and parts that V1 deleted.

The candidate must already contain the migrated legacy tables. Seed the first candidate by backing up V1, then let `Database.layer` apply V2 schema migrations to that copy. Staging does not copy schema, migration markers, events, V2 projections, execution claims, inbox work, credentials, or config from the source.

`run({ refresh: true })` then merges all candidate legacy sessions into V2. Normal startup imports previously unreceipted sessions. Startup status does not scan all old message/part bodies for edits; explicit offline refresh performs that scan. `nextDatabasePath` refers only to the old, separate `opencode-next.db` format. It is not the V1 source path. Set it to `false` for controlled maintenance to disable implicit discovery of that file.

Both external-source operations reject a source that is the target file. The check compares filesystem device/inode identity, including symlink aliases. These helpers do not prove that another process has stopped using the candidate. The operator must stop that process and verify it is gone before opening the candidate.

## Merge invariants

- Legacy source tables remain available after conversion. No event rows are deleted or replayed as V2 events.
- Existing V2-native sessions, messages, metadata, and continuations remain in place. Existing project metadata wins.
- Existing message sequence values stay unchanged. New messages append after the maximum projected-message/event-sequence watermark. The event sequence never decreases, and its owner is retained.
- Per-session receipts live under `migration.v1-v2.session.<sessionID>` in `kv`. They commit with the imported messages, usage deltas, and cursor. They contain canonical SHA-256 hashes of converted message payloads and the last imported V1 usage totals.
- An unchanged V1 message does not overwrite a V2 edit. A changed V1 message updates the projection only if the projection still matches the previous import receipt.
- V1 usage deltas add to current V2 totals rather than replacing V2 usage. Existing session selections and metadata remain V2-owned.
- Deleted V2 messages and sessions with receipts stay deleted. Receipts outlive the deleted projection. Source-side deletions do not delete retained history.
- Repeating staging and refresh does not duplicate source content or the identical derived legacy-tool notice.
- Historical assistant messages without `agent` use their historical `mode`, or `build` if mode is absent. Their text, reasoning, tools, usage, and timestamps follow the existing conversion.
- Completed compaction summaries fold into V2 compaction messages. Earlier ordinary messages remain in the projection; the retained tail is also serialized for model context. Raw V1 compaction/summary rows remain in the legacy tables.

The transform still reports malformed or unsupported legacy rows by their session/message/part IDs. It retains their raw source rows. It still uses the established V2 representation for ignored text, subtask control messages, failed/incomplete compactions, external attachments, and obsolete tool notices. This change does not make every raw V1 control row a visible V2 message.

## Conflicts and old imports

If both V1 and V2 changed the same imported message, refresh fails with an `Error` defect naming the session and message. The affected session transaction rolls back. Previously committed sessions remain committed. The raw V1 version and V2 projection both remain recoverable. The importer does not choose a winner, duplicate the conversation into a new session, or discard either version. Resolve that conflict explicitly on a backed-up candidate, then rerun the same refresh. An offline script should report `Cause.pretty` or the full defect chain and exit unsuccessfully.

Old completed imports have no receipts. Unchanged matching projections can be adopted without replacement. Missing source messages can be recovered, while different same-ID projections fail conservatively because no common baseline is known. A missing session from an old import cannot be distinguished from a deliberately deleted session; the importer recovers it. Receipts provide deletion tracking after adoption.

Recovered old messages append without resequencing existing V2 history. This preserves the data but cannot restore original chronological placement around an existing V2 continuation. Start the controlled trial from a fresh V1 snapshot with the corrected importer before adding V2 continuations. Do not use an old incomplete import as the chronological-parity baseline. Further backdated V1 additions likewise append; ordinary ongoing V1 appends retain source order within each refresh batch.

## Offline layer recipe

Run from `packages/core` in the integrated worktree so workspace imports resolve. The manager owns the operational script and the explicit absolute paths. The data directory must be an isolated, existing directory. The candidate path must be a writable copy, not the retained snapshot or daily-driver database.

```ts
import { Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { Global } from "@opencode/util/global"

const global = Layer.succeed(Global.Service, Global.make({ data: "/absolute/path/to/isolated-data-directory" }))
const database = Database.layer({ path: "/absolute/path/to/candidate.db" }).pipe(Layer.provide(global))

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const staged = yield* V1Migration.stageSource({
      sourceDatabasePath: "/absolute/path/to/retained-v1-snapshot.db",
    })
    const imported = yield* V1Migration.run({ refresh: true, nextDatabasePath: false })
    return { staged, imported }
  }).pipe(Effect.provide(Layer.merge(global, database)), Effect.scoped),
)
console.log(result)
```

`Effect.provide` closes the scoped database connection after completion or failure. No `V1Migration.layer` is needed; that layer starts automatic background import and would race staging. No normal server runtime belongs in this process.

## Controlled cutover

1. Retain an online SQLite backup of V1 using SQLite's backup API. Do not copy a database file without its uncheckpointed WAL. Record source integrity checks and session/message/part counts.
2. Make a separate candidate from that backup. Use the corrected importer for its first import. Keep the retained source backup unchanged.
3. Before each refresh, stop every process using the candidate and verify process exit. Back up the entire candidate using SQLite's backup API. Keep its V2 tables, receipts, and events together.
4. Retain a fresh V1 snapshot. Run the offline staging and refresh recipe against the existing stopped candidate. Never replace that candidate with the newer V1 database.
5. On failure, retain both files and the full error. Retry staging/refresh after resolving the reported conflict. Staging and importing are separately resumable; always retry explicit `refresh: true` after an interrupted refresh.
6. Check candidate integrity, foreign keys, new source session IDs, history IDs/content, native V2 rows/events, and monotonic sequence watermarks. Exercise a continued V1 session and a V2-native session through the candidate's normal runtime.
7. At final cutover, stop V1 writes, retain one final backup, stop the candidate, and repeat staging/refresh and the checks. Start only V2 against the accepted candidate. Retain the V1 rollback database and all candidate backups.

V2-only continuations are not reverse-synchronized into V1. Reverting the daily driver to V1 leaves those conversations in the retained V2 candidate; it does not merge them back automatically.

## Verification scope

`packages/core/test/v1-migration.test.ts` uses real SQLite and V1 columns/relationships from `origin/v1`'s session SQL. It covers successive read-only source snapshots, new sessions below the old cursor, part-only updates, V2 continuations, pre-existing events and owners, old-marker adoption, missing historical agents, completed compaction folding with older history retained, deletion receipts, dual-writer conflict rollback, interrupted import/refresh retry, source-file identity rejection, and repeated import without duplicates.

The history stream does not open the manager's 22 GB backup, candidate service, or live database. Large-database timing, candidate acceptance, runtime UX checks, and final cutover remain manager integration checks.
