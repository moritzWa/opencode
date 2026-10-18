import { mkdir } from "node:fs/promises"
import path from "node:path"
import "./build.ts"

const destination = path.join(import.meta.dir, "artifacts")
await mkdir(destination, { recursive: true })
const child = Bun.spawn([process.execPath, "pm", "pack", "--destination", destination], {
  cwd: import.meta.dir,
  stdout: "pipe",
  stderr: "inherit",
})
const output = await new Response(child.stdout).text()
if (await child.exited) throw new Error("Could not pack todo plugin")
const file = output
  .trim()
  .split("\n")
  .findLast((line) => line.endsWith(".tgz"))
if (!file) throw new Error(`No packed artifact reported: ${output}`)
const artifact = path.isAbsolute(file) ? file : path.resolve(import.meta.dir, file)
const manifest = {
  package: "@moritz/opencode-todo@0.1.0",
  file: artifact,
  sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(artifact).arrayBuffer()).digest("hex"),
  sources: await Promise.all(
    ["server.js", "store.js", "rpc.js", "tui.js", "config-fragment.json", "tui-fragment.json"].map(async (file) => ({
      file,
      sha256: new Bun.CryptoHasher("sha256")
        .update(await Bun.file(path.join(import.meta.dir, file)).arrayBuffer())
        .digest("hex"),
    })),
  ),
}
await Bun.write(path.join(import.meta.dir, "artifacts.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(JSON.stringify(manifest, null, 2))
