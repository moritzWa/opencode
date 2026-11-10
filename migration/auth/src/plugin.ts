import type { Plugin, Context } from "@opencode/plugin/promise/plugin"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { ModelHooks, Registration } from "@opencode/plugin/promise/registration"
import { Integration, Model } from "@opencode/plugin"
import type { SessionMessage } from "@opencode/schema/session-message"
import { homedir } from "node:os"
import { join } from "node:path"
import { SubscriptionAuth } from "./auth.ts"
import { Diagnostics } from "./diagnostics.ts"
import { legacy, accountStore } from "./legacy.ts"
import { gateway, type AccountAttempt } from "./gateway.ts"
import { ClaudeFailure, readFailure } from "./failure.ts"
import { accountCoolMs, boundRetry, cooldown, fallback, HOME, LAST_RESORT } from "./policy.ts"
import { decideReturn, type ReturnMessage } from "./return.ts"

// Structural forward contract for the coordinated core seam. Once integrated,
// this is exactly SessionHooks["recovery"]; no V1 event guesses are used.
export interface Recovery {
  readonly sessionID: Parameters<Context["session"]["get"]>[0]["sessionID"]
  readonly agent: string
  readonly model: Model.Ref
  readonly userMessageID: SessionMessage.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly error: { type: string; message: string; response?: { body: string } }
  decision?: { model: Model.Ref; reason: string }
}

// Promise-client reads come back either as the payload or as { data: payload }.
const unwrap = <T>(value: unknown): T => (value && typeof value === "object" && !Array.isArray(value) && "data" in value ? (value as { data: T }).data : (value as T))

