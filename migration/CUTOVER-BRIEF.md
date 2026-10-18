# Outside-V1 cutover coordinator implementation brief

Manager owns authority switch, global wrappers/install helper, checkpoint coordination, final execution. Coordinator implementation owner owns ONLY `migration/cutover/**`. Do not execute live stop/install/start/adoption/prompt operations while implementing. Return checked commit/source handoff; manager explicitly arms execution.

## Accepted source and profile

- Worktree `/Users/m/Code/opencode/.claude/worktrees/v2-migration`, local branch `v2-migration`, published `fork/v2-parity`, current runtime HEAD `8806e2cdf305647b134e3523f21b731a11dfbd00`.
- All runtime/source/canonical/paid vendor/memory/history/compaction/MCP/native compiled and real full-stack Ghostty/agentview/audio/Todo acceptance has passed. Production build includes web assets.
- Fresh production profile `/Users/m/.local/share/opencode-v2`, `profile.json` with environment, immutable accepted archives and installed dependencies. NO production DB/server yet. Rehearsal profile is separate; never promote its test KV/history.
- `rollback/manifest.json` preserves exact old `opencode-dev` and stock `~/.opencode/bin/opencode` binaries, config, private supervisor pre-freeze copy. Original live DB is `~/.local/share/opencode/opencode.db`; never migrate/write it. Preserve fresh standalone frozen snapshot and production DB copy.
- Approved global installer `~/.claude/scripts/install-latest.sh` now supports V2: `INSTALL_LATEST_OPENCODE_V2_REF=fork/v2-parity INSTALL_LATEST_NO_RESTART=1 ... opencode`. It builds PUSHED source, installs native binary at `PROD/bin/native/opencode-dev`, installs logical wrappers at both `~/.local/bin/opencode-dev` and `~/.opencode/bin/opencode`, updates production profile executable, retains selected-ref file. Wrapper exports profile.environment; while `PROD/runtime/cutover.pending` exists, ordinary launches exit75; `OPENCODE_CUTOVER_COORDINATOR=1` bypasses.
- After native service startup, set `profile.serviceFile` to actual native private registration path. Then approved `install-latest.sh agentview` builds current origin/main and installs native at `PROD/bin/native/agentview` plus logical launcher. Parent exports ONLY API=v2/serviceFile (keeps every other harness XDG path unchanged), defaults --opencode-bin to logical opencode-dev only if not supplied, dynamically returns to original routing when selected-ref file is cleared.
- Explicit exact-binary rollback via approved helper: `INSTALL_LATEST_OPENCODE_V1=1 INSTALL_LATEST_OPENCODE_ROLLBACK=PROD/rollback/opencode-dev-v1 INSTALL_LATEST_NO_RESTART=1 install-latest.sh opencode`. It hash-verifies preserved V1, restores both CLI entries and clears selected ref; dashboard launcher then uses original global paths. Do not ad-hoc install reserved binaries.

## Quiescence and preserved work

Manager session `ses_eb9f07705ffeNJGcxTvu16q0bv`, directory `/Users/m/Code/opencode`. This final coordinator must execute outside V1, e.g. launchd one-shot under shared `heavy-job.py --wait` (one outer wrapper, do not nest payload wrappers). Wait for manager's core session status to become idle after it arms readiness and ends its turn; don't stop its API while it is still coordinating.

All three other active sessions have explicit settled checkpoints and stopped their own V1 watchers:

1. `ses_eb30a3117ffeDyAGrT5lRycVxa`, `/Users/m`, `/Users/m/beeper-companion-netwatch/CHECKPOINT.md`.
2. `ses_f01e25e61ffe4tn49x10ZJtk3X`, `/Users/m/Code/arca`, `/Users/m/Documents/arca-outreach-plan/bench/labelers/v1-v2-checkpoint-ses_f01e25e61ffe4tn49x10ZJtk3X.md`. User subsequently requested read-only checks; checkpoint updated, no external writes, include NEW history in final snapshot. Await renewed quiescence, don't use an old frozen backup.
3. `ses_ece25eb68ffe1SopY2ZHqcvXIu`, `/Users/m/Code/arca`, `/Users/m/.local/state/opencode/chatgpt-plugin-v2-checkpoint.md`.

Original inventory at PROD/runtime/v1-inventory.json has17 visible sessions. Preserve all history and managed ownership where valid, not only active roots. Completed/waiting/uncertain sessions adopt resume:false. Other three tasks are explicitly continued by the successor only AFTER switch, with checkpoint paths and no blind external-action replay.

## Existing V1 controller/process facts

- Original GLOBAL supervisor `~/.local/state/agentview/opencode/server.json`, private credential record. Resolve actual current PID/port from it; credentials never argv/logs.
- Current host dashboard observed PID/PGID4090, command `agentview --opencode-bin /Users/m/.local/bin/opencode-dev --include-external --include-interactive --no-host-claude`; child V1 TUI PID/PGID9283. Revalidate process identities before any signal; don't assume PIDs remain. Do not signal host Ghostty app, browser/VM/Beeper or unrelated programs. Dashboard currently holds older inode but supports V2; fresh installed process still needed for default profile env.
- Crossprocess V1 lock GLOBAL/agentview/opencode/server.lock: private current-user regular file, O_NOFOLLOW, blocking POSIX flock EX. Preserve inode and parent; no rename/unlink lock while held. Old dashboard workers must stop, not remain blocked and restart V1 on unlock. Direct old HTTP/TUI bypass lock, so terminate exact old frontend/backend processes after settled status.
- Production refinement: V2 child profile keeps CONFIG/DATA/CACHE and native DB isolated, but XDG_STATE_HOME is the original GLOBAL state root. Parent dashboard keeps its GLOBAL XDG paths. Compatible model.json preferences, working holds and hierarchy thus align naturally, without moving Codex/other harness state or credentials and without symlinks. Installer generator tests assert this minimal parent routing.
- New V2 supervisor therefore reuses GLOBAL/agentview/opencode directory and SAME lock. Back up V1 records at freeze; clear ONLY old ownership/server records in place under the held lock, preserve lock inode/parent and unrelated preferences/other harnesses. Release and close lock before handoff-import (which reacquires it), while logical launcher pending gate and stopped old dashboards still fence new launchers.

