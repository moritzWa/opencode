import { strict as assert } from "node:assert"
import { join } from "node:path"
import { createMemory } from "../server.js"
import { readFileSync, existsSync } from "node:fs"

const environment = { ...process.env }
const selected = join(process.env.HOME, "copied-claude")
const authRoot = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude")
const input = { directory: process.env.HOME, worktree: process.env.HOME }
const options = { memory: { recall: { enabled: false }, extract: { enabled: false } } }
const defaults = await createMemory(input, options)
const isolated = await createMemory(input, { ...options, memoryConfigDir: selected })
const again = await createMemory(input, options)
try {
  const authFile = join(authRoot, ".credentials.json")
  await Bun.write(authFile, "auth-discovery-sentinel")
  const saved = isolated.memory.store.save({ fileName: "isolation", name: "Isolation", description: "fixture", type: "reference", content: "isolated memory only" })
  assert(saved.filePath.startsWith(selected))
  assert(existsSync(saved.filePath))
  assert(readFileSync(saved.filePath, "utf8").includes("isolated memory only"))
  assert.equal(defaults.memory.store.list().length, 0)
  assert(isolated.memory.store.memoryDir.startsWith(join(selected, "projects")))
  assert(isolated.memory.store.stateDir.startsWith(join(selected, "opencode-memory")))
  assert.equal(isolated.memory.config.claudeConfigDir, selected)
  assert.equal(defaults.memory.config.claudeConfigDir, authRoot)
  assert.equal(again.memory.store.memoryDir, defaults.memory.store.memoryDir)
  assert.equal(again.memory.store.stateDir, defaults.memory.store.stateDir)
  assert.notEqual(isolated.memory.store.memoryDir, defaults.memory.store.memoryDir)
  assert.deepEqual({ ...process.env }, environment)
  assert.equal(readFileSync(authFile, "utf8"), "auth-discovery-sentinel")
  console.log("MEMORY_ROOT_ISOLATION_OK")
} finally { await Promise.all([defaults.dispose(), isolated.dispose(), again.dispose()]) }
