# Claude subscription auth and durable fallback

## Entrypoint

`server.ts` reexports the V2 Promise plugin `local.claude-subscription` from
`src/plugin.ts`; package exports include both `.` and `./server`.
`config-fragment.json` is merged into the manager's isolated V2 configuration.
Its configured plugin target is the **directory** `./migration/auth`, resolved
against that configuration's directory. Native configured plugin normalization
rejects standalone source files. Use an absolute directory `file://` URL when
the configuration lives elsewhere.

The package pins `opencode-claude-auth` 2.2.1 (MIT; notice in `THIRD-PARTY.md`).
It imports only that package's transport/Keychain/lock modules and does **not**
invoke the V1 plugin. A normally installed dependency is resolved from this
package. `options.legacyRoot` may instead point at a copied/installed 2.2.1
package directory in an isolated trial. It is a directory, not the JS entrypoint.

Artifact version **0.1.2** retains the 0.1.1 loader fixes and imports runtime values from the documented
`@opencode/plugin` root. The host supplies that SDK at runtime; its optional peer
declaration does not install a published SDK copy. Default dependency discovery
uses ESM import-condition resolution, then walks up to the manifest named
`opencode-claude-auth` at version 2.2.1. An entry inside `dist` therefore resolves
the package root, not `dist/dist`. Importing the modules does not read account
credentials or the persisted account selection; that selection reader is lazy.

Options:

| Key | Default | Purpose |
| --- | --- | --- |
| `accountSource` | Existing persisted account source, then first discovered account | Default Claude Keychain/file source |
| `legacyRoot` | Resolved pinned dependency | Explicit portable dependency location |
| `diagnostics` | `~/.local/share/opencode-v2/claude-subscription/diagnostics.sqlite` | Secret-free bounded diagnostics database |

The V2 Anthropic integration gains an external "Claude Code subscription
(Keychain)" method with an account selector. It stores only the source name in
V2 metadata. Active external-account selection overrides the default source.
Tokens remain in the existing Keychain/Claude credentials file. The provider is
enabled with a non-secret placeholder credential so native model initialization
does not require a paid API key. Anthropic model costs are zeroed for subscription
reporting. All its HTTP requests are sent through an authenticated loopback-only
gateway, which installs the actual subscription bearer token and removes API keys.

## Preserved behavior

- Primary and suffixed Keychain accounts, credentials-file fallback, existing
  account labels, external source re-read, and compare-before-write rotation.
- Subscription identity, signed billing system block, OAuth request headers,
  tool-name transformation and streamed reverse transformation, orphan-tool
  repair, model effort compatibility, and bounded long-context beta removal.
- Existing work billing whitelist: the first directory component under
  `~/Code` must be `arca`/`science-website` or start with the repo name plus `-`.
  Missing/unreadable directory is personal. `arcafoo` is personal.
- On explicit model-quota/capacity evidence, work Claude first tries the matching
  Cursor 1M model, then the unmodified model, then legacy work candidates.
  Personal requests use the existing OpenAI subscription candidate order, led by
  `openai/gpt-6.1-sol`. Personal requests can never select Cursor.
- Auth outages use exactly `openai/gpt-6.1-sol`, for both personal and work requests:
  this is a personal subscription route and does not add work billing exposure.
- Auxiliary title/compaction/generate requests do not initiate primary recovery.
  Child Sessions are not detached and revived by the plugin.
- Default model selection remains the configuration owner's decision.

## Intentional corrections

- Refresh throttle, network failure, upstream 5xx, rejected/revoked credentials,
  malformed refresh responses, store failures, and another refresher holding the
  lock have distinct structured categories. No network/5xx failure is fabricated
  into a quota or a generic 429.
- Transient refresh work has a 75-second deadline, at most eight exchanges, a
  per-exchange 15-second timeout bounded by the remaining deadline, and an
  abort-aware backoff. Retry-After is respected within the deadline. Expired
  requests cannot be kept alive indefinitely by generic model retries.
- The refresh endpoint's status, reason code, and Retry-After milliseconds remain
  in the structured provider error. Network failures have no upstream status.
  A local 503 represents gateway unavailability, not an invented upstream 429.
- Generic prose such as "Claude token refresh is rate-limited" is **not** quota
  evidence. Bare model 429 stays model-throttle; explicit quota classification,
  quota reason codes, or a rejected specific unified subscription window permit
  quota fallback. The gateway records the rejected 5h/7d/7d_opus window alongside
  the original upstream reason. A disabled-overage header alone is insufficient.
  Cursor `capacity_limit` is explicit.