## Concrete sequence

1. Dry preflight: profile/artifacts/checkpoints/rollback/source ref/launcher generator proof, exact server/dashboard identities, operational journal/private permissions; no live writes/actions. Explicit execute/arm flag required.
2. Acquire healthy shared slot BEFORE downtime. Wait manager and other identified sessions idle; refresh read-only inventory. Fence new cooperating launches, acquire old supervisor lock.
3. Stop/reap only verified old dashboard/frontends/backend; wait finite termination, escalate only their groups. Confirm original DB has no writable handles and V1 endpoint no longer serves before snapshot.
4. Existing backup helper: `python3 migration/backup.py PROD` takes consistent readonly source backup to fresh PROD/data/opencode/history-v1.db and updates profile.environment.OPENCODE_DB. Refuses overwrite. Native backup/reopen counts/quick_check must pass. Keep original DB intact as rollback. Add immutable retained snapshot if needed, not another live copy after stop.
5. Existing OFFLINE helper from package CLI working dir: `bun run ... migration/refresh-history.ts PROD` composes only Database+Global, imports credentials and durable history, no provider/MCP/tool execution. Then `bun migration/audit-history.mjs PROD`; require no real missing/changed/warnings. It validates every source-ID projection and strict derived notice aliases.
6. Approved install-latest opencode V2 using pushed ref with NO_RESTART1. Record installed runtime hash/version, wrapper routing proof, production DB/config paths. Installer writes selected ref; pending gate stays present.
7. Start native V2 service through new logical wrapper, `serve --service --hostname 127.0.0.1 --port PORT`; no old server alive. Discover actual PROD/state/opencode/service*.json generated by CLI; don't manufacture its credential record. Verify listener PID and authenticated /api/info PID, version and targeted capabilities. Store exact registration path in profile.serviceFile.
8. Approved install-latest agentview with selected ref active and NO_RESTART1. Parent launcher exports ONLY API=v2 + serviceFile, preserving global XDG for other harnesses. Current origin/main may be newer than293; preserve latest pushed app changes. Difference through d547230 is usage forecast only plus CI fixture, not provider protocol.
9. With native connection, validate full handoff manifest against native GET session info + newest message watermark/timestamps/agent/model/location. Read original source states; adopt completed/waiting/uncertain resume:false. No automatic replay of interrupted/uncertain tools. Handoff import itself does not start or prompt; the new ownership map must be empty after V1 record backup. See current origin/main docs/opencode-v2-parity.md. Supervisor lock is SAME GLOBAL path: release before invoking CLI under the still-pending gate and coordinator bypass.
10. Verify ownership/list/transcripts/default paths/service health. Remove pending gate only after authority is ready; release old lock, never wake old dashboard workers.
11. Actual user dashboard relaunch is allowed as final handoff, not a GUI test. Preserve original flags and open a fresh host Ghostty window via explicit initial-command (not bare -e; macOS treats args as files). Do not inject blind text into an existing terminal. Do not close other windows/apps. Keep last app/focus impact minimal.
12. Durably journal a stable new msg_ ID before ONE explicit new native prompt to original manager session, now completed and migrated. This is a new final-verification phase, NOT handoff-resume of an interrupted tool. Prompt contains journal/status/checkpoint paths, requires actual installed/running/default path verification, native tool smoke, continuation of three paused tasks with guards, source/branch/worktree/child cleanup and final user signoff. No unrelated old session auto-resumes. New V2 model should be actual available Sol per preserved session choice unless invalid; use public model control if necessary. Lost ACK reconciliation must reuse this input ID.
13. On failure before authority, journal concrete phase/error and restore V1 through approved exact rollback helper; keep original DB/config/supervisor. Restore actual old service/dash safely, no blind externals. Never claim success because a command exited0. Don't leave user with both authorities writing.

## Implementation constraints

- Public/native APIs, private files, finite wait bounds; no production DB writes besides the fresh native target import.
- Credentials only files/env/basic headers, never argv/console. Journal whitelisted metadata only; no process env dumps.
- Source-appropriate tests in isolated fake service/process/file fixtures, not live integrations. Exercise actual phase logic, not mirrored code. Meaningful refusal/identity/failed-phase behavior.
- Controller must survive V1 termination; source launchd one-shot/private runtime files are okay. Manager installs/arms it after review, no auto live run from tests.
- No permanent new VM/devserver/model jobs; all implementation-owned jobs stop. Actual production native service intentionally survives as user-owned app after verified cutover.
- Return files, test commands/results, exact commit or manager-stage paths, how to arm/dry-run, any genuinely unresolved expensive fork. Do not silently expand into generic migration framework.
