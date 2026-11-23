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

**Installation gate:** the installed read-aloud highlighter uses the removed
Markdown `_blockStates` and text-buffer internals. It needs an adapter and muted,
isolated acceptance before replacing the daily build. Do not silently disable
read-aloud to make the upgrade appear successful. Keep the old build and live
database unchanged until the gate is cleared.
