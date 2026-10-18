# Outside-V1 cutover controller

Manager review and explicit arming are required. Implementation tests do not
stop, install, import into, prompt, or open the production application.

## Files and execution boundary

- `controller.py`: read-only preflight, arm plan, bounded phases and recovery.
- `host.py`: macOS kernel identities, private files, bounded subprocesses,
  listener/writable-handle checks and authenticated APIs.
- `dashboard.py`: private PID/start-token receipt followed by `execve` into the
  requested dashboard command.
- `test_controller.py`: isolated SQLite and authenticated loopback HTTP fixtures,
  fake process/install/GUI boundaries, and a read-only kernel self-identity check.

Read `migration/CUTOVER-BRIEF.md` before operating this controller. Its global
state refinement takes precedence over the older profile-local lease example:
config/data/cache and the native database are private to production; both parent
dashboard and V2 child use the existing global `XDG_STATE_HOME`. The actual lease
path is discovered from that global state directory.

Read-only `preflight` and `arm` may run from V1. `execute` refuses a V1 ancestor
or a shared V1 process group. The generated launchd job runs one outer
`heavy-job.py --wait` wrapper, before downtime. It is one-shot (`KeepAlive=false`)
and is never bootstrapped by `arm` or by the tests.

## Manager-prepared inputs

Use private files owned by the current user (0600) and private runtime
directories (0700). Do not put credentials in this source directory or command
arguments. The CLI accepts only the production profile
`~/.local/share/opencode-v2`; tests construct temporary settings directly.

Create `PROD/runtime/cutover-config.json`. An empty JSON object uses the brief's
defaults, including the three checkpoint paths, manager session, production
profile, worktree and `fork/v2-parity`. Refresh `dashboardPID` and `frontendPIDs`
to the reviewed live processes rather than assuming the historical defaults
4090 and 9283 remain current. Backend PID/port/auth come from the real private
global supervisor record, not configuration overrides.

Optional configuration keys are listed in `Settings.load`. Paths must be
absolute. Keep the normal parent global XDG routing. The generated
`opencode.jsonc` must be JSON encoded, as emitted by the profile assembler.
Its Todo plugin's static `legacyDatabasePath` must already name
`PROD/data/opencode/history-v1.db`: the backup helper changes `OPENCODE_DB`, not
that plugin option. The controller verifies this before downtime and does not
rewrite the prepared config.

The manager supplies `PROD/runtime/cutover-approval.json` with this shape, using
actual checked helper hashes and actual process-proof results:

```json
{
  "version": 1,
  "checks": {
    "cliPendingGate": true,
    "dashboardPendingGate": true,
    "parentGlobalXdg": true,
    "childProfilePaths": true,
    "exactRollbackVerified": true,
    "pendingBeforeSelection": true
  },
  "installerSha256": "<checked install-latest.sh SHA-256>",
  "helperSha256": {
    "/Users/m/.claude/scripts/opencode-bg.sh": "<checked SHA-256>",
    "/Users/m/.claude/scripts/opencode-message.py": "<checked SHA-256>"
  }
}
```

These booleans attest manager-owned launcher/rollback acceptance; this controller
does not replace that acceptance with source-string checks. Additional checked
helper paths may be included. Their hashes are revalidated before execution.

Preflight also requires the prepared immutable five-archive manifest, installed
plugin dependencies, exact binary rollback manifest/config backup, initial
`runtime/v1-inventory.json`, checkpoint files, current private lock and healthy
authenticated V1 endpoint. Runtime and helper code must be committed and pushed;
the source runtime must match the accepted baseline. Changing sealed inputs
requires a new arm plan.

## Dry preflight and arming

Commands below are operator instructions, not actions performed during
implementation. Set `PROD` and `SOURCE` to the production profile and this source
directory. Run from an existing directory outside the repository-root Bun test
guard; `migration/cutover` is suitable.

```sh
python3 ~/.claude/scripts/heavy-job.py --wait -- \
  python3 "$SOURCE/controller.py" preflight \
  --config "$PROD/runtime/cutover-config.json"

python3 "$SOURCE/controller.py" arm \
  --config "$PROD/runtime/cutover-config.json"
```

`preflight` makes no runtime writes. `arm` creates only private control files: a
run plan, fingerprinted read-only copies of the three executable Python sources,
an empty private launchd log and a plist. It prints the exact plan/plist/label and
bootstrap argument vector. No application gate, service or window changes yet.

