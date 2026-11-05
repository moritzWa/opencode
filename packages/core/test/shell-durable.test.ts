import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Shell } from "@opencode/core/shell"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Real processes, real files. A "server restart" is a second Shell layer built over the same
// Global data directory and Location, after the first layer's scope was closed.
const describeUnix = process.platform === "win32" ? describe.skip : describe

const alive = (pid: number | undefined) => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const until = <A>(label: string, check: () => Promise<A | undefined | false>, ms = 8000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${label}`)
  })

const server = Effect.fnUntraced(function* () {
  const tmp = yield* tmpdirScoped()
  const data = path.join(tmp.path, "global")
  const directory = path.join(tmp.path, "project")
  yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
  const global = Global.layerWith({
    data,
    cache: path.join(tmp.path, "cache"),
    config: path.join(tmp.path, "config"),
    state: path.join(tmp.path, "state"),
    tmp: path.join(tmp.path, "tmp"),
    bin: path.join(tmp.path, "cache", "bin"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
  })
  const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
  const layer = AppNodeBuilder.build(Shell.node, [
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location(ref)))),
    Global.node.replace(global),
    Config.node.replace(Config.testLayer()),
    Environment.node.replace(hostEnvironmentLayer),
  ])
  // Runs `use` against a fresh Shell layer and closes it afterwards, like a server stopping.
  const boot = <A, E, R>(use: Effect.Effect<A, E, R>) => use.pipe(Effect.provide(layer), Effect.scoped)
  return { tmp, directory, boot, shells: path.join(data, "shell") }
})

describeUnix("durable shells", () => {
  it.live("a background command runs normally and reports its exit status and output", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const info = yield* shell.create({
            shell: "/bin/sh",
            command: "printf hello; sleep 0.4; exit 3",
            durable: true,
          })
          expect(info.status).toBe("running")
          // A client can tell from the listing that a restart will not stop this command.
          expect(info.metadata).toMatchObject({ durable: true })
          expect(alive(info.pid)).toBe(true)
          expect(yield* shell.result(info)).toMatchObject({
            info: { status: "exited", exit: 3 },
            capture: { output: "hello", truncated: false },
          })
        }),
      )
    }),
  )

  it.live("the command keeps running when the server stops and is reattached by the next one", () =>
    Effect.gen(function* () {
      const { boot, directory } = yield* server()
      const started = yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          return yield* shell.create({
            shell: "/bin/sh",
            command: "echo before; sleep 1; echo after",
            cwd: directory,
            durable: true,
            metadata: { sessionID: "ses_keep" },
          })
        }),
      )
      // The first server is gone. Its command must not be.
      expect(alive(started.pid)).toBe(true)

      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const listed = yield* shell.list()
          expect(listed.map((item) => item.id)).toEqual([started.id])
          expect(listed[0]).toMatchObject({ pid: started.pid, metadata: { sessionID: "ses_keep", durable: true } })
          expect(yield* shell.result(listed[0]!)).toMatchObject({
            info: { status: "exited", exit: 0 },
            capture: { output: "before\nafter\n" },
          })
        }),
      )
    }),
  )

  it.live("a command that finished while no server ran still reports its real exit status", () =>
    Effect.gen(function* () {
      const { boot, shells } = yield* server()
      const started = yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          return yield* shell.create({ shell: "/bin/sh", command: "printf done; exit 5", durable: true })
        }),
      )
      yield* until("exit file", async () =>
        fs.stat(path.join(shells, "global", `${started.id}.exit`)).then(
          () => true,
          () => false,
        ),
      )
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          expect(yield* shell.get(started.id)).toMatchObject({ status: "exited", exit: 5 })
          expect(yield* shell.result(started)).toMatchObject({ capture: { output: "done" } })
          expect(yield* shell.list()).toEqual([])
        }),
      )
    }),
  )

  it.live("a command killed by a signal reports the signal, not a bare exit code", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const info = yield* shell.create({ shell: "/bin/sh", command: "kill -TERM $$", durable: true })
          expect(yield* shell.result(info)).toMatchObject({ info: { status: "exited", signal: "SIGTERM" } })
        }),
      )
    }),
  )

  it.live("a signal sent to the whole group or to the reported pid alone both stop the command", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const group = yield* shell.create({ shell: "/bin/sh", command: "sleep 60", durable: true })
          process.kill(-group.pid!, "SIGTERM")
          expect(yield* shell.result(group)).toMatchObject({ info: { status: "exited", signal: "SIGTERM" } })

          const single = yield* shell.create({ shell: "/bin/sh", command: "sleep 60", durable: true })
          yield* until("running", async () => alive(single.pid))
          process.kill(single.pid!, "SIGTERM")
          expect(yield* shell.result(single)).toMatchObject({ info: { status: "exited", signal: "SIGTERM" } })
          yield* until("process stopped", async () => !alive(single.pid))
        }),
      )
    }),
  )

  it.live("a command that ignores a polite stop is forced to end", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const info = yield* shell.create({
            shell: "/bin/sh",
            command: "trap '' TERM; while :; do sleep 1; done",
            durable: true,
            timeout: 300,
          })
          expect((yield* shell.result(info)).info.status).toBe("timeout")
          yield* until("forced stop", async () => !alive(info.pid), 10000)
        }),
      )
    }),
  )

  it.live("a command whose process vanished without a status is reported lost with a note in its output", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      const started = yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          return yield* shell.create({ shell: "/bin/sh", command: "echo partial; sleep 30", durable: true })
        }),
      )
      yield* until("first output", async () =>
        (await fs.readFile(started.file, "utf8").catch(() => "")).includes("partial"),
      )
      process.kill(-started.pid!, "SIGKILL")
      yield* until("process gone", async () => !alive(started.pid))
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const result = yield* shell.result(started)
          expect(result.info.status).toBe("killed")
          expect(result.capture?.output).toContain("partial")
          expect(result.capture?.output).toContain("disappeared")
        }),
      )
    }),
  )

  it.live("a recycled process id is not mistaken for the command", () =>
    Effect.gen(function* () {
      const { boot, shells } = yield* server()
      const started = yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          return yield* shell.create({ shell: "/bin/sh", command: "sleep 30", durable: true })
        }),
      )
      process.kill(-started.pid!, "SIGKILL")
      yield* until("process gone", async () => !alive(started.pid))
      // Point the record at an unrelated live process: same pid slot, different start time.
      const file = path.join(shells, "global", `${started.id}.json`)
      const record = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
      yield* Effect.promise(() =>
        fs.writeFile(file, JSON.stringify({ ...record, pid: process.pid, identity: "Thu Jan  1 00:00:00 1970" })),
      )
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          expect((yield* shell.get(started.id)).status).toBe("killed")
        }),
      )
      expect(alive(process.pid)).toBe(true)
    }),
  )

  it.live("remove stops the whole process group and deletes its files", () =>
    Effect.gen(function* () {
      const { boot, shells } = yield* server()
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const info = yield* shell.create({ shell: "/bin/sh", command: "sleep 60 & sleep 60", durable: true })
          yield* shell.remove(info.id)
          yield* until("process group stopped", async () => !alive(info.pid))
          const left = yield* Effect.promise(() => fs.readdir(path.join(shells, "global")).catch(() => []))
          expect(left.filter((name) => name.startsWith(info.id))).toEqual([])
        }),
      )
    }),
  )

  it.live("a timeout stops the command and reports a timeout", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const info = yield* shell.create({ shell: "/bin/sh", command: "sleep 60", durable: true, timeout: 300 })
          const result = yield* shell.result(info)
          expect(result.info.status).toBe("timeout")
          yield* until("process stopped", async () => !alive(info.pid))
        }),
      )
    }),
  )

  it.live("a timeout set before the server stopped still applies after it restarts", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      const started = yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          return yield* shell.create({ shell: "/bin/sh", command: "sleep 60", durable: true, timeout: 700 })
        }),
      )
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          expect((yield* shell.result(started)).info.status).toBe("timeout")
        }),
      )
      yield* until("process stopped", async () => !alive(started.pid))
    }),
  )

  it.live("a command that is not marked durable still ends with its server", () =>
    Effect.gen(function* () {
      const { boot } = yield* server()
      const started = yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          return yield* shell.create({ shell: "/bin/sh", command: "sleep 60" })
        }),
      )
      yield* until("foreground command stopped with its server", async () => !alive(started.pid))
    }),
  )

  it.live("shells of another directory are not adopted", () =>
    Effect.gen(function* () {
      const { boot, shells } = yield* server()
      const started = yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          return yield* shell.create({ shell: "/bin/sh", command: "sleep 30", durable: true })
        }),
      )
      const file = path.join(shells, "global", `${started.id}.json`)
      const record = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
      yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ ...record, directory: "/somewhere/else" })))
      yield* boot(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          expect(yield* shell.list()).toEqual([])
        }),
      )
      process.kill(-started.pid!, "SIGKILL")
    }),
  )
})
