# Durable provider-independent todos

Enable this package before Cursor and disable `CURSOR_OPENCODE2_TODOS` once enabled.
`config-fragment.json` and `tui-fragment.json` are candidate-profile fragments, not live configuration edits.
Both plugin targets are directories. The package exports separate server, TUI, and RPC entries.

## Server contract

- Plugin and RPC ID: `moritz-todo`.
- Direct tools: `todowrite`, plus `todoread` unless `options.todoread` is false. Both use `codemode: false` and register for every provider.
- `todowrite` takes the full ordered `{todos:[{content,status,priority}]}` list. Session identity comes from tool execution context, never model arguments.
- Durable `ctx.storage` key: `session.<SessionID>`. The record stores `{revision,todos}`. Empty `todos: []` remains a persisted record, not a missing value.
- RPC `get({sessionID})` and `update({sessionID,todos})` return `{sessionID,todos,revision}`. `changed` events publish that same state after storage commits.
- The sidebar subscribes before fetching, refetches on attach/session selection and `server.connected`, and ignores stale revisions. It does not treat client-local memory as the authority.
- Static managed instruction `todo.authority` explicitly supersedes imported notices that say todowrite is unavailable. The prompt hook writes the same native managed value. No transcript or historical migration notice is edited.

## Legacy import

`options.legacyDatabasePath` is explicit and optional. Open that SQLite file read-only, read the retained `todo` table for the requested Session, and order by `position`.
Never discover or open the live V1 database implicitly. Preserve content, status, and priority strings.
Import only when the plugin storage key is `undefined`; persist even an empty first import. Later reads/reconnects cannot overwrite a V2-edited or cleared list.
Imports and writes serialize per Session across Location activations in this server. The supported deployment uses the elected server, not concurrent processes writing the same plugin namespace.

The assembler must set `options.legacyDatabasePath` to the absolute retained candidate database path when enabling migration import. The portable default fragment leaves this machine-specific option unset. It must never point at the daily live database by discovery or fallback.

## Display

The portable TUI owns an additive `sidebar.content` checklist with V1 status markers, incomplete-list visibility, and a collapsible heading for lists longer than two items.
Native historical `todowrite` cards are restored separately in the TUI source. This avoids globally replacing every tool slot or hiding ordinary read/write cards.

## Build and pack

Run the build, tests, and pack scripts through the shared heavy-job wrapper.
`pack` rebuilds the TUI, creates a portable tarball under `artifacts`, and writes `artifacts.json` with the tarball and source SHA-256 hashes.
Host-owned plugin, Solid, and OpenTUI modules stay external/shared. No Core todo subsystem or new HTTP route is introduced.

## Checked acceptance

- Seven real-host tests, 75 assertions: native SDK supervisor and Promise adapter, SQLite-backed plugin KV, OpenAI/Anthropic direct catalogs, write/reopen/read/clear/reopen, Session isolation, two RPC/SSE clients and reconnect/refetch, read-only import, static instruction authority, and optional `todoread`.
- An explicit read-only candidate audit restored the manager's actual four ordered items with three unfinished into isolated plugin KV. Content/status/priority matched exactly, and the source database size/mtime stayed unchanged. Clearing the isolated list remained cleared.
- Fresh packed install has no workspace dependency. Its server executes real non-Cursor writes/reads through native PluginHost, and its server/store/RPC/TUI files match the checked source byte-for-byte.
- Native TUI historical cards and ordinary read/write cards remain visible together at 44/100 columns. The portable sidebar collapses, follows Session selection, accepts live RPC events, rejects older revisions, refetches after a real event-stream disconnect, and accepts later events after reconnect. Repeated ten times: 30 passes, 180 assertions.

Server acceptance uses the package test script. Set `TODO_ARTIFACT` to the built tarball to include the fresh-install test. Set both `TODO_LEGACY_DATABASE_PATH` and `TODO_LEGACY_SESSION_ID` explicitly to include the read-only four-item manager audit. With no explicit source path, no legacy database is opened.

TUI acceptance runs `test/todo-parity.test.tsx` from `packages/tui`. Set `OPENCODE_TODO_PLUGIN` to this package directory to include the real plugin sidebar/reconnect test. Native historical checklist tests do not require that environment variable.