Before bootstrap, the manager writes `PROD/runtime/cutover-ready.json`:

```json
{
  "runID": "<runID from this exact plan>",
  "managerSessionID": "ses_eb9f07705ffeNJGcxTvu16q0bv",
  "ready": true,
  "expiresAtMs": 0
}
```

Replace zero with a future epoch-millisecond expiry no later than the plan's
`createdMs + 1800000`. The manager must have settled the checkpoints, including
new recruiting read-only results. Bootstrap the exact printed plist with
`launchctl bootstrap gui/UID PLIST`, then end the V1 coordinating turn. The job
waits for readiness and stable idle status across all known source directories;
it does not stop a still-coordinating manager. Plans expire after 30 minutes.

Do not run `execute` directly from V1. The plist's explicit
`execute --armed --plan ...` is the live transition entrypoint. Do not add a
second heavy-job wrapper inside the payload.

## Durable evidence and authority

The run directory contains `journal.json`, phase logs, the full adoption
manifest, source/final inventories and the stable successor request. The stable
pointer is `PROD/runtime/cutover-status.json`. Backups live under
`PROD/rollback/RUN_ID`, including original supervisor/config/state evidence and
the retained source snapshot. Original live V1 database/config remain intact.

The existing global supervisor lock inode is preserved. Old workers are stopped
before unlock. The controller closes its exclusive lock before `handoff-import`,
which reacquires it, while the pending launcher gate still fences new launches.
All adopted sessions have `resume:false`. Checkpointed roots attest settlement;
unrelated historical sessions do not receive invented settlement attestations.
Stale deleted ownership is recorded separately and archived sessions remain in
history. Visibility checks respect existing hidden-session state.

Authority transfers only after native runtime/lease/listener/API identity,
installed binary hashes, dashboard source receipt, ownership, transcripts and
model/default-path checks pass. The pending gate is then removed. The final
Ghostty launch uses its explicit `-e` argument vector (verified on the host); a kernel PID/start-token and
executable receipt verifies the new dashboard. It does not close other apps or
inject keys into an existing terminal.

`handoff_admitted` means exactly one durable successor input was accepted or
found under the stable input ID. It does **not** claim the successor has finished
native tool smoke, resumed the three guarded tasks, cleaned up source/children,
or delivered the final user signoff. Those instructions are in the new prompt,
along with checkpoint and journal/status paths and the requirement to compare
latest imported messages before continuing work.

## Recovery

Use the immutable runtime copy next to the plan, with the same shared heavy-job
guard. Do not edit the journal to manufacture success.

```sh
python3 ~/.claude/scripts/heavy-job.py --wait -- \
  python3 "$RUN/code/controller.py" recover --armed --plan "$RUN/plan.json"

python3 ~/.claude/scripts/heavy-job.py --wait -- \
  python3 "$RUN/code/controller.py" reconcile-successor --armed --plan "$RUN/plan.json"
```

- Before V2 authority: failure attempts the approved exact V1 binary rollback,
  verifies the actual recovered service and reopens the original dashboard flags.
  It sends no V1 prompts. Repeated successful recovery verifies its receipt.
- Unknown identity, replaced lock, surviving unverified process group or an
  interrupted spawn/journal window leaves `failed_fenced`. Preserve the gate and
  original data; inspect private logs and actual process/port ownership before
  any operator recovery decision. The controller does not guess which process
  to kill or start a competing authority.
- After V2 authority: failure leaves `v2_needs_recovery`; automatic V1 rollback
  is refused because native user work may exist. Restore native health first.
  `reconcile-successor` checks durable message/inbox state and reuses the same
  input ID. A different body under that ID is a refusal, not another prompt.

Once the one-shot has exited, the manager can `launchctl bootout gui/UID/LABEL`
using its printed label. Production service/dashboard are intentional user-owned
applications; cleanup of migration worktrees/branches/children belongs to the
successor after final verification.

## Isolated acceptance

```sh
python3 ~/.claude/scripts/heavy-job.py --wait -- \
  python3 -W error::ResourceWarning -m unittest discover \
  -s "$SOURCE" -p 'test_*.py' -v
```

The suite exercises actual phase logic, fresh SQLite backup/history, metadata
adoption, process identity refusal, read-only arming, lock replacement, private
hold retirement, rollback, authority boundaries, lost ACK reconciliation and
input collisions. Installer, application process control and GUI operations are
fakes. Loopback servers and temporary fixtures are closed by test cleanup.
