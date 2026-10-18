import solid from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: [new URL("src/tui.tsx", import.meta.url).pathname],
  outdir: import.meta.dir,
  naming: "tui.js",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solid],
})
if (!result.success) throw new AggregateError(result.logs, "Could not build portable todo TUI")
