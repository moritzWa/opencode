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
import { gateway } from "./gateway.ts"
import { ClaudeFailure, readFailure } from "./failure.ts"
import { boundRetry, fallback } from "./policy.ts"

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

export const SubscriptionPlugin: Plugin = {
  id: "local.claude-subscription",
  async setup(context) {
    const modules = await legacy(typeof context.options.legacyRoot === "string" ? context.options.legacyRoot : undefined)
    const accounts = modules.keychain.readAllClaudeAccounts()
    const source = typeof context.options.accountSource === "string" ? context.options.accountSource : modules.preferredSource()
    const account = accounts.find((item) => item.source === source) ?? accounts[0]
    if (!account) throw new Error("No Claude Code subscription credentials found")
    const diagnostics = new Diagnostics(typeof context.options.diagnostics === "string" ? context.options.diagnostics : join(homedir(), ".local/share/opencode-v2/claude-subscription/diagnostics.sqlite"))
    const auths = new Map(accounts.map((item) => [item.source, new SubscriptionAuth({ store: accountStore(item, modules), diagnostics })]))
    const integrationID = Integration.ID.make("anthropic")
    const proxy = gateway({ auth: {
      async credentials(signal, force) {
        const connection = await context.integration.connection.active(integrationID)
        const selected = connection ? await context.integration.connection.resolve(connection) : undefined
        const preferred = selected?.type === "external" && typeof selected.metadata?.accountSource === "string" ? selected.metadata.accountSource : account.source
        const auth = auths.get(preferred)
        if (!auth) throw new ClaudeFailure({ category: "credential_store", reason: "missing_credentials" })
        return auth.credentials(signal, force)
      },
    }, transport: modules.transport, diagnostics })
    const registrations: Registration[] = []
    const keep = async (pending: Promise<Registration>) => { const registration = await pending; registrations.push(registration) }
    const cleanup = async () => {
      await Promise.allSettled(registrations.map((item) => item.dispose()))
      await proxy.stop()
      diagnostics.close()
    }
    try {
      await keep(context.integration.transform((editor) => editor.method.update({
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
      await keep(context.session.hook("model.request", (event) => {
        event.baseURL = proxy.url
        event.headers["x-subscription-gateway"] = proxy.secret
        event.headers["x-subscription-session"] = event.sessionID
      }, { providerID: "anthropic" }))
      await keep(context.session.hook("retry", boundRetry))
      await keep((context.session.hook as ModelHooks<SessionHooks & { recovery: Recovery }>)("recovery", async (event) => {
        const detail = readFailure(event.error)
        if (!detail) return
        const available = await context.model.list({}).then((result) => result.data).catch(() => [])
        const session = await context.session.get({ sessionID: event.sessionID }).catch(() => undefined)
        const model = fallback({ failure: detail, failed: event.model, directory: session?.location.directory, available })
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
