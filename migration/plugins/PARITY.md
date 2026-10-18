# User plugin V1 → V2 ports

Owner: `ses_eb44d042dffeEOciGkY6526ZX7`.
Integration baseline: `86c7f7c84048d776ba94b94bfab782b2b0a6d776`.
No live configuration, V1 installation, provider repository or shared source checkout was changed.

## Artifacts and configuration

- `package.json`: private portable `@moritz/opencode-parity-plugins` package, with native V2 `./server` and `./tui` entrypoints. The base package discovers both; `./server-only` allows separate UI ordering.
- `server.js`: native Promise-domain setup; maps actual leaf tool hooks, per-call cwd, shell session environment, event envelopes, durable synthetic admission, history and lifecycle cleanup.
- `bridge.js`: V2 wire/history projection used by the legacy memory/peers algorithms. It excludes idle/control records from V1-style message reads, preserves peer metadata and assistant parent relationships, and pages the session inventory.
- `memory.js`: durable native memory producer. Static rules, index, recalled context and mode are separate instruction entries; prompt/tool observations become ordered native updates. Consumption never removes a recall or rewrites the request system prefix. Mode, selected file names and retry identity use durable plugin KV, not a process-local frozen prompt.
- `tui.js`: native V2 setup for backslash-newline, clickable-links, fold-diffs, PR footer, dim session title, and peers UI. Runtime OpenTUI/Solid imports remain external and are supplied by the V2 host.
- `legacy/`: frozen compiled copies of all owned local server/TUI algorithms, plus pinned memory assembly/domain helpers. External source maps contain the complete inputs. `build.ts` reads `PARITY_SOURCE_CONFIG` (default `~/.config/opencode`) without editing it. The memory bundle exposes its existing store/recall/ownership objects to the producer; original algorithms and the installed V1 package stay unchanged. Original memory/Zod licenses and input hashes are included. Runtime modules do not read plugin source from live config.
- `config-fragment.json`: generated **merge fragment**, not a replacement config. Uses the server-only package and supplies all three memory agents with their original prompts/sandboxes. Recall uses `openai/gpt-6-luna`; extraction uses `anthropic/claude-sonnet-5-5`. Manual dream inherits the configured default model, matching V1. Automatic dreaming is disabled. Keep manager-owned provider/auth/model policy entries alongside it. `tui-fragment.json` provides ordered speech + parity UI declarations. Recall's original temperature zero is applied through the typed generation hook rather than an unsupported V2 agent-config field.
- Read-aloud original repository: `/Users/m/Code/opencode-read-aloud`, pushed branch `v2-plugin-port` based on pushed `origin/main` at `e7250b8`. Commits: initial adapter `41e698f`, native discovery/types `10ba454`, native command envelopes/modal+idle lifecycle `78e95d5`, legacy KV preference seed `91b4d3f6c1f102d9d81990dd9760bd6ed0bbc1ba`. The package dependency pins the latter. No merge, publication or live install.
- Read-aloud PR: [support native V2 TUI plugins alongside V1](https://github.com/moritzWa/opencode-read-aloud/pull/20).
- Read-aloud `opencode-read-aloud/tui` exports both V1 `tui(api, options)` and native V2 `setup(context)`; V2 normal package discovery uses this subpath. Explicit `opencode-read-aloud/v2` is also available. `./v2-compat` is shared by this package's UI adapter.

Recommended UI plugin order: read-aloud **before** parity UI, preserving original slot orders 50/100. Use `placement: "footer"`, Speechify `voice: "dominic"`, `model: "simba-3.0"`. Generated fragments use integration-relative directories: server `./migration/plugins/server-only`; TUI `./migration/plugins/node_modules/opencode-read-aloud` then `./migration/plugins/ui-only`. Install the pinned dependencies first, or resolve these to extracted/installed artifact directories. Local plugin targets are directories, not `.js` files or npm subpath install specs. Keep read-aloud out of server config: its legacy `index.tsx` is a TUI entrypoint.

Claude subscription/Keychain auth and fallback are supplied once by the separate directory `./migration/auth` (`server.ts`, implementation `src/plugin.ts`, plugin id `local.claude-subscription`). Its config fragment must accompany this one. No old fallback plugin is duplicated here. The Cursor provider is separately owned.

`@opencode-ai/plugin@1.18.34` is retained only for the original Zod `tool.schema`/definition builder used by memory, peers, monitor and worktree modules. It does not load a V1 core, SDK client or TUI runtime. V2 registration and execution use public V2 domains. All UI runtime imports stay external; the packed test checks host identity rather than accepting a second renderer instance.

`bun run accept` builds and verifies the packages, then writes deployable tarballs under `artifacts/` plus `artifacts/SHA256SUMS`. Those generated archives stay out of git. The tracked sources, lockfile and frozen modules are the integration changes. The test packs read-aloud from the exact installed/pushed dependency, not from an unpushed checkout or a disposable worktree.

## Behavior inventory

| Behavior | Implementation and checks |
| --- | --- |
| Legacy tool vocabulary/sandbox | All legacy custom tools register with `codemode: false`, preserving native monitor/peers/worktree/memory names. No `execute` permission is granted to memory agents. Actual extraction provider requests contain exactly `memory_save`, `memory_list`, `memory_read`; real `memory_save` writes an isolated file. Native MCP tools remain Code Mode tools. |
| Claude Bash hooks | Actual V2 `shell` tool normalizes to `Bash`; original hook payload/exit-2 contract retained. Per-call cwd is resolved; native write/edit `path` maps to Claude `filePath`. Fixture executes real hook subprocesses and checks block/allow/session/cwd. |
| Email hooks under Code Mode | Actual public SDK → SessionRunner → Code Mode → local `gmail-arca` MCP → parity hook → copied real `gmail-html-only.py` subprocess verified. Missing HTML and wrong MIME each block before the fixture sees a call; valid HTML reaches it exactly once. No real Gmail request is made. |
| Config autocommit | Original Edit/Write post hooks run for every patch add/update/delete/move and native path write. Test checks all exact per-file absolute paths and session identity. |
| Session shell environment | `shell.create.before.sessionID` becomes `CLAUDE_CODE_SESSION_ID`; existing env preserved. Monitor commands and hook subprocesses also retain the session env. |
| Monitor | Original matching-output batching, exit/timeout, stop/list, noisy cap, finite guard, process-group escalation, watchdog, re-wake/restart recovery and holds retained. SDK teardown/reopen of the same persistent DB kills the watch PGID, leaves `.cut.json`, and recovers exactly one durable synthetic notification to the original Session. The command is not replayed; holds and PGIDs are clean. |
| Background shells | Original Cursor private markers, native leftover detection, root-session routing, PID identity, logs, holds and restart adoption preserved. Native V2 backgrounds remain native; provider-originated marker shells are still watched. Test runs an actual detached shell and verifies completion output wake, then disposes/reloads in the same process and verifies released-hold adoption and notification. Pending settle timers are explicitly cancelled on plugin disposal. |
| Worktrees | Original `.claude/worktrees`, main-root lookup, exclusions, existing branch adoption, dirty refusal, forced removal and merged-only branch deletion retained. Real git fixture verifies create/list/dirty refusal/remove. Native V2 worktree tools do not replace these different semantics. |
| Spawned hierarchy | Same append-only agentview `session-parents.jsonl`, recent-session detection and subagent root mapping. Test delivers created event + actual shell output and verifies hierarchy record. |
| Adrafinil | Original session-created acquire command retained, default enabled; optional `adrafinil: false` supports isolated/non-mac tests. Real user app is not invoked in fixture tests. |
| Shared Claude memory | Pinned original `opencode-claude-memory@2.0.2` tools, files, recall, extraction, catch-up and owned helpers. Real original selector → native forced-object provider round trip, parent isolation and fork cleanup verified. Native entries preserve memory wire-cache prefixes, first-user selection, updated content, ignore/resume, compaction and restart. Automatic dreaming stays off; paid credential-backed acceptance is manager-owned. |
| Peers server | Pinned `opencode-plugin-peers@0.2.4`: session endpoints, HTTP listener/registry, hold/refuse policy, durable spool/outbox/ACK/status, protected-permission logic, commands, immediate synthetic steer admission and teardown. Tests cover real local HTTP peer delivery, injected metadata/session/resume, receipt query and listener disposal. |
| Peers TUI | Original command palette, exact/unambiguous single-Enter shortcuts, argument submission, home-session creation and dialogs mapped to native keymap/router/dialog/client APIs. |
| Backslash newline | Original cursor-native offset handling, backslash deletion and newline insertion retained; fallback returns false to let native Enter submit. Same logical Return binding; no Karabiner changes. |
| Links | V2 App owns native `getLinkAt` links; legacy code handles only missing-attribute Markdown fallback during highlighting. First concealed label cell accepts the opening-bracket raw offset. Actual App tests at 44/80 columns verify exactly one native/fallback opener for raw/wrapped/label-first/label-last, zero for Option/drag/word-selection. Removing only the guard produces two opens, proving the negative control. |
| Fold diffs/bash | Original folding controls, defaults, stats, error visibility, command/output folding retained. Compiler adaptation recognizes native transcript IDs and nested path heading children. No private TUI module import. |
| PR footer | Original fork-aware `gh pr list --head`, state/draft colors, cache/idle/timer refresh, directory lookup and browser click retained. |
| Session title | Same dim measured/clipped max/min title, native composer-right slot, reactive title state. |
| Complete read-aloud | Same original player/script/media/answer/view algorithms: sentence/word highlight, prose filtering, Option-click/double-click exact-word seek, older-answer resume, pause/rewind/restart/speed/footer controls, lazy per-piece synthesis, persistent audio cache, ffmpeg/device stall recovery and macOS media controls. V2 adds identity-based wrapper lookup, native keymap/storage/events/theme/slots and disposal. Existing V1 tests plus V2 adapter/real-renderer tests pass; actual candidate-loader packed verification results belong below. |

### Speech state and data

The adapter seeds missing requested preferences from copied `$XDG_STATE_HOME/opencode/kv.json`. Explicit `options.legacyKV` or `legacyKVPath` can supply a candidate seed. Existing native plugin preferences win. Only keys the plugin reads are persisted; the original KV file is read-only. The source KV audit found `speech_speed: 1.9`; `speech_rate: 1.5` is an older, separate preference and is not substituted.

Keys retain the original `$XDG_DATA_HOME/opencode/speechify.key` / `elevenlabs.key` paths or environment variables. Logs remain `data/opencode/log/read-aloud.log`. Audio stays in `$XDG_CACHE_HOME/opencode/speech` with unchanged cache keys. Candidate assembly must copy these into its isolated roots to reuse cached audio. No credentials are embedded in the artifacts.

Memory documents/index retain `$CLAUDE_CONFIG_DIR/projects/<canonical-project-key>/memory`. The original extraction/dream watermarks and maintenance state live separately under `$CLAUDE_CONFIG_DIR/opencode-memory/<project-key>`; copy both roots for an isolated profile. Native producer state and instruction epochs live in the V2 DB/KV and survive its reopen.

For rehearsal, server option `memoryConfigDir` injects `CLAUDE_CONFIG_DIR` into only the original memory factory's copied environment. It is outside the strict original `memory` options schema. Process environment and Claude-auth account discovery remain unchanged. Production omits this option and continues sharing the ordinary Claude root. The focused isolation regression checks document/state paths, unchanged process/auth environment, and default behavior before/after the override.

## Agreed host contracts

- Core: public Promise+Effect shell hook has optional `sessionID`; leaf tool before/after hooks have optional `cwd`. Core supplies actual normalized MCP tool leaf input/result and current Location cwd. No parallel hook wrapper is introduced in the plugin.
- Core: `session.active()` supports peers discovery. `message.list` pages the full raw transcript across compaction, including unsettled assistant output; envelope remains `{data,cursor}`. The bridge requests 200 ascending rows, omits order on cursor pages, stops empty, then filters control rows and applies visible limits. `session.context` remains the intentionally current model window for recall preparation. No private Core imports or lossy export API.
- Core: `session.generateObject` resolves `{object}` (wire `{data:{object}}`), forces only the output carrier and validates the original schema. All Promise API methods forward cancellation. No prose-JSON fallback.
- Core: existing `session.instructions.entry.list/put/remove` supplies durable native sources and chronological changes. Prompt preparation runs before initial materialization; tool observations update before the next boundary. Existing durable plugin storage preserves producer mode/selection/retry identity. No Core history redesign or in-memory system freeze.
- UI: `session.composer.right`, `prompt.metadata`, `session.footer`, `session.message.text`, and `session.message.tool` are native slot paths.
- Text wrapper: `message:<messageID>:part:<String(contentIndex)>`. Index includes reasoning/tools. Wrapper retains real MarkdownRenderable descendants. Ownership is read by walking parents, avoiding text collisions and quadratic transcript searches.
- Tool wrapper: `message:<messageID>:tool:<callID>`; slot publishes `{sessionID,messageID,partID,tool,callID}`.
- Transcript: `session:<sessionID>:transcript`; bottom marker `session:<sessionID>:bottom`.

## Verification commands and evidence

All finite checks run through `python3 ~/.claude/scripts/heavy-job.py --wait --`; queue waits are bounded monitors. Test HOME/XDG/Claude roots are temporary and removed after process/listener/renderer cleanup.

- Read-aloud: `bun test` — 20 tests, 79 assertions passed. Word/sentence render highlighting, clicked offsets, older-answer resume, lazy player/script behavior, native KV seed, modal/command/event mapping and V1 behavior covered. Frozen dependency install checked without changes.
- This package: `bun run verify` builds inputs/config, then runs four primary child-process scenarios (port/lifecycle, packed TUI, actual combined SDK, actual cache wire policy) plus focused memory-root isolation cases. Child scenarios use strict Node assertions; outer Bun counts report only subprocess outcomes.
- `test/packed.test.js` packs BOTH packages, installs the tarballs into a fresh root with OpenTUI 0.5.17/Solid 1.9.15, and uses the actual candidate `Host.resolve`, `createPluginSources`, TUI runtime support and native renderer. `OPENCODE_V2_HOST` selects the candidate source checkout. This checks V2 package discovery/shared runtime, not just the legacy test renderer.
- Port scenario: real hook subprocesses, git worktrees, monitors, detached shells, same-PID adoption and peer HTTP receipts. Full transcript paging fixture covers pre-compaction rows, live partial output, controls, limits, no duplicates, cancellation and unchanged input. Packed native storage seeds 1.9, persists 2.2 and keeps the native value after reopen.
- Combined scenario: actual public SDK, local model SSE and local MCP. Real Gmail hook enforcement, native shell env/write, extraction's three-tool sandbox plus real file, original selector's forced object round trip, and same-profile DB close/reopen with two exactly-once synthetic recovery wakes. Commands run once, all holds/owned PGIDs clean. Latest focused pass: 13.08 seconds.
- Cache scenario: genuine empty first-user parent; selected A on the first provider request; exact old system/message prefix through consumed recall, tool loop, live/idle index edits, new selected B and ignore. Real native compaction resets the epoch; SQLite SDK reopen preserves ignored mode and the new epoch prefix. Explicit resume reads edited memory and index via chronological updates. Latest focused pass: 1.298 seconds.
- Final `bun run accept`: **4 scenarios passed, zero failures, 31.02 seconds**, then both runtime tarballs packed. This also verifies selected-file content changing during a tool loop is delivered without rebuilding the old prefix. The five outer Bun assertions count subprocess outcomes; the child scenarios contain the behavior assertions described above.
- UI-owned production link proof: commit `9c2c81b871` (integrated as `36566c0301`), real App + actual artifact at 44/80 columns, safe opener recorder, negative control. Repeated combined link batch: 60 tests, 290 assertions, zero failures. SGR has no Cmd bit; this proves a forwarded unmodified packet, not OS Ghostty interception.

## Remaining integration acceptance gates

These are explicit, not silent omissions or claims of live parity:

1. Manager owns paid, credential-backed memory selector/extraction and provider smoke with the final candidate config. Local provider tests prove behavior, not account authentication/quota.
2. Manager owns real Ghostty/agentview/audio acceptance: by-ear playback, media keys, device switch/stall recovery, seeking/resume, narrow/wide controls and OS-level Cmd interception. No live install/restart or physical audio claim is made here.
3. Outer process crash/restart remains a manager service-level check. SDK teardown/reopen of a real persistent profile is verified, including `.cut` intent, background adoption, exactly-once durable wakes, no replay and PGID cleanup.
4. Adrafinil real app acquisition is a candidate-host check; isolated tests keep the user app untouched.

No user-facing feature is intentionally removed. Until these integration gates pass, the migration is **not done** and live V1 remains the fallback.
