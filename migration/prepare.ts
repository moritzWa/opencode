import path from "node:path"
import os from "node:os"
import { mkdir, chmod } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"

const { parse } = createRequire(path.resolve(import.meta.dir, "../packages/cli/package.json"))("jsonc-parser")

// This profile is deliberately outside the live V1 paths. Database backup is
// a separate SQLite online-backup operation, never a copy of an open WAL file.
const home = os.homedir()
const root = path.resolve(process.argv[2] ?? path.join(home, ".local/share/opencode-v2-migration"))
const source = path.join(home, ".config/opencode")
const config = path.join(root, "config/opencode")
const server = path.join(config, "opencode.jsonc")
if (await Bun.file(server).exists()) throw new Error(`Profile already exists: ${root}`)

await Promise.all(
  [config, "data/opencode", "cache/opencode", "state/opencode", "reference", "bin"].map((directory) =>
    mkdir(path.isAbsolute(directory) ? directory : path.join(root, directory), { recursive: true, mode: 0o700 }),
  ),
)

const original = await Bun.file(path.join(source, "opencode.jsonc")).text()
const settings = parse(original)
// Start with no executable V1 plugins. Their full replacements are installed
// into this profile only after the plugin stream supplies its entrypoints.
settings.plugin = []
settings.instructions = [...new Set([path.join(home, ".claude/CLAUDE.md"), ...(settings.instructions ?? [])])]
await Bun.write(server, JSON.stringify(settings, null, 2) + "\n")
await Bun.write(path.join(root, "reference/opencode.jsonc"), original)
await Bun.write(path.join(root, "reference/tui.json"), Bun.file(path.join(source, "tui.json")))
for (const name of ["kv.json", "model.json", "prompt-history.jsonl", "session.json"]) {
  const file = path.join(home, ".local/state/opencode", name)
  if (await Bun.file(file).exists()) await Bun.write(path.join(root, "reference", name), Bun.file(file))
}

const theme = path.join(source, "themes/claude-code.json")
if (await Bun.file(theme).exists()) {
  await mkdir(path.join(config, "themes"), { recursive: true, mode: 0o700 })
  await Bun.write(path.join(config, "themes/claude-code.json"), Bun.file(theme))
}

for (const directory of ["plugins", "tui-plugins", "prompts", "agents", "agent", "commands", "command"]) {
  if (!existsSync(path.join(source, directory))) continue
  const files = new Bun.Glob("**/*")
  for await (const file of files.scan({ cwd: path.join(source, directory), onlyFiles: true, throwErrorOnBrokenSymlink: false })) {
    const destination = path.join(root, "reference", directory, file)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await Bun.write(destination, Bun.file(path.join(source, directory, file)))
    // Prompt file substitutions are relative to the config file.
    if (directory === "prompts") {
      await mkdir(path.dirname(path.join(config, directory, file)), { recursive: true, mode: 0o700 })
      await Bun.write(path.join(config, directory, file), Bun.file(path.join(source, directory, file)))
    }
  }
}

// The initial CLI profile has no V1 TUI plugins. The full keyboard/theme/plugin
// conversion is applied as one reviewable integration step later.
await Bun.write(path.join(config, "cli.json"), JSON.stringify({ tabs: { mode: "off" }, attention: { sound: false } }, null, 2) + "\n")

for (const name of ["auth.json", "mcp-auth.json"]) {
  const credentials = path.join(home, ".local/share/opencode", name)
  if (!(await Bun.file(credentials).exists())) continue
  const destination = path.join(root, "data/opencode", name)
  await Bun.write(destination, Bun.file(credentials))
  await chmod(destination, 0o600)
}

const executable = path.resolve(import.meta.dir, "../packages/cli/dist/cli-darwin-arm64/bin/opencode")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const environment = {
  OPENCODE_CONFIG_DIR: config,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  OPENCODE_DB: path.join(root, "data/opencode/opencode.db"),
  CURSOR_OPENCODE2_TODOS: "1",
}
await Bun.write(path.join(root, "profile.json"), JSON.stringify({ root, executable, environment }, null, 2) + "\n")
await Bun.write(
  path.join(root, "bin/opencode-v2-candidate"),
  `#!/bin/sh\nexec env ${Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(executable)} "$@"\n`,
)
await chmod(path.join(root, "bin/opencode-v2-candidate"), 0o700)
console.log(`Prepared isolated profile: ${root}`)
console.log("V1 configuration and database were not modified. Online database backup remains a separate step.")
