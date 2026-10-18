import { expect, test } from "bun:test"
import path from "node:path"
import { lstat } from "node:fs/promises"
import { tmpdir } from "./fixture/fixture"
import { installRuntimePeer } from "./fixture/runtime-peer"

// A cold executable build, physical NPM install and four complete app boots.
test("compiled consumer shares host runtime with physically installed NPM TUI peers", async () => {
  await using root = await tmpdir()
  const peer = await installRuntimePeer(root.path)
  expect((await lstat(peer.directory)).isSymbolicLink()).toBe(false)
  const executable = path.join(peer.consumer, process.platform === "win32" ? "consumer.exe" : "consumer")
  // Other renderer tests install runtime providers in this process. Compile in
  // a clean child so those providers cannot mask a missing embedded host map.
  const build = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, "fixture/build-compiled-runtime.ts"), executable],
    { stdout: "pipe", stderr: "pipe" },
  )
  const built = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()])
  expect({ code: built[0], output: built[0] ? built.slice(1) : [] }).toEqual({ code: 0, output: [] })
  for (const native of [false, true]) {
    await peer.entry(native)
    for (const local of [undefined, peer.wrapper]) {
      const child = Bun.spawn([executable, peer.directory, ...(local ? [local] : [])], {
        cwd: peer.consumer,
        env: {
          ...process.env,
          HOME: peer.consumer,
          XDG_CONFIG_HOME: path.join(peer.consumer, "config"),
          XDG_DATA_HOME: path.join(peer.consumer, "data"),
          XDG_STATE_HOME: path.join(peer.consumer, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ entry: native ? "v2" : "tui", mode: local ? "local-wrapper" : "npm", code, stderr }).toEqual({
        entry: native ? "v2" : "tui",
        mode: local ? "local-wrapper" : "npm",
        code: 0,
        stderr: "",
      })
      expect(stdout).toContain("COMPILED_RUNTIME_SHARED_OK")
    }
  }
}, 120_000)
