import path from "node:path"
import os from "node:os"

const source = path.resolve(import.meta.dir, "..")
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
const commit = git(["rev-parse", "HEAD"])
if (git(["status", "--porcelain", "--", "packages", "services", "package.json", "bun.lock"])) {
  throw new Error("Commit or reconcile runtime source changes before stamping a candidate build")
}
const pkg = await Bun.file(path.join(source, "package.json")).json()
const version = `${pkg.version}-migration.${commit.slice(0, 10)}`
const web = process.argv.includes("--web")
const child = Bun.spawn(["bun", "run", "script/build.ts", "--single", "--skip-install", ...(!web ? ["--skip-web-ui"] : [])], {
  cwd: path.join(source, "packages/cli"),
  env: { ...process.env, OPENCODE_CHANNEL: "migration", OPENCODE_VERSION: version },
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
if (await child.exited) throw new Error("Candidate build failed")
const executable = path.join(source, `packages/cli/dist/cli-${process.platform}-${process.arch}/bin/opencode`)
const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(executable).arrayBuffer()).digest("hex")
const root = path.join(os.homedir(), ".local/share/opencode-v2-migration")
await Bun.write(path.join(root, "runtime/binary-build.json"), JSON.stringify({ commit, version, source, executable, sha256, webEmbedded: web, created: new Date().toISOString() }, null, 2) + "\n")
console.log(`Stamped candidate ${version} SHA256 ${sha256}`)
