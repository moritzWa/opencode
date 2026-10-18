import { ClaudeFailure, classify, type Failure } from "./failure.ts"
import type { Credentials, CredentialStore } from "./legacy.ts"
import type { Diagnostics } from "./diagnostics.ts"

export interface AuthOptions {
  store: CredentialStore
  diagnostics?: Diagnostics
  tokenURL?: string
  budgetMs?: number
  maxAttempts?: number
  attemptTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const transient = (failure: Failure) => ["refresh_throttle", "refresh_network", "refresh_server"].includes(failure.category)

export class SubscriptionAuth {
  private pending?: { promise: Promise<Credentials>; controller: AbortController; users: number }
  private cached?: Credentials
  constructor(readonly options: AuthOptions) {}

  async credentials(signal: AbortSignal, force = false): Promise<Credentials> {
    signal.throwIfAborted()
    if (!this.pending) {
      const controller = new AbortController()
      const pending = { promise: this.resolve(controller.signal, force), controller, users: 0 }
      this.pending = pending
      const clear = () => { if (this.pending === pending) this.pending = undefined }
      void pending.promise.then(clear, clear)
    }
    const pending = this.pending
    pending.users++
    try { return await this.wait(pending.promise, signal) } finally {
      pending.users--
      if (pending.users === 0) pending.controller.abort()
    }
  }

  private async wait(pending: Promise<Credentials>, signal: AbortSignal) {
    // A joining Session may cancel independently of the refresh's owner.
    const cancelled = Promise.withResolvers<never>()
    const abort = () => cancelled.reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    try { return await Promise.race([pending, cancelled.promise]) } finally { signal.removeEventListener("abort", abort) }
  }

  private async resolve(signal: AbortSignal, force: boolean): Promise<Credentials> {
    const now = this.options.now ?? Date.now
    const deadline = now() + (this.options.budgetMs ?? 75_000)
    const sleep = this.options.sleep ?? ((ms: number, abort: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, ms)
      function done() { abort.removeEventListener("abort", cancel); resolve() }
      function cancel() { clearTimeout(timer); abort.removeEventListener("abort", cancel); reject(abort.reason) }
      if (abort.aborted) return cancel()
      abort.addEventListener("abort", cancel, { once: true })
    }))
    const read = () => this.options.store.read().catch(() => { throw new ClaudeFailure({ category: "credential_store", reason: "read_failed" }) })
    const stored = await read()
    const initial = stored && stored.expiresAt > now() + 60_000 ? stored : this.cached && this.cached.expiresAt > (stored?.expiresAt ?? 0) ? this.cached : stored
    if (!initial) throw new ClaudeFailure({ category: "credential_store", reason: "missing_credentials" })
    if (!force && initial.expiresAt > now() + 60_000) return initial
    let failure: Failure = { category: "refresh_invalid", reason: "missing_refresh_token" }
    for (let attempt = 0; attempt < (this.options.maxAttempts ?? 8); attempt++) {
      signal.throwIfAborted()
      const fresh = await read()
      if (fresh && fresh.accessToken !== initial.accessToken && fresh.expiresAt > now() + 60_000) return fresh
      if (!initial.refreshToken || now() >= deadline) break
      const lock = this.options.store.lock?.()
      if (lock === null) {
        failure = { category: "refresh_pending", reason: "refresh_in_progress" }
        this.options.diagnostics?.record(failure, "retry_claude")
        await sleep(Math.min(10_000, deadline - now()), signal)
        continue
      }
      try {
        const locked = await read()
        if (locked && locked.accessToken !== initial.accessToken && locked.expiresAt > now() + 60_000) return locked
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.options.attemptTimeoutMs ?? 15_000, deadline - now())))
        const response = await fetch(this.options.tokenURL ?? "https://claude.ai/v1/oauth/token", {
          method: "POST", signal: AbortSignal.any([signal, timeout]),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", refresh_token: initial.refreshToken }),
        }).catch(() => undefined)
        signal.throwIfAborted()
        if (response?.ok) {
          const data = await response.json().catch(() => undefined) as { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number } | undefined
          if (data && typeof data.access_token === "string" && data.access_token.length > 0) {
            const next = { accessToken: data.access_token, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : initial.refreshToken, expiresAt: typeof data.expires_at === "number" && data.expires_at > now() ? data.expires_at : now() + (typeof data.expires_in === "number" ? data.expires_in : 36000) * 1000 }
            if (next.expiresAt <= now() + 60_000) throw new ClaudeFailure({ category: "refresh_invalid", status: response.status, reason: "invalid_expiry" })
            this.cached = next
            if (!await this.options.store.write(next, initial).catch(() => false)) throw new ClaudeFailure({ category: "credential_store", reason: "refresh_write_failed" })
            this.options.diagnostics?.record({ category: "unknown", reason: "refresh_success", status: response.status }, "refresh_saved")
            return next
          }
          failure = { category: "refresh_server", status: response.status, reason: "invalid_token_response" }
        } else failure = response ? await classify(response, "refresh") : { category: "refresh_network", reason: timeout.aborted ? "timeout" : "connection_failed" }
      } finally { lock?.release() }
      if (!transient(failure)) break
      const delay = Math.min(failure.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 15_000), deadline - now())
      this.options.diagnostics?.record(failure, "retry_claude")
      if (delay > 0) await sleep(delay, signal)
    }
    const exhausted = { ...failure, exhausted: true }
    this.options.diagnostics?.record(exhausted, "stop")
    throw new ClaudeFailure(exhausted)
  }
}
