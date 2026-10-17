# V2 interface parity

Branch: `v2-interface`. Baseline: `86c7f7c840` from the initial `origin/dev` snapshot.
Reference: `fork/local/dev-build`, the read-only V1 `tui.json`, and its TUI plugins.
The live V1 configuration, binary, database, and server have not been changed.

## Daily workflow

- **Read-aloud controls:** Existing `prompt.footer` stays additive. The plugin stream owns speed, pause/resume, lazy synthesis/cache, media controls, scrolling, word highlights, Option-click, and recovery. Real audio and terminal acceptance belongs to integration with that port.
- **Dim title beside agent/model:** `prompt.metadata` and `session.composer.right` share the real metadata row. The title plugin supplies its dim text. Integration must verify title and speech controls together at narrow and wide sizes.
- **Clickable, state-colored PR footer:** `prompt.footer` remains stable. `session.footer` also permits a full-width footer above the composer. PR lookup and state colors belong to the plugin stream.
- **Inline running subagents:** The prompt shows a bounded clickable count next to interrupt. The regular footer omits its duplicate count while the parent runs. Narrow terminals use a shorter count.
- **Hideable hints:** `prompt.hints` and its Settings entry hide agent/command hints without hiding context or interrupt. V1 `footer_hints_enabled` migrates to this setting. Footer renderer checks pass.
- **Single-line context and narrow layout:** Keep upstream measured footer layout, metadata shrinking, and minimum widths. Footer checks and 44/100-column production rendering pass.
- **Bare full terminal title:** Pass the complete session title to the terminal without a prefix or forty-character limit. Home retains `OpenCode`. Actual Ghostty title acceptance remains with integration.
- **Recent models:** Headings use `Recent · <provider>`. Recent provider groups and names sort alphabetically. Favorite order and full-catalog release ordering remain intact. Existing model-options tests pass.
- **Automatic-selection allowlist:** `model_allowlist` supports exact `provider/model`, `provider/*`, and `*`. Recent fallback, catalog fallback, and cycling obey it. Explicit manual picks remain available, then expire on leaving a chat. Disallowed durable session selections do not silently become automatic choices. Local-context checks pass. Manager owns provider blacklist/frontier policy and the Groq title-model exception.
- **Find in session:** `/find`, `/search`, and leader+F search real user/assistant buffers with literal smart-case matching. Native highlights mark matches. Enter/Down advance, Up/Shift-Enter reverse, and Escape closes. Separate occurrences on one wrapped line retain their identity after restyling. Production 44/100-column checks pass. Unicode widths, literal metacharacters, and cleanup pass.
- **Double-Escape withdrawal:** Capture the submitted prompt, attachments, pasted-text records, and cursor. Await admission, then call `session.inbox.withdraw`. Restore only for `{accepted:true}`. Stash any newly typed draft first. Preserve normal interrupt after text/tool output. Production renderer success/rejection checks pass against the checked core client contract. Core owns the atomic admission/delivery/output race.
- **Filled bullets:** Keep native Markdown list nodes and change unordered marker chunks to `●`, including streaming/restyle reconciliation. Keep ordered numbers, marker styles, and source text. Real Markdown and production session checks pass.
- **Drafts, cursor, attachments:** Keep upstream draft-stash and prompt history. Existing draft/history-provider checks pass. No duplicate persistence layer was added.
- **History retention and paging:** Keep upstream retention and row windows. Search requests the existing all-rows mechanism before scanning. Normal paging stays unchanged. Mount-budget and retention checks pass.
- **Navigation/paste/newline:** Keep upstream keymap and V1 command-name migration. Verify the current Home/End and last-message chords, command palette, sidebar, disabled variant cycling, non-preventing Ctrl/Super+V, and leader+F configuration through the migration test. The plugin stream owns backslash+Return. No physical keyboard remapping changed.
- **Tool/bash folding and links:** Keep real native tool/Markdown children. Publish source and tool anchors. Folding, wrapped/labeled link hit testing, dragging, and playback interactions belong to plugin acceptance.
- **One attached TUI switches across directories:** Match `event.data.client` before acting, bypass the directory guard only for matching targeted commands, and set `targetDirectory` before navigation. CLI carries the client ID even for explicit `--server`. Two simultaneous production renderer instances pass exact-target command and cross-directory isolation checks.
- **Targeted speech pause:** Matching `tui.command.execute` dispatches `speech.pause` through the ordinary keymap. Siblings ignore it. Agentview supplies the exact client and the plugin owns the command. Real detach/audio acceptance remains with integration.
- **Skill diagnostics:** `debug skill` lists discovered skills. `debug skill --diagnostics` prints loaded, skipped, shadowed, and unadvertised source evidence from the public location-scoped endpoint. The core diagnostics followup supplies its generated client boundary. The CLI handler uses the same location envelope as `skill.list`.

