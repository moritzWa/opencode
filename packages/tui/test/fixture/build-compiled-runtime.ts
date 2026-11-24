import path from "node:path"
import solid from "@opentui/solid/bun-plugin"
import { createPluginRuntimePlugin } from "@opencode/plugin/runtime-build"

const outfile = process.argv[2]
if (!outfile) throw new Error("Compiled consumer output path is required")
const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "compiled-runtime.ts")],
  plugins: [solid, createPluginRuntimePlugin()],
  target: "bun",
  format: "esm",
  minify: true,
  bytecode: true,
  splitting: true,
  // Match the CLI build: resolve one libc variant instead of bundling optional packages for both.
  define: { "process.env.OPENTUI_LIBC": JSON.stringify(process.env.OPENTUI_LIBC ?? "glibc") },
  compile: { outfile, autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: true, autoloadPackageJson: true },
})
if (!result.success) throw new AggregateError(result.logs, "Compiled runtime consumer build failed")
