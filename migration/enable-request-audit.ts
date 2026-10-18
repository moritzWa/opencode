import os from "node:os"
import path from "node:path"
import { mkdir } from "node:fs/promises"

const root = path.join(os.homedir(), ".local/share/opencode-v2-migration")
const directory = path.join(root, "config/opencode/ports/request-audit")
await mkdir(directory, { recursive: true, mode: 0o700 })
await Bun.write(path.join(directory, "server.js"), `import { appendFile } from "node:fs/promises"
const filename = ${JSON.stringify(path.join(root, "runtime/request-audit.jsonl"))}
const write = (data) => appendFile(filename, JSON.stringify(data) + "\\n", { mode: 0o600 })
export default { id: "migration.request-audit", async setup(ctx) {
  await ctx.session.hook("context", (input) => write({ kind: "context", sessionID: input.sessionID, agent: input.agent, tools: Object.keys(input.tools) }))
  await ctx.session.hook("http.request", async (input) => {
    const body = await input.request.clone().json().catch(() => ({}))
    await write({ kind: "http", sessionID: input.sessionID, model: input.model, tools: body.tools?.map((tool) => tool.name ?? tool.function?.name) ?? [] })
  })
  await ctx.session.hook("websocket.send", async (input) => {
    const frame = JSON.parse(input.frame)
    await write({ kind: "websocket", sessionID: input.sessionID, model: input.model, tools: (frame.response ?? frame).tools?.map((tool) => tool.name ?? tool.function?.name) ?? [] })
  })
  await ctx.tool.hook("execute.after", (input) => write({ kind: "tool", sessionID: input.sessionID, tool: input.tool, status: input.status }))
} }
`)
const filename = path.join(root, "config/opencode/opencode.jsonc")
const config = await Bun.file(filename).json()
if (!config.plugins.some((plugin: { package: string }) => plugin.package === directory)) config.plugins.push({ package: directory })
await Bun.write(filename, JSON.stringify(config, null, 2) + "\n")
console.log("Enabled rehearsal-only metadata audit: tool names and status, no prompts/headers/results")
