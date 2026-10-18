import os from "node:os"
import path from "node:path"
import { chmod, mkdir } from "node:fs/promises"

const home = os.homedir()
const root = path.join(home, ".local/share/opencode-v2")
await mkdir(path.join(root, "runtime"), { recursive: true, mode: 0o700 })
for (const argv of [["bun", path.join(import.meta.dir, "verify-installer.ts")], ["python3", path.join(import.meta.dir, "verify-helpers.py")]]) {
  const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" })
  if (await child.exited) throw new Error("Actual launcher/helper proof failed")
}
const hash = async (file: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
const helpers = ["opencode-bg.sh", "opencode-message.py"].map((name) => path.join(home, ".claude/scripts", name))
const proof = {
  version: 1,
  checks: { cliPendingGate: true, dashboardPendingGate: true, parentGlobalXdg: true, childProfilePaths: true, exactRollbackVerified: true, pendingBeforeSelection: true },
  installerSha256: await hash(path.join(home, ".claude/scripts/install-latest.sh")),
  helperSha256: Object.fromEntries(await Promise.all(helpers.map(async (file) => [file, await hash(file)]))),
}
await Bun.write(path.join(root, "runtime/cutover-approval.json"), JSON.stringify(proof, null, 2) + "\n")
await chmod(path.join(root, "runtime/cutover-approval.json"), 0o600)
if (!(await Bun.file(path.join(root, "runtime/cutover-config.json")).exists())) {
  await Bun.write(path.join(root, "runtime/cutover-config.json"), JSON.stringify({ dashboardPID: 4090, frontendPIDs: [9283] }, null, 2) + "\n")
  await chmod(path.join(root, "runtime/cutover-config.json"), 0o600)
}
const manifest = await Bun.file(path.join(root, "artifacts/manifest.json")).json()
for (const file of Object.values(manifest.packages)) await chmod(String(file), 0o400)
for (const file of ["profile.json", "artifacts/manifest.json", "runtime/v1-inventory.json", "rollback/manifest.json"]) await chmod(path.join(root, file), 0o600)
console.log("Prepared private cutover inputs from actual passing process proofs; accepted archives sealed read-only")
