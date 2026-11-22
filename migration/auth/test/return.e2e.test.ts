import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Runs the real server with this plugin against local Anthropic/xAI stand-ins. Needs a V2 executable:
//   RETURN_E2E_CLI=~/.local/share/opencode-v2/bin/native/opencode-dev bun test test/return.e2e.test.ts
const executable = process.env.RETURN_E2E_CLI
const e2e = executable ? test : test.skip

const SUMMARY = "## Objective\n- test\n\n## Requirements\n- (none)\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- (none)\n\n### Active\n- (none)\n\n### Blocked\n- (none)\n\n## Next Move\n1. (none)\n\n## Relevant Files\n(none)\n\n## Important Context\n- (none)"

e2e("a Grok session returns to Sonnet on its next prompt, compacting first, and a fresh Grok pick sticks", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), "return-e2e-"))
  const requests: Array<{ kind: "chat" | "summary"; model: string }> = []
  let xai = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/messages")) {
        const raw = await request.text()
        const summary = raw.includes("summarize the conversation") || raw.includes("Update the existing checkpoint")
        const model = JSON.parse(raw).model as string
        if (model.includes("sonnet")) requests.push({ kind: summary ? "summary" : "chat", model })
        const text = summary ? SUMMARY : "Hello from Sonnet."
        const events = [
          { type: "message_start", message: { id: "msg_local", type: "message", role: "assistant", content: [], model: "claude-sonnet-5-5", usage: { input_tokens: 5000, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
          { type: "message_stop" },
        ]
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      }
      xai++
      return new Response("unavailable", { status: 500 })
    },
  })
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    CLAUDE_CONFIG_DIR: join(directory, "empty-claude"),
    OPENCODE_CONFIG_DIR: join(directory, "config"), OPENCODE_DB: join(directory, "isolated.sqlite"),
    OPENCODE_PASSWORD: crypto.randomUUID(),
  }
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  let logs: (() => Promise<string>) | undefined
  try {
    const dependency = join(root, "node_modules/opencode-claude-auth")
    const legacyRoot = join(directory, "synthetic-accounts")
    const real = join(dirname(Bun.resolveSync("opencode-claude-auth/package.json", root)), "dist/index.js")
    await Bun.write(join(legacyRoot, "dist/keychain.js"), `
      const credentials = {accessToken:"synthetic-access", refreshToken:"synthetic-refresh", expiresAt:Date.now()+3600000}
      export const readAllClaudeAccounts = () => [{source:"fixture", label:"Synthetic test account", credentials}]
      export const refreshAccount = () => credentials
      export const writeBackCredentials = () => true
    `)
    await Bun.write(join(legacyRoot, "dist/index.js"), `export * from ${JSON.stringify(pathToFileURL(real).href)}`)
    await Bun.write(join(legacyRoot, "dist/credentials.js"), "export const loadPersistedAccountSource = () => null")
    await Bun.write(join(legacyRoot, "dist/refresh-lock.js"), "export const acquireRefreshLock = () => ({release(){}})")
    await Bun.write(join(directory, "config/opencode.json"), JSON.stringify({
      providers: { xai: { settings: { apiKey: "fake", baseURL: `http://127.0.0.1:${upstream.port}/v1` } } },
      plugins: [{ package: root, options: { legacyRoot, diagnostics: join(directory, "diagnostics.sqlite"), upstream: `http://127.0.0.1:${upstream.port}`, compactAbove: 0 } }],
    }))
    const selection = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const port = selection.port
    await selection.stop(true)
    server = Bun.spawn([executable!, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: directory, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
    const output = new Response(server.stdout).text()
    const errors = new Response(server.stderr).text()
    logs = async () => `${await output}\n${await errors}\nrequests=${JSON.stringify(requests)} xai=${xai}`
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
    const query = new URLSearchParams({ "location[directory]": directory })
    const origin = `http://127.0.0.1:${port}`
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${origin}${path}?${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
      const text = await response.text()
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
      return text ? JSON.parse(text) : undefined
    }
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${await output}\n${await errors}`)
      const response = await fetch(`${origin}/api/model?${query}`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => undefined)
      if (response?.ok) {
        const body = (await response.json()) as { data: Array<{ providerID: string; id: string }> }
        if (body.data.some((item) => item.providerID === "anthropic" && item.id === "claude-sonnet-5-5") && body.data.some((item) => item.providerID === "xai" && item.id === "grok-4.7")) break
      }
      await Bun.sleep(100)
    }
    const idle = async (id: string) => {
      const until = Date.now() + 60000
      await Bun.sleep(300)
      while (Date.now() < until) {
        const active = (await call("GET", "/api/session/active")).data as Record<string, unknown>
        if (!(id in active)) return
        await Bun.sleep(150)
      }
      throw new Error("session did not go idle")
    }
    const model = async (id: string) => (await call("GET", `/api/session/${id}`)).data.model as { providerID: string; id: string }
    const messages = async (id: string) => (await call("GET", `/api/session/${id}/context`)).data as Array<{ type: string; text?: string; model?: { providerID: string } }>

    const created = (await call("POST", "/api/session", { model: { providerID: "anthropic", id: "claude-sonnet-5-5" } })).data as { id: string }
    const id = created.id
    await call("POST", `/api/session/${id}/prompt`, { text: "first question" })
    await idle(id)
    expect(requests.map((item) => item.kind)).toEqual(["chat"])

    // Parked on Grok (as after both subscriptions ran out), then prompted again.
    await call("POST", `/api/session/${id}/model`, { model: { providerID: "xai", id: "grok-4.7" } })
    expect((await model(id)).providerID).toBe("xai")
    await call("POST", `/api/session/${id}/prompt`, { text: "second question" })
    await idle(id)
    expect((await model(id)).providerID).toBe("anthropic")
    expect(xai).toBe(0)
    expect(requests.map((item) => item.kind)).toEqual(["chat", "summary", "chat"])
    const history = await messages(id)
    expect(history.some((item) => item.type === "compaction")).toBe(true)
    const info = (await call("GET", `/api/session/${id}`)).data as { metadata?: { modelReturn?: { at: number; from: string } } }
    expect(info.metadata?.modelReturn?.from).toBe("xai/grok-4.7")

    // Choosing Grok again after a return is respected.
    await call("POST", `/api/session/${id}/model`, { model: { providerID: "xai", id: "grok-4.7" } })
    await call("POST", `/api/session/${id}/prompt`, { text: "third question" })
    // The stand-in xAI endpoint fails, so the session keeps retrying; the model it asked is what matters.
    await Bun.sleep(4000)
    expect((await model(id)).providerID).toBe("xai")
    expect(requests.map((item) => item.kind)).toEqual(["chat", "summary", "chat"])
    expect(xai).toBeGreaterThan(0)
  } finally {
    if (server) {
      const child = server
      const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid, signal) } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error } }
      const force = setTimeout(() => kill("SIGKILL"), 3000)
      try { kill("SIGTERM"); await server.exited } finally { clearTimeout(force) }
      try { process.kill(-server.pid, 0); kill("SIGKILL") } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error }
      if (process.env.RETURN_E2E_DEBUG && logs) console.log((await logs()).slice(-6000))
    }
    upstream.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
}, 240000)