- V1's idle/no-output guess and detached abort-and-reprompt are replaced by an
  in-drain core recovery hook. A merely idle, completed, or cancelled Session
  cannot be awakened by an auth sweep. There is no sweep or background timer.
- Recovery allowance is one per latest promoted user message, persisted in the
  Session transcript. Fallback failure is terminal rather than walking a loop.
  A new user request gets its own allowance.

## Durable core seam

The companion `auth-recovery` branch owns:

- `packages/plugin/src/{effect,promise}/session.ts`: recovery hook and optional
  stable primary user/assistant identities on retry events.
- `packages/core/src/session/runner/{llm,retry,recovery}.ts`: typed failures feed
  policy inside the current serialized drain. Model selection and the recovery
  synthetic marker are committed by one `Bus.publishAll` transaction.
- `packages/core/test/session-runner-recovery.test.ts` and its real-HTTP fixture.

The operation identity is the Session ID plus the latest promoted user-message
ID. A durable synthetic marker records that identity and the failed assistant ID.
Only the active primary drain can commit it. An interruption while policy awaits
inventory stops the drain before commit. A crash observes both new model and
marker or neither. Restart uses the existing execution recovery claim and reloads
projected history; the marker prevents another model recovery for that input.
No public `switchModel`/`synthetic(resume:true)` pair is used: those separate calls
cannot provide the required cancellation and atomicity guarantees.

Completed tools remain in the durable history. The recovery path never invokes
tools itself and reloads projected history before the next single `llm.stream`.

## Diagnostics

SQLite retention deletes rows beyond the latest 2,000 entries in each append
transaction. The database is owner-only, uses WAL, and survives process restart.
Fields are timestamp, validated Session ID, category, upstream status, allowlisted
protocol reason, Retry-After milliseconds, and recovery action. No credential,
header dump, arbitrary upstream prose, request body, or tool output is persisted.
Unrecognized reason strings become `unrecognized_upstream_error`.

## Evidence

All checks use the shared `heavy-job.py --wait` queue. Tests use real loopback
HTTP, real refresh POSTs to injected fault servers, real SSE parsing, persistent
credential files, real diagnostics SQLite, and the production V2 runner.
The completed-tool scenario registers the production `WriteTool` and inspects
the resulting file and durable tool record; there is no substitute fake tool.

Verified checks:

- Auth package typecheck passed.
- Eighteen auth/HTTP/SSE/classification/billing/concurrency/diagnostic/combined-runner/native-loader/compiled-loader/compressed-hop
  scenarios passed. Brief 503 refresh failure made two actual refresh requests,
  stayed Claude, and never called recovery. Persistent 503 made eight actual HTTP
  refresh requests across a controlled 75-second policy clock, preserved status
  and category through the real Anthropic parser, and resumed the original prompt
  exactly once on the actual Sol response parser.
- Core package typecheck passed.
- Five real HTTP runner fault tests passed: once-only fallback with a completed
  production WriteTool retained, terminal fallback failure, cancellation while
  policy waits, concurrent Sessions each recovering once, and complete runtime
  graph teardown followed by persisted SQLite reopen after recovery commit. The
  reopened runtime completed on the selected model with exactly one recovery
  marker and one completed write record.
- Companion core commit: `c1856affb3`, `feat(core): recover failed requests once
  inside durable session drains`. Core owner integrated it into `v2-core` as
  `be4e5fe5f8`, preserving the withdrawal fence and public `session.active` hook.
  The manager should integrate the `v2-core` range, not cherry-pick this twice.
- Final combined package verification passed against the manager's integrated
  `v2-migration` checkout: eighteen scenarios, 150 assertions, 2.52 seconds, and
  package typecheck.
  The native loader scenario exercises actual ConfigPluginSource normalization
  and PluginModule loading, plus Host directory and named-package discovery.
  The original isolated `auth-recovery` worktree was then removed; its committed
  branch remains available as the handoff reference.
- Targeted core seam lint: zero warnings/errors on seven files, using the worktree's
  explicit V2 config and disabled ancestor/nested config discovery.
- Targeted auth entrypoint/source/test lint: zero warnings/errors on thirteen files with the same
  explicit V2 configuration. Invocations were scoped to their own checkout roots
  because the linter rejects ancestor V1 config and panics on external-root paths.

