import os from "node:os"
import path from "node:path"
import { mkdir, chmod, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { ConfigNormalize } from "../packages/core/src/config/normalize.ts"
import { ConfigMigration } from "../packages/cli/src/config/migrate.ts"

const { parse } = createRequire(path.resolve(import.meta.dir, "../packages/cli/package.json"))("jsonc-parser")
if (process.argv.includes("--check")) {
  console.log("Native configuration normalization and CLI migration adapters loaded")
  process.exit(0)
}
const home = os.homedir()
const accountsOnly = process.argv.includes("--accounts-only")
const production = process.argv.includes("--production")
const root = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? path.join(home, ".local/share/opencode-v2-migration")
const config = path.join(root, "config/opencode")
const profilePath = path.join(root, "profile.json")
const profile = await Bun.file(profilePath).json()
const artifacts = await Bun.file(path.join(import.meta.dir, "artifacts.json")).json()
const expected = accountsOnly
  ? ["cursor-opencode-provider", "@local/opencode-subscription-auth"]
  : ["cursor-opencode-provider", "@moritz/opencode-parity-plugins", "opencode-read-aloud", "@local/opencode-subscription-auth", "@moritz/opencode-todo"]
for (const name of expected) {
  if (typeof artifacts[name] !== "string" || !(await Bun.file(artifacts[name]).exists())) {
    throw new Error(`Missing packed migration artifact: ${name}`)
  }
}
await mkdir(path.join(root, "artifacts"), { recursive: true, mode: 0o700 })
const packed: Record<string, string> = {}
const hashes: Record<string, string> = {}
for (const name of expected) {
  const bytes = await Bun.file(artifacts[name]).arrayBuffer()
  hashes[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const destination = path.join(root, "artifacts", name.replaceAll("@", "").replaceAll("/", "-") + "-" + hashes[name].slice(0, 12) + ".tgz")
  await Bun.write(destination, bytes)
  packed[name] = destination
}
await Bun.write(path.join(root, "artifacts/manifest.json"), JSON.stringify({ packages: packed, sha256: hashes }, null, 2) + "\n")

const original = parse(await Bun.file(path.join(root, "reference/opencode.jsonc")).text())
const legacyTui = parse(await Bun.file(path.join(root, "reference/tui.json")).text())
const exclude = Object.fromEntries(
  Object.entries(original.provider ?? {}).flatMap(([id, provider]) => {
    const entry = provider as { blacklist?: string[] }
    return entry.blacklist ? [[id, entry.blacklist]] : []
  }),
)
const input = structuredClone(original)
input.plugin = []
for (const provider of Object.values(input.provider ?? {})) delete (provider as { blacklist?: string[] }).blacklist
const notesPath = path.join(config, "opencode-notes-v2.md")
const notesSource = await Bun.file(path.join(home, ".config/opencode/opencode-notes.md")).text()
const notesEdits = [
  ["# Running in OpenCode, not Claude Code", "# Running in OpenCode, not Claude Code\n\nThis profile runs OpenCode V2. Native tools are `shell`, `subagent` and `patch`; MCP tools can be reached through Code Mode. V1-only HTTP examples below are labeled explicitly. The dual-version background/message helpers select the API from the chosen server record. Configuration and plugins reload in V2; an installed executable still needs process replacement to become live.\n\n**Past chat search:** resolve the active database with `opencode debug paths db`. New V2 history lives in `session_message` joined to `session_v2` by session_id/id; search the JSON data for earlier text, including pre-compaction rows. The retained V1 `part`/`session` tables do not contain new V2 replies. Plugin full-history readers use the public paginated message API, not the compacted model-context API."],
  ["(~/.config/opencode/plugins/monitor.js)", "(the portable parity server plugin; V1 source is ~/.config/opencode/plugins/monitor.js)"],
  ["(~/.config/opencode/plugins/background-shell.js)", "(the parity background-shell adapter, alongside V2 native background execution)"],
  ["API (verified 2026-10-09):", "API. Prefer the dual-version helper `~/.claude/scripts/opencode-message.py <session-id> <canonical-repo> <text>`; it keeps credentials out of argv. V2 uses `/api/session/<id>/prompt` with `{text}` and V1 uses `prompt_async` with text parts. The following manual recipe is **V1 only** (verified 2026-10-09):"],
  ["- **Subagents:** the Agent/Task tool here is `task`.", "- **Subagents:** the native V2 tool is `subagent`; V1 calls it `task`. A top-level background agent is still a separate persistent session, not a child subagent."],
  ["OpenCode 1.x has no `--bg`; start it on agentview's shared server, in the", "For both V1 and V2, the dual-version helper starts it on agentview's selected shared server, in the"],
  ["~/.config/opencode/plugins/claude-hooks.js, and CLAUDE_CODE_SESSION_ID is set", "the native parity server's ClaudeHooks adapter (V1 uses ~/.config/opencode/plugins/claude-hooks.js), and CLAUDE_CODE_SESSION_ID is set"],
] as const
await Bun.write(notesPath, notesEdits.reduce((text, [before, after]) => text.replace(before, after), notesSource))
input.instructions = [...new Set([path.join(home, ".claude/CLAUDE.md"), "CLAUDE.md", ...(input.instructions ?? []).map((item: string) => item.endsWith("/opencode-notes.md") ? notesPath : item)])]
delete input.experimental?.mcp_lazy
delete input.experimental?.mcp_lazy_exclude_providers
delete input.experimental?.freeze_system_prompt
// V2 summary compaction already uses a recent-token budget rather than pruning.
delete input.compaction?.prune
const normalized = ConfigNormalize.normalize(input)
if (normalized.type === "rejected" || normalized.diagnostics.some((diagnostic) => diagnostic.kind === "invalid")) {
  throw new Error(`Configuration migration rejected: ${JSON.stringify(normalized.diagnostics)}`)
}
const fragment = accountsOnly ? { agents: {}, plugins: [] } : await Bun.file(path.join(import.meta.dir, "plugins/config-fragment.json")).json()
const memoryConfigDir = path.join(root, "claude")
if (!accountsOnly && !production) {
  const source = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude")
  for (const [directory, pattern] of [["projects", "*/memory/**/*.md"], ["opencode-memory", "**/*.json"]] as const) {
    if (!(await stat(path.join(source, directory)).catch(() => undefined))?.isDirectory()) continue
    for await (const name of new Bun.Glob(pattern).scan({ cwd: path.join(source, directory), onlyFiles: true, followSymlinks: true })) {
      const destination = path.join(memoryConfigDir, directory, name)
      if (await Bun.file(destination).exists()) continue
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await Bun.write(destination, Bun.file(path.join(source, directory, name)))
      await chmod(destination, 0o600)
    }
  }
}
const settings = { ...normalized.encoded }
const nativeAgents = (settings.agents ?? {}) as Record<string, Record<string, unknown>>
settings.agents = Object.fromEntries(
  [...new Set([...Object.keys(fragment.agents), ...Object.keys(nativeAgents)])].map((id) => [
    id,
    { ...fragment.agents[id], ...nativeAgents[id] },
  ]),
)

const wrappers = {
  cursor: { file: "server.ts", content: 'export { default } from "cursor-opencode-provider/server"\n' },
  auth: { file: "server.ts", content: 'export { default } from "@local/opencode-subscription-auth"\n' },
  "parity-server": { file: "server.ts", content: 'export { default } from "@moritz/opencode-parity-plugins/server-only"\n' },
  "parity-ui": { file: "tui.js", content: 'export { default } from "@moritz/opencode-parity-plugins/tui"\n' },
  speech: { file: "tui.js", content: 'export { default } from "opencode-read-aloud/tui"\n' },
  "todo-server": { file: "server.ts", content: 'export { default } from "@moritz/opencode-todo/server"\n' },
  "todo-ui": { file: "tui.js", content: 'export { default } from "@moritz/opencode-todo/tui"\n' },
  policy: { file: "server.ts", content: await Bun.file(path.join(import.meta.dir, "model-policy.ts")).text() },
}
for (const [name, wrapper] of Object.entries(wrappers)) {
  await mkdir(path.join(config, "ports", name), { recursive: true, mode: 0o700 })
  await Bun.write(path.join(config, "ports", name, wrapper.file), wrapper.content)
}
const port = (name: string) => path.join(config, "ports", name)
settings.plugins = [
  ...(!accountsOnly ? [{ package: port("todo-server"), options: { todoread: true, legacyDatabasePath: profile.environment.OPENCODE_DB } }] : []),
  { package: port("cursor") },
  {
    package: port("auth"),
    options: {
      diagnostics: path.join(root, "data/claude-subscription/diagnostics.sqlite"),
    },
  },
  { package: port("policy"), options: { exclude } },
  ...(!accountsOnly ? [{ package: port("parity-server"), options: {
    ...fragment.plugins[0].options,
    ...(!production ? {
      memoryConfigDir,
      adrafinil: false,
      memory: { ...fragment.plugins[0].options.memory, extract: { ...fragment.plugins[0].options.memory?.extract, catchUpLimit: 0 } },
    } : {}),
  } }] : []),
]

let kv = {}
await mkdir(path.join(root, "state/opencode"), { recursive: true, mode: 0o700 })
for (const name of ["kv.json", "model.json", "prompt-history.jsonl", "session.json"]) {
  const source = path.join(home, ".local/state/opencode", name)
  if (!(await Bun.file(source).exists())) continue
  const content = await Bun.file(source).text()
  await Bun.write(path.join(root, "reference", name), content)
  await Bun.write(path.join(root, "state/opencode", name), content)
  await chmod(path.join(root, "state/opencode", name), 0o600)
  if (name === "kv.json") kv = JSON.parse(content)
}
const migrated = ConfigMigration.migrateV1({ ...legacyTui, plugin: [] }, kv)
const speech = legacyTui.plugin.find((item: unknown) => Array.isArray(item) && String(item[0]).includes("read-aloud"))
const cli = {
  ...migrated,
  plugins: accountsOnly ? [] : [
    { package: port("speech"), options: speech?.[1] ?? { placement: "footer" } },
    { package: port("parity-ui"), options: { folds: { bash_output: true, bash_min_lines: 0 } } },
    { package: port("todo-ui") },
  ],
  // The user's workflow already has agentview tabs; do not add a competing strip.
  tabs: { mode: "off" },
}
await Bun.write(path.join(config, "opencode.jsonc"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...settings }, null, 2) + "\n")
await Bun.write(path.join(config, "cli.json"), JSON.stringify(cli, null, 2) + "\n")
await Bun.write(
  path.join(config, "package.json"),
  JSON.stringify({ name: "opencode-v2-isolated-profile", private: true, type: "module", dependencies: Object.fromEntries(expected.map((name) => [name, `file:${packed[name]}`])) }, null, 2) + "\n",
)
profile.environment.CURSOR_OPENCODE2_DEV_ENTRY = path.join(config, "node_modules/cursor-opencode-provider/dist/index.js")
// The canonical durable tools own these names for every provider.
profile.environment.CURSOR_OPENCODE2_TODOS = accountsOnly ? "1" : "0"
for (const name of ["auth.json", "mcp-auth.json", "speechify.key", "elevenlabs.key"]) {
  const source = path.join(home, ".local/share/opencode", name)
  if (!(await Bun.file(source).exists())) continue
  const destination = path.join(root, "data/opencode", name)
  await Bun.write(destination, Bun.file(source))
  await chmod(destination, 0o600)
}
// Calendar MCP resolves its own token file from XDG_CONFIG_HOME rather than
// OpenCode's credential store. A connected handshake does not validate tokens.
const calendarTokens = path.join(home, ".config/google-calendar-mcp/tokens.json")
if (await Bun.file(calendarTokens).exists()) {
  const destination = path.join(root, "config/google-calendar-mcp/tokens.json")
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await Bun.write(destination, Bun.file(calendarTokens))
  await chmod(destination, 0o600)
}
const speechCache = path.join(home, ".cache/opencode/speech")
const cacheDirectory = await stat(speechCache).catch(() => undefined)
if (cacheDirectory?.isDirectory()) {
  await mkdir(path.join(root, "cache/opencode/speech"), { recursive: true, mode: 0o700 })
  for await (const name of new Bun.Glob("*.{mp3,json}").scan({ cwd: speechCache, onlyFiles: true })) {
    await Bun.write(path.join(root, "cache/opencode/speech", name), Bun.file(path.join(speechCache, name)))
  }
}
await Bun.write(profilePath, JSON.stringify(profile, null, 2) + "\n")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
await Bun.write(path.join(root, "bin/opencode-v2-candidate"), `#!/bin/sh\nexec env ${Object.entries(profile.environment).map(([key, value]) => `${key}=${quote(String(value))}`).join(" ")} ${quote(profile.executable)} "$@"\n`)
await chmod(path.join(root, "bin/opencode-v2-candidate"), 0o700)
await chmod(path.join(config, "opencode.jsonc"), 0o600)
await Bun.write(path.join(root, "reference/config-migration.json"), JSON.stringify({ diagnostics: normalized.diagnostics, packedPackages: expected, explicitClaudeInstructions: true, legacyProviderExclusions: exclude, replacedExperiments: ["mcp_lazy", "freeze_system_prompt"], rehearsalMemoryRoot: !production && !accountsOnly ? memoryConfigDir : undefined, production }, null, 2) + "\n")
console.log(`Assembled ${accountsOnly ? "account-probe" : "full-parity"} candidate configuration at ${config}; install its pinned packages before starting.`)
