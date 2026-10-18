import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ensurePluginRuntime } from "../../../packages/plugin/src/runtime.ts"
import { openHost } from "./host.js"

const artifact = process.env.TODO_ARTIFACT
test.skipIf(!artifact)(
  "packed plugin installs without a workspace and executes against real persistent host storage",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-packed-todo-"))
    try {
      await Bun.write(
        path.join(root, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: { "@moritz/opencode-todo": `file:${artifact}` },
        }),
      )
      const child = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
      const directory = path.join(root, "node_modules/@moritz/opencode-todo")
      ensurePluginRuntime()
      const packed = await import(path.join(directory, "server.js"))
      expect(packed.default.id).toBe("moritz-todo")
      for (const file of ["server.js", "store.js", "rpc.js", "tui.js"]) {
        expect(await Bun.file(path.join(directory, file)).text()).toBe(
          await Bun.file(path.join(import.meta.dir, "..", file)).text(),
        )
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* openHost(root, {}, packed.default)
          const session = yield* host.create("anthropic")
          const todos = [{ content: "Packed non-Cursor todo", status: "pending", priority: "high" }]
          expect((yield* host.call(session, "todowrite", { todos })).metadata.todos).toEqual(todos)
          expect((yield* host.call(session, "todoread", {})).metadata.todos).toEqual(todos)
        }).pipe(Effect.scoped),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