export const SubscriptionPlugin: Plugin = {
  id: "local.claude-subscription",
  async setup(context) {
    const modules = await legacy(typeof context.options.legacyRoot === "string" ? context.options.legacyRoot : undefined)
    // A temporarily unreadable Keychain must not disable cross-provider recovery.
    const accounts = (() => { try { return modules.keychain.readAllClaudeAccounts() } catch { return [] } })()
    const source = typeof context.options.accountSource === "string" ? context.options.accountSource : modules.preferredSource()
    const account = accounts.find((item) => item.source === source) ?? accounts[0]
    const diagnostics = new Diagnostics(typeof context.options.diagnostics === "string" ? context.options.diagnostics : join(homedir(), ".local/share/opencode-v2/claude-subscription/diagnostics.sqlite"))
    const auths = new Map(accounts.map((item) => [item.source, new SubscriptionAuth({ store: accountStore(item, modules), diagnostics })]))
    const integrationID = Integration.ID.make("anthropic")
    const proxy = gateway({ accounts: async () => {
      const connection = await context.integration.connection.active(integrationID).catch(() => undefined)
      const selected = connection ? await context.integration.connection.resolve(connection).catch(() => undefined) : undefined
      const preferred = selected?.type === "external" && typeof selected.metadata?.accountSource === "string" ? selected.metadata.accountSource : account?.source
      const ordered = [...auths.keys()]
      const first = preferred && auths.has(preferred) ? preferred : ordered[0]
      const sources = first ? [first, ...ordered.filter((item) => item !== first)] : []
      return sources.map((source): AccountAttempt => ({
        source,
        credentials: (signal, force) => {
          const auth = auths.get(source)
          if (!auth) throw new ClaudeFailure({ category: "refresh_invalid", reason: "missing_credentials", exhausted: true })
          return auth.credentials(signal, force)
        },
      }))
    }, transport: modules.transport, diagnostics, upstream: typeof context.options.upstream === "string" ? context.options.upstream : undefined })
    const cooling = cooldown()
    const registrations: Registration[] = []
    const keep = async (pending: Promise<Registration>) => { const registration = await pending; registrations.push(registration) }
    const cleanup = async () => {
      await Promise.allSettled(registrations.map((item) => item.dispose()))
      await proxy.stop()
      diagnostics.close()
    }
    try {
      if (account) await keep(context.integration.transform((editor) => editor.method.update({
        integrationID,
        method: {
          id: Integration.MethodID.make("claude-keychain"),
          type: "external", label: "Claude Code subscription (Keychain)",
          form: [{ key: "accountSource", type: "string", title: "Claude Code account", default: account.source, required: true, options: accounts.map((item) => ({ value: item.source, label: item.label })) }],
        },
      })))
      await keep(context.provider.transform((editor) => {
        if (!editor.get("anthropic")) return
        editor.update("anthropic", (provider) => {
          provider.activation = "enabled"
          provider.settings = { ...provider.settings, authToken: "external-claude-subscription", headerTimeout: provider.settings?.headerTimeout === false ? false : Math.max(Number(provider.settings?.headerTimeout) || 0, 90000) }
        })
        for (const model of editor.get("anthropic")?.models.values() ?? []) editor.models.update("anthropic", model.id, (item) => { item.cost = [] })
      }))
      await keep(context.session.hook("model.request", async (event) => {
        // Respect an explicitly selected API key. Only external subscription
        // connections (or the original no-connection default) use the gateway.
        const connection = await context.integration.connection.active(integrationID).catch(() => undefined)
        const selected = connection ? await context.integration.connection.resolve(connection).catch(() => undefined) : undefined
        if (selected?.type === "key") return
        event.baseURL = proxy.url
        event.headers["x-subscription-gateway"] = proxy.secret
        event.headers["x-subscription-session"] = event.sessionID
      }, { providerID: "anthropic" }))
      // A session parked on the last-resort model returns to Sonnet on its next prompt once Claude is usable.
      // Never block the prompt: any failure here leaves the session where it is.
      await keep(context.session.hook("prompt", async (event) => {
        try {
          const session = await context.session.get({ sessionID: event.sessionID })
          if (session.model?.providerID !== LAST_RESORT.providerID) return
          const [available, active, messages] = await Promise.all([
            context.model.list({}).then((result) => result.data),
            context.session.active().then((result) => unwrap<Record<string, unknown>>(result)),
            context.session.context({ sessionID: event.sessionID }).then((result) => unwrap<ReturnMessage[]>(result)),
          ])
          const decision = decideReturn({
            model: session.model,
            messages,
            metadata: session.metadata,
            held: diagnostics.holds(),
            cooling: cooling.active(),
            available,
            active: event.sessionID in active,
            compactAbove: typeof context.options.compactAbove === "number" ? context.options.compactAbove : undefined,
          })
          if (!decision.move) return
          await context.session.switchModel({ sessionID: event.sessionID, model: { providerID: HOME.providerID, id: HOME.id } })
          await context.session.update({ sessionID: event.sessionID, metadata: { ...session.metadata, modelReturn: { at: Date.now(), from: `${session.model.providerID}/${session.model.id}`, tokens: decision.tokens, compacted: decision.compact } } })
          if (decision.compact) await context.session.compact({ sessionID: event.sessionID })
          console.error(`[model-return] ${event.sessionID} ${session.model.providerID}/${session.model.id} -> ${HOME.providerID}/${HOME.id} (${decision.tokens} tokens${decision.compact ? ", compacting" : ""})`)
        } catch (error) {
          console.error(`[model-return] ${event.sessionID} left in place: ${error instanceof Error ? error.message : String(error)}`)
        }
      }))
      await keep(context.session.hook("retry", boundRetry))
      await keep((context.session.hook as ModelHooks<SessionHooks & { recovery: Recovery }>)("recovery", async (event) => {
        const detail = readFailure(event.error)
        if (!detail) return
        const available = await context.model.list({}).then((result) => result.data).catch(() => [])
        const session = await context.session.get({ sessionID: event.sessionID }).catch(() => undefined)
        cooling.mark({ failure: detail, failed: event.model })
        if (["model_quota", "billing", "capacity"].includes(detail.category)) diagnostics.hold(event.model.providerID, detail.resetsAt ?? Date.now() + accountCoolMs(detail), detail.reason)
        const model = fallback({ failure: detail, failed: event.model, directory: session?.location.directory, available, tried: cooling.active(), held: diagnostics.holds() })
        if (!model) { diagnostics.record(detail, "stop", event.sessionID); return }
        const selected = available.find((item) => item.providerID === model.providerID && item.id === model.id)
        if (!selected) return
        event.decision = { model: Model.Ref.parse(`${selected.providerID}/${selected.id}`), reason: detail.category }
        diagnostics.record(detail, "fallback", event.sessionID)
      }))
    } catch (error) {
      await cleanup()
      throw error
    }
    return cleanup
  },
}

export default SubscriptionPlugin
