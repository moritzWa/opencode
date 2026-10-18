import os from "node:os"
import path from "node:path"

const root = path.join(os.homedir(), ".local/share/opencode-v2-migration")
const archive = path.join(root, "runtime/vm-client-profile.tgz")
const child = Bun.spawn(["tar", "-czf", archive, "--exclude=opencode.jsonc", "--exclude=opencode-notes-v2.md", "--exclude=ports/auth", "--exclude=ports/cursor", "--exclude=ports/parity-server", "--exclude=ports/todo-server", "-C", path.join(root, "config/opencode"), "node_modules", "cli.json", "ports", "themes"], { stdout: "inherit", stderr: "inherit" })
if (await child.exited) throw new Error("VM client profile archive failed")
console.log(`Packed exact client runtime dependencies ${archive}`)
