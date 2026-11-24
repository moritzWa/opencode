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

The native CLI compiles. Full local suites pass: Core 8,038, TUI 1,795,
Server 176, and Protocol 17 (10,026 tests, zero failures). Full lint/typechecking,
official TypeScript checks, and packed subscription-auth loader tests pass.

**Installation gate:** the installed read-aloud highlighter uses the removed
Markdown `_blockStates` and text-buffer internals. It needs an adapter and muted,
isolated acceptance before replacing the daily build. Do not silently disable
read-aloud to make the upgrade appear successful. Keep the old build and live
database unchanged until the gate is cleared.

## Follow-up validation

The fork uses standard GitHub-hosted validation runners, not Blacksmith.
The process-daemon workflows use `macos-15` for ARM64 and retain `macos-15-intel`
for x64. Both process-daemon workflows pass on the migrated head, including
tests, builds, smoke tests, and package validation. A transient macOS runner
acquisition failure passed on retry; it was not a test or billing failure.
The publishing step stayed skipped. General check, unit/build/browser, docs,
and Nix validation runner labels also map to `ubuntu-24.04` and `windows-2025`.
No test commands, matrices, conditions, timeouts, or coverage were removed.
Deployment and product release workflows are outside this validation migration.

The authenticated account dashboard showed a $30/month Actions budget with
stop-at-limit enabled, $0 billed, and $11.35 of $12 included compute used.
Standard-runner compute for this public fork is free independently of that
allowance. Artifact/cache storage is separate. No billing setting was changed.

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

General CI validation on the migrated runners remains a publication gate.
Both integration and companion plugin PRs stay draft until acceptance is complete.
