import os from "node:os"
import path from "node:path"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"

const script = await Bun.file(path.join(os.homedir(), ".claude/scripts/install-latest.sh")).text()
const code = script.match(/OPENCODE_INSTALL_PROFILE=.*OPENCODE_INSTALL_LAUNCHER="\$wt\/opencode-dev-launcher" bun -e '([\s\S]*?)\n  '/)?.[1]
if (!code) throw new Error("Approved installer launcher generator not found")
const temporary = await mkdtemp("/var/folders/n9/hr809bk55vb2tm653_tkg7m00000gn/T/opencode/installer-proof-")
try {
  const root = path.join(temporary, "profile with ' quote")
  await mkdir(path.join(root, "bin/native"), { recursive: true })
  await Bun.write(path.join(root, "profile.json"), JSON.stringify({ executable: "/old/source/path", environment: { OPENCODE_DB: path.join(root, "data/history.db"), OPENCODE_CONFIG_DIR: path.join(root, "config with ' quote") } }))
  await Bun.write(path.join(root, "bin/native/opencode-dev"), "#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({'db':os.environ['OPENCODE_DB'],'config':os.environ['OPENCODE_CONFIG_DIR'],'args':sys.argv[1:]}))\n")
  await chmod(path.join(root, "bin/native/opencode-dev"), 0o700)
  const launcher = path.join(root, "launcher")
  const generated = Bun.spawn(["bun", "-e", code], { env: { ...process.env, OPENCODE_INSTALL_PROFILE: root, OPENCODE_INSTALL_LAUNCHER: launcher }, stdout: "pipe", stderr: "pipe" })
  if (await generated.exited) throw new Error(await new Response(generated.stderr).text())
  const child = Bun.spawn(["sh", launcher, "argument with spaces", "quote's argument"], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).json()
  if (await child.exited) throw new Error(await new Response(child.stderr).text())
  if (output.db !== path.join(root, "data/history.db") || output.config !== path.join(root, "config with ' quote") || JSON.stringify(output.args) !== JSON.stringify(["argument with spaces", "quote's argument"])) throw new Error("Profile environment or argument quoting changed")
  const profile = await Bun.file(path.join(root, "profile.json")).json()
  if (profile.executable !== path.join(root, "bin/native/opencode-dev")) throw new Error("Installed native path not recorded")
  await mkdir(path.join(root, "runtime"))
  await Bun.write(path.join(root, "runtime/cutover.pending"), "pending")
  const fenced = Bun.spawn(["sh", launcher], { stdout: "pipe", stderr: "pipe" })
  if (await fenced.exited !== 75) throw new Error("Pending cutover did not fence ordinary CLI launch")
  await rm(path.join(root, "runtime/cutover.pending"))

  const dashboardCode = script.match(/OPENCODE_INSTALL_PROFILE=.*OPENCODE_INSTALL_LAUNCHER="\$wt\/agentview-launcher" bun -e '([\s\S]*?)\n    '/)?.[1]
  if (!dashboardCode) throw new Error("Approved dashboard launcher generator not found")
  const home = path.join(temporary, "fake home")
  await mkdir(path.join(home, ".local/state/install-latest"), { recursive: true })
  await Bun.write(path.join(home, ".local/state/install-latest/opencode-v2-ref"), "fork/v2-parity\n")
  profile.serviceFile = path.join(root, "native service.json")
  profile.environment.XDG_STATE_HOME = path.join(root, "state")
  await Bun.write(path.join(root, "profile.json"), JSON.stringify(profile))
  await Bun.write(path.join(root, "bin/native/agentview"), "#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({'state':os.environ.get('XDG_STATE_HOME'),'api':os.environ.get('AGENTVIEW_OPENCODE_API'),'service':os.environ.get('AGENTVIEW_OPENCODE_SERVICE_FILE'),'args':sys.argv[1:]}))\n")
  await chmod(path.join(root, "bin/native/agentview"), 0o700)
  const dashboard = path.join(root, "dashboard")
  const generatedDashboard = Bun.spawn(["bun", "-e", dashboardCode], { env: { ...process.env, HOME: home, OPENCODE_INSTALL_PROFILE: root, OPENCODE_INSTALL_LAUNCHER: dashboard }, stdout: "pipe", stderr: "pipe" })
  if (await generatedDashboard.exited) throw new Error(await new Response(generatedDashboard.stderr).text())
  const run = async (args: string[]) => {
    const child = Bun.spawn(["sh", dashboard, ...args], { env: { ...process.env, XDG_STATE_HOME: "original-state", AGENTVIEW_OPENCODE_API: "v1" }, stdout: "pipe", stderr: "pipe" })
    const result = await new Response(child.stdout).json()
    if (await child.exited) throw new Error(await new Response(child.stderr).text())
    return result
  }
  const selected = await run(["sessions", "hidden"])
  if (selected.api !== "v2" || selected.state !== "original-state" || selected.service !== profile.serviceFile || JSON.stringify(selected.args) !== JSON.stringify(["--opencode-bin", path.join(home, ".local/bin/opencode-dev"), "sessions", "hidden"])) throw new Error("Dashboard routing changed or other harness state was relocated")
  const explicit = await run(["--opencode-bin", "/explicit/custom binary", "sessions", "hidden"])
  if (JSON.stringify(explicit.args) !== JSON.stringify(["--opencode-bin", "/explicit/custom binary", "sessions", "hidden"])) throw new Error("Explicit OpenCode binary was duplicated or replaced")
  await Bun.write(path.join(root, "runtime/cutover.pending"), "pending")
  const dashboardFence = Bun.spawn(["sh", dashboard], { stdout: "pipe", stderr: "pipe" })
  if (await dashboardFence.exited !== 75) throw new Error("Dashboard cutover gate did not refuse launch")
  await rm(path.join(root, "runtime/cutover.pending"))
  await Bun.write(path.join(home, ".local/state/install-latest/opencode-v2-ref"), "")
  const reverted = await run(["sessions", "hidden"])
  if (reverted.api !== "v1" || reverted.state !== "original-state" || JSON.stringify(reverted.args) !== JSON.stringify(["sessions", "hidden"])) throw new Error("Dashboard did not return to original routing after V1 rollback")
  await mkdir(path.join(home, ".claude/scripts"), { recursive: true })
  await mkdir(path.join(home, ".local/bin"), { recursive: true })
  await mkdir(path.join(home, ".opencode/bin"), { recursive: true })
  const rollback = path.join(home, ".local/share/opencode-v2/rollback")
  await mkdir(rollback, { recursive: true })
  await Bun.write(path.join(home, ".claude/scripts/install-bin.sh"), Bun.file(path.join(os.homedir(), ".claude/scripts/install-bin.sh")))
  await chmod(path.join(home, ".claude/scripts/install-bin.sh"), 0o700)
  const old = "#!/bin/sh\nprintf old-v1\n"
  const stock = "#!/bin/sh\nprintf stock-v1\n"
  await Bun.write(path.join(rollback, "opencode-dev-v1"), old)
  await Bun.write(path.join(rollback, "opencode-stock-v1"), stock)
  await Bun.write(path.join(rollback, "manifest.json"), JSON.stringify({ binary: { sha256: new Bun.CryptoHasher("sha256").update(old).digest("hex") } }))
  const restore = Bun.spawn(["bash", path.join(os.homedir(), ".claude/scripts/install-latest.sh"), "opencode"], { env: { ...process.env, HOME: home, INSTALL_LATEST_OPENCODE_V1: "1", INSTALL_LATEST_OPENCODE_ROLLBACK: path.join(rollback, "opencode-dev-v1"), INSTALL_LATEST_NO_RESTART: "1" }, stdout: "pipe", stderr: "pipe" })
  if (await restore.exited) throw new Error(await new Response(restore.stderr).text())
  if (await Bun.file(path.join(home, ".local/bin/opencode-dev")).text() !== old || await Bun.file(path.join(home, ".opencode/bin/opencode")).text() !== stock) throw new Error("Actual exact rollback branch did not restore both preserved entries")
  console.log("Actual installer process proofs passed routing/quoting, both pending gates, explicit binary, parent state preservation, and exact V1 binary rollback")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
