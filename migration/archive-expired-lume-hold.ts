import os from "node:os"
import path from "node:path"
import { mkdir, rename, chmod } from "node:fs/promises"

const home = os.homedir()
const session = "ses_eccf73623ffe7ACosQN9JPoGaZ"
const source = path.join(home, ".local/state/agentview/holds/opencode", session, "bg-42682-58315.json")
const hold = await Bun.file(source).json()
if (hold.pid !== 58315 || hold.expires_ms >= Date.now() || hold.command !== "/Users/m/.cua/runtimes/lume/0.6.0/lume.app/Contents/MacOS/lume serve") throw new Error("Reviewed expired Lume marker changed")
const process = Bun.spawnSync(["ps", "-p", String(hold.pid), "-o", "ppid=,command="], { stdout: "pipe", stderr: "pipe" })
if (process.exitCode || !process.stdout.toString().trim().startsWith("1 ") || !process.stdout.toString().includes(hold.command)) throw new Error("Shared daemon no longer has the reviewed independent identity")
const target = path.join(home, ".local/share/opencode-v2/rollback/expired-holds", session)
await mkdir(target, { recursive: true, mode: 0o700 })
await rename(source, path.join(target, path.basename(source)))
await chmod(path.join(target, path.basename(source)), 0o600)
console.log("Archived expired hold only; independently running shared Lume process untouched")
