import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv } from "./fixture/environment"

test("debug skill --diagnostics uses the public location-scoped endpoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-debug-skill-"))
  const cwd = path.join(import.meta.dir, "..")
  const diagnostics = [
    { path: "/skills/loaded/SKILL.md", id: "loaded", status: "loaded" },
    { path: "/skills/broken/SKILL.md", status: "skipped", reason: "Invalid frontmatter" },
    { path: "/skills/shadowed/SKILL.md", id: "loaded", status: "shadowed", reason: "Overridden" },
    { path: "/skills/new/SKILL.md", id: "new", status: "unadvertised" },
  ]
  const urls: URL[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info")
        return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: root } })
      urls.push(url)
      return Response.json({ location: { directory: cwd }, data: diagnostics })
    },
  })
  try {
    await fs.mkdir(path.join(root, "state", "opencode"), { recursive: true })
    await Bun.write(
      path.join(root, "state", "opencode", "service-local.json"),
      JSON.stringify({ version: OPENCODE_VERSION, url: server.url.toString(), pid: process.pid, password: "secret" }),
    )
    const child = Bun.spawn(
      [process.execPath, "run", path.join(cwd, "src/index.ts"), "debug", "skill", "--diagnostics"],
      { cwd, env: isolatedEnv(root), stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 })
    expect(JSON.parse(stdout)).toEqual(diagnostics)
    expect(urls.map((url) => url.pathname)).toEqual(["/api/skill/diagnostics"])
    expect(urls[0]?.searchParams.get("location[directory]")).toBe(cwd)
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})
