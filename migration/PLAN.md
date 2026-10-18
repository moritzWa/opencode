# Full-parity V2 migration

Manager: `ses_eb9f07705ffeNJGcxTvu16q0bv`.
User approved autonomous execution on 2026-10-17. Preserve all heavily used V1 behavior, including toolbar and switcher details. Do not silently reduce scope to essential plugins.

## Ownership

| Stream | Session | Workspace |
| --- | --- | --- |
| Integration, isolated environment, acceptance, cutover | manager | opencode worktree `v2-migration` |
| Core, AI, protocol, server, client | `ses_eb44d0425ffeclxJkrLZcLMXKf` | opencode worktree `v2-core` |
| TUI, TUI plugin API, CLI configuration | `ses_eb44cd45fffeLCZ0N50Zd14JQp` | opencode worktree `v2-interface` |
| Plugin ports and read-aloud | `ses_eb44d042dffeEOciGkY6526ZX7` | `migration/plugins`; own read-aloud worktree |
| Cursor provider | `ses_eb44d023bffet3zNlHcEZE92l5` | own provider worktree |
| agentview V1/V2 adapter | `ses_eb44d0428ffeY5x0TVak305GOK` | own agentview worktree |
| Claude auth and durable provider recovery | `ses_eb44b6e19ffei7vTIiww6l7zrS` | `migration/auth` |
| Non-destructive incremental history migration | `ses_eb43e6110ffeCNDx2wmhCpHTFN` | opencode worktree `v2-history` |
| Durable visible todo parity followup | UI owner `ses_eb44cd45fffeLCZ0N50Zd14JQp` | `migration/todo`; own TUI worktree |

## Integration evidence

- Frozen starting revision: `86c7f7c840`, V2.0.32 development source.
- Initial baseline test binary built successfully with migration channel, without web assets or installation.
- Checked core targeted-TUI + unanswered-withdrawal API slice `e2dcb39563` integrated as `27db6529f4`.
- Provider stream delivered commit `450fe72`, fork PR “Complete OpenCode 2 native image permissions and verify packed plugin parity”; final packed artifact SHA256 `64af05fd3055ef2a9767d76b7295b20eb92f249ca116b78cb1e0da6f9993dd62`.
- agentview stream delivered `1e2e3ad`, PR “Support OpenCode V2 alongside V1”; actual isolated stock V2 lifecycle verified, unified two-client proof pending integration.
- Initial backup helper exposed a WAL-publication defect during independent reopened-database audit. The live source was never modified. Fixed helper to pin a read snapshot, checkpoint and close before rename, then reopen and compare counts; initial invalid candidate retained separately for diagnosis. Never treat a check on an open backup connection as proof of a movable standalone snapshot.

## Acceptance policy

Every feature needs one final disposition: upstream equivalent verified, port verified, or explicit unresolved blocker. Source inspection alone is not live acceptance. Existing V1 remains usable until the V2 candidate passes. Separate configuration/state/database/service during development. Import using a consistent SQLite backup. Never alternate versions against the live database.

## UI parity

- Read-aloud footer controls, speed, pause/resume, word highlight, Option-click, scrolling, lazy synthesis/cache, stall recovery, media controls.
- Dim session title beside model/agent; state-colored clickable PR footer.
- Inline running subagents near interrupt; hidden hints, context display, narrow single-line layout.
- Model grouping/provider text/alphabetical order; frontier filtering and automatic-selection allowlist.
- Bare full terminal title; session drafts with cursor and attachments.
- Double-Esc prompt withdrawal until output starts; immediate draft restore.
- Find-in-session highlighting/navigation; tool/bash folding.
- Clickable wrapped/labeled links during read-aloud, selection and dragging preserved.
- Theme, filled bullets, all current keyboard/paste/newline/navigation bindings.
- Durable provider-independent todowrite, saved V1 checklist seeding, sidebar and historical tool checklist, restart/clear persistence.
- One attached TUI switches session, including across directories, without moving sibling clients.

## Runtime parity

- Subscription auth: Cursor, Claude Keychain, OpenAI; live tools and model variants.
- Cursor interruption/restart/long-outage/large-tool-call recovery and context continuity.
- Automatic fallback preserves personal/work billing boundary and avoids loops.
- Transient Claude authentication: accurate throttle/network/5xx/revoked/quota classification; secret-free rotating diagnostics; bounded 60–90s retry before one durable recovery; preserve completed tools and never revive aborted/completed work. Fault injection covers brief/persistent/concurrent failure, fallback failure, restart and exactly-once recovery.
- Monitor matching-output/exit/timeout wakeups, stop/restart cleanup, working holds.
- Native background execution plus provider-originated shell completion behavior.
- Claude tool hooks, email guards, session environment and per-file autocommit, including Code Mode execution.
- Shared memory tools/injection/models/autodream disabled; peers server/TUI.
- Worktree conventions and checks; spawned-session hierarchy; Adrafinil.
- All configured MCPs and OAuth flows.
- agentview start/list/status/attach/prompt/abort/restart/continue/model/hierarchy/hide behavior.

## Core parity

- Transient/wrapped network retry, long-outage handling, partial-output retries, silence watchdog excluding tool waits.
- Compaction models, fallback, loop prevention and foreign-provider overflow.
- Claude narration/progress; cache stability under instruction/memory/MCP changes.
- Lazy MCP catalog, unchanged-read suppression, tool-output caps.
- Paged history/retention/switch responsiveness, idle-location eviction.
- LSP audit disposition: V1 omitted/false disables LSP. No LSP setting/flags; latest 605 mutation results all diagnostics empty. Preserve disabled baseline; do not implement unused LSP as a cutover blocker.
- Deleted-worktree recovery, abort prompt cleanup, stale skill discovery diagnostics/recovery, db output flushing.

## Phases

1. Freeze source/config reference; isolated V2 setup and consistent history backup.
2. Parallel implementation with recorded evidence and focused checks.
3. Integrate branches/plugin artifacts; end-to-end acceptance in isolated environment.
4. Real Ghostty/agentview/audio/paste checks in the shared macOS VM using separate candidate configuration. Host checks are limited to final binary/process/service handoff.
5. Controlled cutover preserving V1 fallback and history; verify installed and running revisions.
6. Publish changes through appropriate repos, capture remaining issues, clean owned processes/worktrees/branches and child sessions.
