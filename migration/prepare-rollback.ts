import os from "node:os"
import path from "node:path"
import { mkdir, chmod, cp } from "node:fs/promises"

const home = os.homedir()
const root = path.join(home, ".local/share/opencode-v2/rollback")
if (process.argv.includes("--compat-only")) {
  const manifest = await Bun.file(path.join(root, "manifest.json")).json()
  if (manifest.compatBinary) throw new Error("Stock CLI rollback already preserved")
  const source = path.join(home, ".opencode/bin/opencode")
  const bytes = await Bun.file(source).arrayBuffer()
  await Bun.write(path.join(root, "opencode-stock-v1"), bytes)
  await chmod(path.join(root, "opencode-stock-v1"), 0o700)
  manifest.compatBinary = { source, preserved: path.join(root, "opencode-stock-v1"), sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }
  await Bun.write(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  console.log("Preserved stock opencode entrypoint before default V2 routing")
  process.exit(0)
}
if (await Bun.file(path.join(root, "manifest.json")).exists()) throw new Error("Rollback checkpoint already exists")
await mkdir(root, { recursive: true, mode: 0o700 })
const source = path.join(home, ".local/bin/opencode-dev")
const bytes = await Bun.file(source).arrayBuffer()
await Bun.write(path.join(root, "opencode-dev-v1"), bytes)
await chmod(path.join(root, "opencode-dev-v1"), 0o700)
await cp(path.join(home, ".local/state/agentview/opencode"), path.join(root, "supervisor-before-freeze"), { recursive: true })
await cp(path.join(home, ".config/opencode"), path.join(root, "config-v1"), { recursive: true, filter: (source) => !source.includes("/node_modules") && !source.includes("/.git") })
await Bun.write(path.join(root, "manifest.json"), JSON.stringify({ created: new Date().toISOString(), binary: { source, preserved: path.join(root, "opencode-dev-v1"), sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength }, originalDatabase: path.join(home, ".local/share/opencode/opencode.db"), originalConfig: path.join(home, ".config/opencode"), note: "Original database is never modified by V2; final frozen snapshot and supervisor checkpoint are captured separately at cutover." }, null, 2) + "\n")
await chmod(path.join(root, "manifest.json"), 0o600)
console.log("Preserved V1 binary, configuration, and private supervisor state for rollback")
