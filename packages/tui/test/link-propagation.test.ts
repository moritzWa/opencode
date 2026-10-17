import { expect, test } from "bun:test"
import { chmod, mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/fixture"

const parity = process.env.OPENCODE_LINK_QA_PARITY_TUI
const powershell = process.platform === "win32" || Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME)

// Optional migration integration, using the compiled plugin and its installed
// dependencies rather than a copied mouse implementation:
// OPENCODE_LINK_QA_PARITY_TUI=<migration-worktree>/migration/plugins/ui-only \
//   bun test --timeout 30000 test/link-propagation.test.ts

// Windows/WSL `open` invokes an absolute PowerShell executable instead of a PATH
// opener. Do not risk a real desktop launch where this interception cannot work.
test.skipIf(powershell).each([80, 44])(
  "production App opens native links once and preserves mouse guards at width %s",
  (width) => verify(width),
  30_000,
)

test.skipIf(!parity || powershell).each([80, 44])(
  "App and parity plugin split native and speech-fallback ownership at width %s",
  (width) => verify(width, parity),
  30_000,
)

test.skipIf(!parity || powershell)(
  "negative control catches duplicate native opening without the adapter guard",
  () => verify(80, parity, true),
  30_000,
)

async function verify(width: number, plugin?: string, historical = false) {
  await using root = await tmpdir()
  const bin = path.join(root.path, "bin")
  const record = path.join(root.path, "opened.jsonl")
  await mkdir(bin)
  const active = await (async () => {
    if (!historical || !plugin) return plugin
    // Reproduce the old handler in a private copy. Keep both real handlers and
    // the real compatibility bridge; remove only the new native-ownership guard.
    const legacy = await Bun.file(path.resolve(plugin, "../legacy/tui-plugins/clickable-links.js")).text()
    const guard = "  if (renderer.getLinkAt?.(event.x, event.y))\n    return;\n"
    expect(legacy).toContain(guard)
    const directory = path.join(root.path, "negative-control")
    await mkdir(directory)
    await symlink(path.join(import.meta.dir, "../node_modules"), path.join(directory, "node_modules"))
    await Bun.write(path.join(directory, "links.js"), legacy.replace(guard, ""))
    await Bun.write(
      path.join(directory, "tui.tsx"),
      `import { adapt } from ${JSON.stringify(path.resolve(plugin, "../node_modules/opencode-read-aloud/v2-compat.js"))}\nimport links from "./links.js"\nexport default { id: "link-negative-control", async setup(context) { const bridge = adapt(context); await links.tui(bridge.api); context.ui.slot({ append: "prompt.metadata", render: () => <text>Link QA</text> }); return bridge.dispose } }\n`,
    )
    return directory
  })()
  // Both production openUrl (the `open` package) and the legacy plugin launch a
  // platform executable. Replace that executable only in this isolated child.
  // Never call a real desktop opener, and never mock either production handler.
  for (const name of ["open", "xdg-open", "explorer.exe"]) {
    const file = path.join(bin, name)
    await Bun.write(
      file,
      `#!${process.execPath}\nimport { appendFileSync } from "node:fs"\nappendFileSync(process.env.OPENCODE_LINK_QA_RECORD, JSON.stringify({ scenario: process.env.OPENCODE_LINK_QA_SCENARIO, args: process.argv.slice(2) }) + "\\n")\n`,
    )
    await chmod(file, 0o755)
  }
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "fixture/link-propagation.ts")], {
    cwd: path.join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      BROWSER: path.join(bin, "xdg-open"),
      HOME: root.path,
      XDG_CONFIG_HOME: path.join(root.path, "config"),
      XDG_STATE_HOME: path.join(root.path, "state"),
      XDG_DATA_HOME: path.join(root.path, "data"),
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_LINK_QA_PARITY_TUI: active,
      OPENCODE_LINK_QA_RECORD: record,
      OPENCODE_LINK_QA_WIDTH: String(width),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (historical) {
    expect(code).toBe(1)
    expect(stderr).toContain("one opener per gesture")
    const recorded = (await Bun.file(record).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] })
    expect(recorded).toHaveLength(2)
    expect(recorded[0]?.args.at(-1)).toBe(recorded[1]?.args.at(-1))
    return
  }
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  const report = stdout.split("\n").find((line) => line.startsWith("LINK_QA_RESULT "))
  expect(report).toBeDefined()
  expect(report).toContain(plugin ? '"fallback":4' : '"fallback":0')
  expect(report).toContain('"native":3')
  expect(report).toContain('"guarded":0')
}