## Stable plugin contract

Additive slots:

- `prompt.metadata`: `{sessionID?, mode, showDetails}`, beside the built-in agent/model row.
- `session.composer.right`: `{sessionID}`, at the same right-hand metadata position.
- `session.footer`: `{sessionID}`, below the transcript and above the composer.
- `session.message.text`: `{sessionID, messageID, partID, text}`, around the real Markdown node.
- `session.message.tool`: `{sessionID, messageID, partID, tool, callID}`, around the real tool block.
- Existing `prompt.footer`, `prompt.footer.status`, and `prompt.footer.file` retain their inputs.

`partID` is `String(index)` in the original `message.content`, including reasoning and tools.
It is not the ordinal in a filtered text-only array.

Renderable IDs:

- Text wrapper: `message:<messageID>:part:<index>`.
- Tool wrapper: `message:<messageID>:tool:<toolCallID>`.
- Transcript scrollbox: `session:<sessionID>:transcript`.
- Zero-height bottom marker: `session:<sessionID>:bottom`.

Real `MarkdownRenderable`, `CodeRenderable`, and native tool descendants remain below these wrappers.
Plugins can find source identity without matching repeated text or guessing legacy headings.

## Core contract

- `POST /api/tui/select-session`: `{sessionID, client?, targetDirectory?}`.
- Global `tui.session.select`: the same payload in `event.data`.
- `POST /api/tui/execute-command`: `{command, client}`; HTTP requires the client.
- Global `tui.command.execute`: matching client bypasses the location guard.
- Capabilities: `tuiSessionSelect` and `tuiExecuteCommand`.
- `client.api.session.inbox.withdraw({sessionID,id})`: `{accepted:boolean}`.
- Withdrawal cutoff: a tool entry or nonempty assistant text after the prompt. Empty text/reasoning starts do not count.
- CLI `OPENCODE_TUI_CLIENT_ID` becomes `TuiInput.clientID` and `TuiTerminalEnvironment.clientID`. This works even when explicit remote attachment deliberately excludes the host shell environment.

## Verification record

All builds and tests use `python3 ~/.claude/scripts/heavy-job.py --wait -- ...`.
Long checks run under bounded monitors. Fixtures use private state and ephemeral HTTP ports.

- Dependencies installed in this worktree with the frozen lockfile.
- Focused footer, Markdown, search, model-options, draft, and history-provider run: 21 passed.
- Production TUI at 44/100 columns plus Markdown/search regression tests: 7 passed.
- Allowlist, upstream mount budget, retention, and interrupt rendering: 10 passed.
- Integrated targeting, withdrawal, source anchors, narrow/wide search, Markdown and allowlist suite: 12 passed, 58 assertions.
- `bun typecheck` in `packages/tui`: passed after the checked core contract was integrated.
- Core API commit `e2dcb39563` was cherry-picked here as `7bcfdc4a5b`. Manager already has this dependency; integrate only the interface commits that follow it.
- Final combined UI regression batch: 36 passed across 11 files, 131 assertions.
- Exact-client, narrow/wide search, and withdrawal acceptance repeated ten times: 50 passed, 150 assertions. Both attached fixtures disable unrelated tab persistence; the repeat run has no persistence-cleanup errors.
- V1 daily configuration migration and existing CLI config suite: 19 passed, 72 assertions.
- Initial interface push ran the normal canonical full lint and typecheck hook: 34 of 34 tasks passed.
- Core diagnostics commit `af8e18cc9d` was cherry-picked as `9228773577`. Manager should take the CLI followup commit, not this duplicate core dependency.
- Diagnostics CLI/public HTTP fixture and daily configuration migration: 2 passed, 8 assertions. `bun typecheck` in `packages/cli` passed.

## Integration acceptance still required

- Real Ghostty/agentview title, clipboard/paste, backslash newline, and navigation.
- Read-aloud audio, word highlight, Option-click, scrolling, media controls, stall recovery, and links during playback.
- Title, PR footer, context, hints, and speech controls together in the real narrow toolbar.
- Actual terminal detach pauses only its own speech player.

The worktree stays available for manager integration. No upstream PR or release is part of this stream.
