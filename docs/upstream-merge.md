# November 2026 fork integration

Integration base: `fork/v2-parity` at `cc636d99c5`.
Upstream: `origin/dev` at `914d5e2b1b` (2.4.1).

This is a merge, not a replacement checkout. The common ancestor was October 17;
the integration resolves 77 conflicted paths.

## Native replacements

- Adopt upstream's native Markdown engine. The old blank-fence and currency
  grammar patch is obsolete. Keep renderer regressions for currency, streaming
  fences, nested lists, raw Markdown, formulas, links, and code.
- Adopt upstream's persistent PTY shell daemon and restart recovery. Retain a
  one-way reader for commands left running by the older fork. New commands never
  use that legacy implementation.
- Adopt upstream's job-aware idle eviction and native todo cards. Keep the
  portable todo plugin's metadata as an accepted historical input.
- Use upstream's current structured-output transport and validate the result
  against the requested schema at the Session boundary, including excess fields.

## Retained fork contracts

- Subscription auth recovery, bounded network/refresh attempts, and recovery of
  active children. Manually selected Grok remains valid; no automatic Grok fallback.
- Compaction silence bounds cover retries, a failed pinned summarizer may fall
  back once, and repeated no-progress compaction cannot loop indefinitely.
- Full plugin history includes pre-compaction messages and partial assistant
  output. Instruction entries remain global, durable, Session-keyed records.
- Tool execution hooks include the actual invocation identity and Location.
  Unchanged-read suppression never hides content absent from current history.
- Assistant answers remain expanded. Preserve session search, explicit copy/cut,
  native-style text selection, full terminal titles, configurable file-path
  attachments, targeted TUI events, and double-Escape prompt withdrawal.
- `subagent` follows upstream's background default. Explicit `background: false`
  retains the fork's foreground wait and cancellation ownership. A foreground
  completion must not emit a second report that revives an interrupted parent.
- Native text no longer exposes a text buffer. Search colors are applied after
  layout without replacing Markdown text or taking ownership of its lifecycle.

## Validation and cutover

Run package tests with isolated home/config/data roots. Never boot the candidate
against the installed database or discover the user's real MCPs during tests.
Regenerate database and client artifacts using their generators.

The native CLI compiles. Focused Core recovery/compaction/shell tests, native
Markdown/search/selection tests, and the packed subscription-auth loader have
passed during integration. The broad package runs still require final acceptance;
intermediate results are not a claim that the integration is ready to install.

Latest full Core run: 8,038 passed, 27 skipped, zero failures. Protocol: 17 passed.
The full Server run passed 174 tests with two stale Location-routing expectations;
both pass after moving the test off the now-global instruction-entry endpoint.
The full TUI run passed 1,794 tests with one wrapped-path fixture failure under
the longer isolated home path. Final reruns remain required.

**Installation gate:** the installed read-aloud highlighter uses the removed
Markdown `_blockStates` and text-buffer internals. It needs an adapter and muted,
isolated acceptance before replacing the daily build. Do not silently disable
read-aloud to make the upgrade appear successful. Keep the old build and live
database unchanged until the gate is cleared.

## Follow-up validation

Blacksmith's authenticated personal-account GitHub Actions dashboard explicitly
states that personal accounts are unsupported. Its GitHub App was authorized
for only `moritzWa/opencode` and both cancelled jobs were retried. That does not
remove the provider's account restriction. A supported organization or provider
exception is required; runner labels and check requirements have not changed.

Read-aloud's adapter is in companion draft PR
https://github.com/moritzWa/opencode-read-aloud/pull/43 . Three native renderer
tests cover real double-click offsets, duplicate answers, tables, Unicode,
streamed replacement, explicit lavender colors, and unchanged character frames.
All 36 selected legacy regressions and legacy typechecking pass. The packed
plugin also activates inside the actual compiled candidate CLI and handles its
empty-transcript toggle. These checks are silent; they neither synthesize nor
play speech. The installed plugin is unchanged.

`packages/core/script/validate-upgrade.ts` accepts a directory containing a
verified SQLite backup and its `before.json` provenance. It builds only Database
and SessionStore, never a server or SessionExecution. A full server could resume
the backup's execution claims and execute tools against real paths. The script
checks Session reads, every historical message page, and recent model contexts
without starting any model or tool work.

The 33.2 GB consistent backup passed all 14 pending migrations (51 to 65).
All 3,598 Sessions and 445,487 messages decode through the candidate's real
SessionStore. Twenty recent model contexts load. Reopened SQLite integrity and
foreign-key checks pass, historical row counts are unchanged, and a second
initialization applies no migrations. Reports are retained locally in
`~/Documents/opencode-upgrade-validation/`; they contain no assertion that a
candidate server was run against live data. The live source was opened read-only.

The remaining publication blocker is required Blacksmith CI, not these local
compatibility validations. Both integration and companion plugin PRs stay draft.
