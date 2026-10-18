import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test("packed auth activates in the compiled CLI without a published SDK copy; default pinned resolver reads no credentials", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const executable = process.env.AUTH_COMPILED_CLI ?? fileURLToPath(new URL("../../../packages/cli/dist/cli-darwin-arm64/bin/opencode", import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), "auth-compiled-"))
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    CLAUDE_CONFIG_DIR: join(directory, "empty-claude"),
    OPENCODE_CONFIG_DIR: join(directory, "config"), OPENCODE_DB: join(directory, "isolated.sqlite"),
    OPENCODE_PASSWORD: crypto.randomUUID(),
  }
  const run = async (args: string[], cwd = directory) => {
    const child = Bun.spawn([process.execPath, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe", timeout: 45000 })
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exit !== 0) throw new Error(`${args.join(" ")}: ${exit}\n${output}\n${error}`)
    return output
  }
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  try {
    const packed = join(directory, "auth-packed.tgz")
    await run(["pm", "pack", "--ignore-scripts", "--filename", packed], root)
    await Bun.write(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@local/opencode-subscription-auth": `file:${packed}` } }))
    await run(["install", "--ignore-scripts", "--production", "--omit=peer", "--network-concurrency=2"])
    expect(await Bun.file(join(directory, "node_modules/@opencode/plugin/package.json")).exists()).toBe(false)
    const installed = join(directory, "node_modules/@local/opencode-subscription-auth")
    // This is the real installed npm 2.2.1 dependency. Importing its pure modules
    // must not invoke account discovery, Keychain, or persisted-source reads.
    const resolver = join(directory, "resolver.ts")
    await Bun.write(resolver, `
      import { join } from "node:path"
      import { legacy, legacyPackageRoot } from ${JSON.stringify(pathToFileURL(join(installed, "src/legacy.ts")).href)}
      const modules = await legacy()
      const root = await legacyPackageRoot()
      const nested = await legacyPackageRoot(join(root, "dist/index.js"))
      const manifest = await Bun.file(join(root, "package.json")).json()
      if (manifest.version !== "2.2.1" || nested !== root || typeof modules.keychain.readAllClaudeAccounts !== "function" || typeof modules.transport.transformBody !== "function" || typeof modules.preferredSource !== "function") throw new Error("Pinned default resolver failed")
      console.log(JSON.stringify({marker:"PINNED_DEFAULT_RESOLVER_OK_NO_CREDENTIAL_READ", root}))
    `)
    const resolved = JSON.parse(await run([resolver])) as { marker: string; root: string }
    expect(resolved.marker).toBe("PINNED_DEFAULT_RESOLVER_OK_NO_CREDENTIAL_READ")

    // Full real plugin setup uses an explicit synthetic account adapter. Actual
    // request transforms still come from the installed pinned dependency. No
    // method of the real Keychain module is invoked by the compiled probe.
    const legacyRoot = join(directory, "synthetic-accounts")
    const dependencyRoot = resolved.root
    await Bun.write(join(legacyRoot, "dist/keychain.js"), `
      const credentials = {accessToken:"synthetic-access", refreshToken:"synthetic-refresh", expiresAt:Date.now()+3600000}
      export const readAllClaudeAccounts = () => [{source:"fixture", label:"Synthetic test account", credentials}]
      export const refreshAccount = () => credentials
      export const writeBackCredentials = () => true
    `)
    await Bun.write(join(legacyRoot, "dist/index.js"), `export * from ${JSON.stringify(pathToFileURL(join(dependencyRoot, "dist/index.js")).href)}`)
    await Bun.write(join(legacyRoot, "dist/credentials.js"), "export const loadPersistedAccountSource = () => null")
    await Bun.write(join(legacyRoot, "dist/refresh-lock.js"), "export const acquireRefreshLock = () => ({release(){}})")
    const probe = join(directory, "default-resolver-probe")
    const probeResult = join(directory, "default-resolver.json")
    await Bun.write(join(probe, "server.ts"), `
      import { legacy, legacyPackageRoot } from ${JSON.stringify(pathToFileURL(join(installed, "src/legacy.ts")).href)}
      export default {id:"compiled-auth-default-resolver", async setup(){
        const modules = await legacy()
        const root = await legacyPackageRoot()
        const manifest = await Bun.file(root+"/package.json").json()
        if(manifest.version!=="2.2.1" || typeof modules.preferredSource!=="function") throw new Error("Compiled default resolver failed")
        await Bun.write(${JSON.stringify(probeResult)},JSON.stringify({version:manifest.version, credentialReads:false}))
      }}
    `)
    await Bun.write(join(directory, "config/opencode.json"), JSON.stringify({ plugins: [{ package: probe }, { package: installed, options: { legacyRoot, diagnostics: join(directory, "diagnostics.sqlite") } }] }))
    const selection = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const port = selection.port
    await selection.stop(true)
    server = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: directory, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
    const output = new Response(server.stdout).text()
    const errors = new Response(server.stderr).text()
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_PASSWORD}`).toString("base64")}` }
    const query = new URLSearchParams({ "location[directory]": directory })
    const origin = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60000
    let plugins: Array<{ id?: string; state?: { status?: string }; status?: string }> = []
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Compiled candidate exited: ${await output}\n${await errors}`)
      const response = await fetch(`${origin}/api/model?${query}`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => undefined)
      if (response?.ok) {
        await response.body?.cancel()
        const list = await fetch(`${origin}/api/plugin?${query}`, { headers, signal: AbortSignal.timeout(5000) })
        const body = await list.json() as { data?: typeof plugins }
        plugins = body.data ?? []
        if (plugins.some((item) => item.id === "local.claude-subscription" && item.state?.status !== "failed" && item.status !== "failed")) break
      }
      await Bun.sleep(25)
    }
    expect(plugins.some((item) => item.id === "local.claude-subscription")).toBe(true)
    expect(plugins.filter((item) => item.state?.status === "failed" || item.status === "failed")).toEqual([])
    expect(plugins.some((item) => item.id === "compiled-auth-default-resolver")).toBe(true)
    expect(await Bun.file(probeResult).json()).toEqual({ version: "2.2.1", credentialReads: false })
    expect(await Bun.file(join(directory, "node_modules/@opencode/plugin/package.json")).exists()).toBe(false)
  } finally {
    if (server) {
      const child = server
      const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid, signal) } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error } }
      const force = setTimeout(() => kill("SIGKILL"), 3000)
      try { kill("SIGTERM"); await server.exited } finally { clearTimeout(force) }
      try { process.kill(-server.pid, 0); kill("SIGKILL") } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error }
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 180000)