Test entrypoint: from this package, `bun typecheck` and `bun test test`, both through
`python3 ~/.claude/scripts/heavy-job.py --wait --`. The owner verified against the
installed pinned package using `CLAUDE_AUTH_TEST_ROOT` and the companion core using
`AUTH_RECOVERY_CORE_ROOT`. These environment overrides are unnecessary after the
dependency is installed and the manager has integrated the core fixture into this
checkout. They never select live credentials; all refreshes use temporary stores
and loopback fault servers.

This artifact does not claim live subscription validation, a running V2 install,
or a live server restart: those belong to the manager's isolated integration trial.

### Installed and compiled loader regression

The manager's real candidate exposed a module-load failure in version 0.1.0:
the value import `@opencode/plugin/promise` was not a supported canonical barrel
in the compiled host. The earlier source-only loader fixture masked that error.
The Claude 429 observed while this plugin was absent came from the old native
credential route and is **not** evidence of subscription quota exhaustion.

`test/compiled.test.ts` now packs and installs the real artifact into a fresh
temporary directory with peer installation omitted. It asserts there is no
published `@opencode/plugin` copy, then:

1. Calls default `legacy()` against the actual installed 2.2.1 dependency,
   without `legacyRoot`, and checks both package-entry and nested-dist resolution.
   It imports the real modules without invoking account discovery or Keychain.
2. Starts the actual compiled `2.0.32-migration-probe` executable with independent
   HOME, XDG config/data/cache/state, configuration directory, database, password,
   and a private loopback port. No provider secrets are inherited.
3. Loads and activates the packed **real auth plugin**, using an explicit
   synthetic-account adapter and the actual installed dependency's transport.
4. Runs a second pure default-resolver probe **inside the compiled host**, still
   against actual installed 2.2.1 modules and without credential reads.
5. Triggers location activation through authenticated model/plugin endpoints and
   requires `local.claude-subscription`, the default-resolver probe, and no failed
   plugins. It terminates/reaps the compiled process group and deletes the fixture.

This checks the installed/compiled failure boundary directly. It does not claim
that a real account request succeeded; the manager owns that separate reprobe.

### Compressed upstream HTTP regression

The manager then confirmed that version 0.1.1 loaded correctly and the real Claude
upstream returned HTTP 200. The failure occurred on the next HTTP hop: Bun fetch
had already decompressed the upstream body, but the forwarded `Content-Encoding:
gzip` made the client attempt decompression again. That was a gateway transport
error, not quota evidence or an authentication failure.

Version 0.1.2 normalizes forwarded headers after the pinned SSE transformation,
after JSON error-evidence injection, and on non-JSON error passthrough. It removes
stale content encoding/length, transfer framing, standard hop-by-hop headers, and
fields nominated by `Connection`. The downstream server owns the new hop's
framing. Content type, rate-limit/Retry-After fields and request IDs remain intact.
Transformed request bodies receive the same framing/hop cleanup. Upstream fetch
still uses normal automatic decompression; `decompress:false` is not used.

`test/compressed.test.ts` serves real gzip bytes over loopback HTTP and sends them
through the actual installed 2.2.1 transform, gateway HTTP listener, and Bun client:
HTTP 200 SSE (including tool-name reversal), HTTP 429 JSON with structured throttle
evidence, and HTTP 502 non-JSON passthrough all retain readable bodies and valid
headers. Any downstream content length is checked against the actual emitted body.

`test/runner.test.ts` also sends gzip SSE through the actual Anthropic parser and
production runner. A separate compressed 429 carries explicit synthetic rejected
window evidence; the real parser retains its status, reason, Retry-After and window
and recovers exactly once on Sol. A generic compressed 429 remains model-throttle.
These are actual upstream/client HTTP exchanges, not direct Response-only mocks.
The manager owns the subsequent real-account reprobe of the new artifact.

Subscription-window evidence was checked against Claude Code's public reports:
[rate-limit errors conflate usage and throughput limits](https://github.com/anthropics/claude-code/issues/25805)
and [subscription rate-limit event fields](https://github.com/anthropics/claude-code/issues/41185).
The implementation requires a specific window's explicit `rejected` status;
it does not infer exhaustion from their prose or from Retry-After duration.

## Lifecycle and integration

The plugin owns one loopback listener and scoped registrations. Cleanup disposes
the registrations, stops the listener and active requests, and closes diagnostics.
Tests close their listeners and temporary stores. There is no live config edit,
V1 auth.json write, live installation, service restart, or release in this stream.
Packed regression installs and compiled servers exist only in disposable test roots.

The manager owns integrating the companion core commit, the final config fragment,
dependency placement for the isolated target, and full migrated-runtime checks.
