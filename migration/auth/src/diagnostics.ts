import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Failure } from "./failure.ts"

const safeReasons = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied", "token_revoked", "rate_limit_error", "overloaded_error", "api_error", "authentication_error", "quota_exceeded", "insufficient_quota", "usage_limit_reached", "capacity_limit", "unrecognized_upstream_error", "read_failed", "missing_credentials", "missing_refresh_token", "invalid_expiry", "refresh_write_failed", "refresh_success", "invalid_token_response", "timeout", "connection_failed", "gateway_failure", "refresh_in_progress"])

export class Diagnostics {
  readonly db: Database
  constructor(file: string, readonly limit = 2000) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new Database(file, { create: true })
    chmodSync(file, 0o600)
    this.db.run("PRAGMA journal_mode=WAL")
    this.db.run("CREATE TABLE IF NOT EXISTS diagnostic (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, session TEXT, category TEXT NOT NULL, status INTEGER, reason TEXT NOT NULL, retry_after_ms INTEGER, action TEXT NOT NULL, quota_window TEXT)")
  }
  record(failure: Failure, action: "retry_claude" | "stay_claude" | "fallback" | "stop" | "refresh_saved", session?: string) {
    this.db.transaction(() => {
      this.db.query("INSERT INTO diagnostic(at,session,category,status,reason,retry_after_ms,action,quota_window) VALUES(?,?,?,?,?,?,?,?)").run(Date.now(), session && /^ses_[a-zA-Z0-9]{1,128}$/.test(session) ? session : null, failure.category, failure.status ?? null, safeReasons.has(failure.reason) ? failure.reason : "unrecognized_upstream_error", failure.retryAfterMs ?? null, action, ["5h", "7d", "7d_opus"].includes(failure.quotaWindow ?? "") ? failure.quotaWindow ?? null : null)
      this.db.query("DELETE FROM diagnostic WHERE id <= (SELECT COALESCE(MAX(id),0)-? FROM diagnostic)").run(this.limit)
    })()
  }
  close() { this.db.close() }
}
