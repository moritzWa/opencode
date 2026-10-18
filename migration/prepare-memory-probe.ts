import os from "node:os"
import path from "node:path"

const root = path.join(os.homedir(), ".local/share/opencode-v2-migration")
const { MemoryStore } = await import(path.join(root, "config/opencode/node_modules/@moritz/opencode-parity-plugins/legacy/memory.js"))
const store = new MemoryStore(path.join(root, "projects/account-probe"), { claudeConfigDir: path.join(root, "claude") })
if (!store.memoryDir.startsWith(path.join(root, "claude") + path.sep)) throw new Error("Probe memory escaped rehearsal root")
const passphrase = "V2-MEMORY-" + crypto.randomUUID()
store.save({
  fileName: "migration_selector_fixture.md",
  name: "Migration acceptance passphrase",
  description: "Synthetic migration acceptance reference containing the unique probe passphrase.",
  type: "reference",
  content: `The acceptance passphrase is ${passphrase}.`,
})
await Bun.write(path.join(root, "runtime/memory-fixture.json"), JSON.stringify({ fileName: "migration_selector_fixture.md", passphrase, memoryDir: store.memoryDir }, null, 2) + "\n")
// This probe checks real structured selection, not the original latency budget.
// The assembler restores the original wait budget on the next normal assembly.
const filename = path.join(root, "config/opencode/opencode.jsonc")
const config = await Bun.file(filename).json()
const parity = config.plugins.find((plugin: { package: string }) => plugin.package.endsWith("/parity-server"))
parity.options.memory.recall = { ...parity.options.memory.recall, waitMs: 15000 }
await Bun.write(filename, JSON.stringify(config, null, 2) + "\n")
console.log("Prepared isolated packed-store memory fixture; selector wait budget 15s for this probe only")
