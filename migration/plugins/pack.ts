import { dirname, join } from "node:path"

const artifacts = join(import.meta.dir, "artifacts")
for (const directory of [import.meta.dir, dirname(Bun.resolveSync("opencode-read-aloud/v2", import.meta.dir))]) {
  const result = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", artifacts], { cwd: directory, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode) throw new Error(`Could not pack ${directory}`)
}
const checksums = []
for await (const file of new Bun.Glob("*.tgz").scan(artifacts)) {
  checksums.push(`${new Bun.CryptoHasher("sha256").update(await Bun.file(join(artifacts, file)).arrayBuffer()).digest("hex")}  ${file}`)
}
await Bun.write(join(artifacts, "SHA256SUMS"), checksums.sort().join("\n") + "\n")
console.log(checksums.join("\n"))
