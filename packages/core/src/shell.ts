export * as Shell from "./shell.js"

import path from "path"
import { Context, Deferred, Duration, Effect, Fiber, Latch, Layer, Schema, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { produce } from "immer"
import { Shell } from "@opencode/schema/shell"
import { AppProcess } from "@opencode/util/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "./bus.js"
import { Environment } from "./environment/index.js"
import { FileRetention } from "./file-retention.js"
import { FileAccess } from "./file-access.js"
import { Location } from "./location.js"
import { Global } from "@opencode/util/global"
import { ShellSelect } from "./shell/select.js"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionEnvironment } from "./session/environment.js"
import { SessionSchema } from "./session/schema.js"
import { Config } from "./config.js"
import { ToolOutput } from "./tool-output.js"
import { ShellResult } from "./shell/result.js"
import { ShellDurable } from "./shell/durable.js"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Shell.NotFoundError", {
  id: Shell.ID,
}) {}

// Keep recent exited processes observable in memory, including their file-backed output.
// The process-local cap complements the time-based sweep, which also cleans files left by restarts.
const EXITED_LIMIT = 25
export const RETENTION = Duration.days(7)
export const DIRECTORY = ShellDurable.DIRECTORY

type Info = Shell.Info
type CreateInput = Shell.CreateInput & {
  shell?: string
  // Keep the command running when the server stops, and find it again when one starts. Local POSIX only.
  durable?: boolean
}

type Active = {
  // Immutable snapshot; lifecycle updates replace it via immer `produce`.
  info: Info
  file: string
  size: number
  newlines: number
  // Set for commands that outlive the server; their output is written by the command itself.
  durable?: ShellDurable.Entry
  monitor?: Fiber.Fiber<void>
  // Resolves with the terminal Info once the command exits, times out, or is killed. A wait
  // started after termination resolves immediately from the already-completed deferred.
  done: Deferred.Deferred<Info, NotFoundError>
  timeoutFiber?: Fiber.Fiber<void>
  timeout?: (duration: number) => Effect.Effect<void>
}

/**
 * Location-owned non-interactive shell command process service.
 *
 * Each `create` spawns one shell command, captures combined stdout/stderr to a
 * file, and returns an ID. Clients poll `get` for status and `output` for
 * file-backed output by cursor. No session, message, or permission state lives
 * here; callers (e.g. `ShellTool`) own that association and store the shell ID.
 */
export interface Interface {
  readonly create: <E = never, R = never>(
    input: CreateInput,
    before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<Shell.Info, E | AppProcess.AppProcessError, R>
  // Currently running commands only; exited shells are retained for get/output but excluded here.
  readonly list: () => Effect.Effect<Shell.Info[]>
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with
  // NotFoundError if the command is unknown or is removed before it terminates.
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // A known shell's terminal state and bounded tail. Missing capture remains distinct from its exit status.
  readonly result: (started: Shell.Info) => Effect.Effect<ShellResult.Result>
  // Replaces the running command's timeout from now; zero clears it.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Shell") {}

export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = path.join(global.data, DIRECTORY)
  const projects = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "directory")),
    Effect.orElseSucceed(() => []),
  )
  const files = yield* Effect.forEach(
    projects,
    (project) =>
      Effect.gen(function* () {
        const live = yield* Effect.promise(() => ShellDurable.running(path.join(directory, project.name)))
        return yield* fs.readDirectoryEntries(path.join(directory, project.name)).pipe(
          Effect.map((entries) =>
            entries.flatMap((entry) => {
              const match = /^(sh_[0-9a-f]{12}.*)\.(out|json|exit)$/.exec(entry.name)
              // A command that is still running keeps its files however quiet it has been.
              return entry.type === "file" && match && !live.has(match[1]!)
                ? [path.join(directory, project.name, entry.name)]
                : []
            }),
          ),
          Effect.orElseSucceed(() => []),
        )
      }),
    { concurrency: 8 },
  )
  yield* FileRetention.cleanup(fs, files.flat(), RETENTION)
})

const cleanupLayer = Layer.effectDiscard(
  cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped),
)

const cleanupNode = makeGlobalNode({
  name: "shell-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const shell = yield* ShellSelect.Service
      const environment = yield* Environment.Service
      const hooks = yield* PluginHooks.Service
      const environments = yield* SessionEnvironment.Service
      const config = yield* Config.Service
      const context = yield* Effect.context()
      const runFork = Effect.runForkWith(context)
      const commands = new Map<Shell.ID, Active>()
      const exitOrder: Shell.ID[] = []

      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      const { mkdir, unlink } = yield* Effect.promise(() => import("fs/promises"))
      const { createWriteStream, createReadStream } = yield* Effect.promise(() => import("fs"))
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const command of commands.values()) {
            if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
            // A durable command is left running for the next server to find; only the watching stops.
            if (command.monitor) yield* Fiber.interrupt(command.monitor)
            // Teardown interrupts pending commands; it is not a terminal command failure.
            yield* Deferred.interrupt(command.done)
          }
          commands.clear()
          exitOrder.length = 0
        }),
      )

      const require = Effect.fnUntraced(function* (id: Shell.ID) {
        const command = commands.get(id)
        if (!command) return yield* new NotFoundError({ id })
        return command
      })

      const removeCommand = Effect.fnUntraced(function* (id: Shell.ID) {
        const command = commands.get(id)
        const index = exitOrder.indexOf(id)
        if (index !== -1) exitOrder.splice(index, 1)
        if (!command) return
        commands.delete(id)
        if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
        // Removing a durable command is the one thing besides its own end that stops it.
        if (command.durable) {
          if (command.monitor) yield* Fiber.interrupt(command.monitor)
          // Stop it before deleting its files: the wrapper writes its status as it goes.
          if (command.info.status === "running") yield* ShellDurable.stop(command.durable)
          yield* Effect.promise(() => ShellDurable.drop(command.durable!))
        }
        // Unblock any wait still pending when the command is removed before it terminated.
        yield* Deferred.fail(command.done, new NotFoundError({ id }))
        yield* Effect.promise(() => unlink(command.file).catch(() => {}))
        yield* bus.publish(Shell.Event.Deleted, { id })
      })

      // Reads the size a durable command's output has reached; the command, not this server, writes it.
      const refresh = Effect.fnUntraced(function* (command: Active) {
        if (!command.durable) return
        const { stat } = yield* Effect.promise(() => import("fs/promises"))
        const info = yield* Effect.promise(() => stat(command.file).catch(() => undefined))
        if (info) command.size = info.size
      })

      // Moves a command to its terminal state once, whichever of its end paths gets there first.
      const complete = (
        command: Active,
        outputDone: Latch.Latch | undefined,
        status: Info["status"],
        exit?: number,
        beforeWait: Effect.Effect<void> = Effect.void,
        signal?: string,
        completed = Date.now(),
      ) =>
        Effect.gen(function* () {
          if (command.info.status !== "running") return
          command.info = produce(command.info, (draft) => {
            draft.status = status
            if (exit !== undefined) draft.exit = exit
            if (signal !== undefined) draft.signal = signal
            draft.time.completed = completed
          })
          yield* beforeWait
          if (outputDone) yield* outputDone.await
          // Resolve waiters with the terminal Info before any retention eviction, so an evicted
          // command still reports success rather than the removal NotFoundError. This runs before
          // the timeout-fiber interrupt below, which on the timeout path would otherwise cancel
          // this very fiber (finish is invoked by the timeout fiber) before waiters are resolved.
          yield* Deferred.succeed(command.done, command.info)
          yield* bus.publish(Shell.Event.Exited, {
            id: command.info.id,
            ...(exit !== undefined ? { exit } : {}),
            status,
          })
          exitOrder.push(command.info.id)
          while (exitOrder.length > EXITED_LIMIT) {
            const oldest = exitOrder[0]
            if (!oldest) break
            yield* removeCommand(oldest)
          }
          // Keep exited history data-only. Interrupt last because finish may run on the timeout fiber.
          const timeoutFiber = command.timeoutFiber
          command.timeout = undefined
          command.timeoutFiber = undefined
          if (timeoutFiber) yield* Fiber.interrupt(timeoutFiber)
        })

      const durable = ShellDurable.supported && location.workspaceID === undefined

      const schedule = (command: Active, entry: ShellDurable.Entry, ms: number) =>
        Effect.gen(function* () {
          if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
          command.timeoutFiber = undefined
          if (ms <= 0 || command.info.status !== "running") return
          command.timeoutFiber = runFork(
            Effect.sleep(Duration.millis(ms)).pipe(
              Effect.flatMap(() => complete(command, undefined, "timeout", undefined, ShellDurable.stop(entry))),
            ),
          )
        })

      // Follows a durable command to its end, whether this server started it or found it running.
      const watch = (command: Active, entry: ShellDurable.Entry, verify: boolean) =>
        ShellDurable.wait(entry, verify).pipe(
          Effect.flatMap((outcome) =>
            Effect.gen(function* () {
              // Removed or timed out here: that path already settled the command and ended the process.
              if (outcome._tag === "removed" || command.info.status !== "running") return
              if (outcome._tag === "lost") {
                yield* Effect.promise(() => ShellDurable.markLost(entry.file))
                return yield* complete(command, undefined, "killed", undefined, Effect.void, undefined, outcome.at)
              }
              const signal = yield* Effect.promise(() => ShellDurable.signalName(outcome.code))
              return signal === undefined
                ? yield* complete(command, undefined, "exited", outcome.code, Effect.void, undefined, outcome.at)
                : yield* complete(command, undefined, "exited", undefined, Effect.void, signal, outcome.at)
            }),
          ),
        )

      const track = Effect.fnUntraced(function* (info: Info, entry: ShellDurable.Entry, adopted: boolean) {
        const command: Active = {
          info,
          file: entry.file,
          size: 0,
          newlines: 0,
          done: Deferred.makeUnsafe<Info, NotFoundError>(),
          durable: entry,
        }
        commands.set(info.id, command)
        command.timeout = (duration) =>
          Effect.gen(function* () {
            if (command.info.status !== "running") return
            if (duration === 0) delete entry.deadline
            else entry.deadline = Date.now() + duration
            // Saved so a server that takes over still enforces it.
            yield* Effect.promise(() => ShellDurable.save(entry))
            yield* schedule(command, entry, duration)
          })
        // A command found already over is settled before anyone can read it as still running.
        const over =
          adopted &&
          ((yield* Effect.promise(() => ShellDurable.readExit(entry.file))) !== undefined ||
            !(yield* Effect.promise(() => ShellDurable.alive(entry.pid, entry.identity))))
        if (over) {
          yield* watch(command, entry, true)
          return command
        }
        command.monitor = runFork(watch(command, entry, false))
        if (entry.deadline !== undefined) yield* schedule(command, entry, Math.max(1, entry.deadline - Date.now()))
        return command
      })

      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        yield* require(id)
        yield* removeCommand(id)
      })

      const list = Effect.fn("Shell.list")(function* () {
        return Array.from(commands.values())
          .filter((command) => command.info.status === "running")
          .map((command) => command.info)
      })

      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        return (yield* require(id)).info
      })

      const wait = Effect.fn("Shell.wait")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).done)
      })

      const timeout = Effect.fn("Shell.timeout")(function* (id: Shell.ID, duration: number) {
        const command = yield* require(id)
        if (command.info.status !== "running" || !command.timeout) return command.info
        yield* command.timeout(duration)
        return command.info
      })

      const output = Effect.fnUntraced(function* (id: Shell.ID, input?: Shell.OutputInput) {
        const command = yield* require(id)
        yield* refresh(command)
        const cursor = input?.cursor ?? 0
        const limit = input?.limit ?? 65536
        if (cursor >= command.size) return { output: "", cursor: command.size, size: command.size, truncated: false }
        const start = Math.max(0, cursor)
        const length = Math.min(limit, command.size - start)
        const buffer = Buffer.alloc(length)
        const bytesRead = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const stream = createReadStream(command.file, { start, end: start + length - 1 })
              let offset = 0
              stream.on("data", (chunk: string | Buffer) => {
                const bytes = Buffer.from(chunk)
                bytes.copy(buffer, offset)
                offset += bytes.length
              })
              stream.on("end", () => resolve(offset))
              stream.on("error", () => resolve(0))
            }),
        )
        return {
          output: buffer.subarray(0, bytesRead).toString("utf8"),
          cursor: start + bytesRead,
          size: command.size,
          truncated: false,
        }
      })

      const result = Effect.fn("Shell.result")(function* (started: Shell.Info) {
        const info = yield* wait(started.id).pipe(
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({ ...started, status: "killed" as const, time: { ...started.time, completed: Date.now() } }),
          ),
        )
        const capture = yield* Effect.gen(function* () {
          const limits = Config.latest(yield* config.entries(), "tool_output")
          const maxLines = limits?.max_lines ?? ToolOutput.MAX_LINES
          const maxBytes = limits?.max_bytes ?? ToolOutput.MAX_BYTES
          const latest = yield* output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
          const page = yield* output(info.id, { cursor: Math.max(0, latest.size - maxBytes), limit: maxBytes })
          const lines = page.output.split("\n")
          if (page.output.endsWith("\n")) lines.pop()
          const truncated = latest.size > maxBytes || lines.length > maxLines
          const text = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : page.output
          const command = yield* require(info.id)
          const total = command.durable
            ? truncated
              ? yield* Effect.promise(() => ShellDurable.countLines(command.file))
              : 0
            : command.newlines + (page.output.endsWith("\n") ? 0 : 1)
          const shown = Math.min(lines.length, maxLines)
          const notice = truncated
            ? `\n\n[showing lines ${total - shown + 1}-${total} of ${total}; full output saved to ${info.file}]`
            : ""
          return { output: `${text || "(no output)"}${notice}`, truncated }
        }).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(undefined)))
        return { info, capture }
      })

      const create = Effect.fn("Shell.create")(function* <E = never, R = never>(
        input: CreateInput,
        before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
      ) {
        const sessionID = input.metadata?.sessionID
        const baseEnv =
          location.workspaceID !== undefined
            ? undefined
            : ((Schema.is(SessionSchema.ID)(sessionID) ? yield* environments.get(sessionID) : undefined) ?? process.env)
        const invocation: ShellCreateBefore = {
          ...(Schema.is(SessionSchema.ID)(sessionID) ? { sessionID } : {}),
          command: input.command,
          cwd: FileAccess.resolvePath(location.directory, input.cwd ?? "."),
          timeout: input.timeout ?? 0,
          shell: input.shell ?? (yield* shell.resolve({ priority: "config" })),
          env: {
            ...baseEnv,
            TERM: "xterm-256color",
            OPENCODE_TERMINAL: "1",
          },
        }
        yield* hooks.trigger("shell", "create.before", invocation)
        if (before) yield* before(invocation)

        const id = Shell.ID.ascending()
        const args = ShellSelect.args(invocation.shell, invocation.command)
        const file = path.join(outputDir, `${id}.out`)

        const info: Info = {
          id,
          status: "running",
          command: invocation.command,
          cwd: invocation.cwd,
          shell: invocation.shell,
          file,
          metadata: input.metadata ?? {},
          time: { started: Date.now() },
        }

        if (input.durable === true && durable) {
          const spawned = yield* Effect.tryPromise({
            try: () =>
              ShellDurable.spawn({ shell: invocation.shell, args, cwd: invocation.cwd, env: invocation.env, file }),
            catch: (cause) => new AppProcess.AppProcessError({ command: invocation.command, cause }),
          })
          const entry: ShellDurable.Entry = {
            id,
            command: invocation.command,
            cwd: invocation.cwd,
            shell: invocation.shell,
            file,
            metadata: info.metadata,
            directory: location.directory,
            pid: spawned.pid,
            ...(spawned.identity !== undefined ? { identity: spawned.identity } : {}),
            started: info.time.started,
            ...(invocation.timeout > 0 ? { deadline: info.time.started + invocation.timeout } : {}),
          }
          yield* Effect.promise(() => ShellDurable.save(entry))
          const command = yield* track({ ...info, pid: spawned.pid }, entry, false)
          yield* bus.publish(Shell.Event.Created, { info: command.info })
          return command.info
        }

        // Spawn through the Environment and stream combined output to the file. The handle is scope-bound, so
        // the managing fiber keeps its scope open until the command terminates (it awaits `done` at the
        // end). `create` returns once `ready` resolves with the registered command.
        const ready = Deferred.makeUnsafe<Active, AppProcess.AppProcessError>()
        runFork(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* environment.spawner
                .spawn(
                  ChildProcess.make(invocation.shell, args, {
                    cwd: invocation.cwd,
                    env: invocation.env,
                    stdin: "ignore",
                    detached: process.platform !== "win32",
                    forceKillAfter: Duration.seconds(3),
                  }),
                )
                .pipe(
                  Effect.mapError((cause) => new AppProcess.AppProcessError({ command: invocation.command, cause })),
                )
              const command: Active = {
                info: produce(info, (draft) => {
                  draft.pid = handle.pid
                }),
                file,
                size: 0,
                newlines: 0,
                done: Deferred.makeUnsafe<Info, NotFoundError>(),
              }
              commands.set(id, command)

              const stream = createWriteStream(file)
              const outputDone = Latch.makeUnsafe()
              const pump = handle.all.pipe(
                Stream.runForEach((chunk: Uint8Array) =>
                  Effect.sync(() => {
                    stream.write(chunk)
                    command.size += chunk.length
                    // Count while streaming so truncation notices never rescan the output file.
                    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1))
                      command.newlines++
                  }),
                ),
              )
              runFork(
                Effect.gen(function* () {
                  yield* pump.pipe(Effect.catch(() => Effect.void))
                  yield* Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        stream.end(() => resolve())
                      }),
                  )
                  yield* outputDone.open
                }),
              )
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    stream.once("open", () => resolve())
                    stream.once("error", () => resolve())
                  }),
              )

              const finish = (status: Info["status"], exit?: number, beforeWait = Effect.void, signal?: string) =>
                complete(command, outputDone, status, exit, beforeWait, signal)

              command.timeout = (duration) =>
                Effect.gen(function* () {
                  if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
                  command.timeoutFiber = undefined
                  if (duration === 0 || command.info.status !== "running") return
                  command.timeoutFiber = runFork(
                    Effect.sleep(Duration.millis(duration)).pipe(
                      Effect.flatMap(() =>
                        finish(
                          "timeout",
                          undefined,
                          handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.catch(() => Effect.void)),
                        ),
                      ),
                    ),
                  )
                })

              yield* command.timeout(invocation.timeout)

              runFork(
                handle.exitCode.pipe(
                  Effect.flatMap((code) => finish("exited", code)),
                  Effect.catch((error) =>
                    finish(
                      "exited",
                      undefined,
                      Effect.void,
                      error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
                    ),
                  ),
                ),
              )

              yield* bus.publish(Shell.Event.Created, { info })
              yield* Deferred.succeed(ready, command)
              // Hold the handle's scope open until the command terminates; closing it earlier would
              // release (kill) the process before its exit is observed.
              yield* Deferred.await(command.done).pipe(Effect.catch(() => Effect.void))
            }),
          ).pipe(Effect.catchTag("AppProcessError", (error) => Deferred.fail(ready, error))),
        )

        const command = yield* Deferred.await(ready)
        return command.info
      })

      // Commands an earlier server left running are this server's again; ones that ended meanwhile
      // keep their real result. Only this location's own commands are adopted.
      if (durable) {
        const recorded = yield* Effect.promise(() => ShellDurable.load(outputDir))
        const mine = recorded
          .filter((entry) => entry.directory === location.directory)
          .sort((a, b) => a.started - b.started)
        const ended = new Set<string>()
        for (const entry of mine)
          if (yield* Effect.promise(() => ShellDurable.readExit(entry.file))) ended.add(entry.id)
        const keep = new Set(
          mine
            .filter((entry) => ended.has(entry.id))
            .slice(-EXITED_LIMIT)
            .map((entry) => entry.id),
        )
        for (const entry of mine) {
          if (ended.has(entry.id) && !keep.has(entry.id)) continue
          const command = yield* track(
            {
              id: Shell.ID.ascending(entry.id),
              status: "running",
              command: entry.command,
              cwd: entry.cwd,
              shell: entry.shell,
              file: entry.file,
              pid: entry.pid,
              metadata: entry.metadata,
              time: { started: entry.started },
            },
            entry,
            true,
          )
          if (!ended.has(entry.id)) yield* bus.publish(Shell.Event.Created, { info: command.info })
        }
      }

      return Service.of({ create, list, get, wait, result, timeout, output, remove })
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [
    Bus.node,
    Location.node,
    Global.node,
    ShellSelect.node,
    Environment.node,
    PluginHooks.node,
    SessionEnvironment.node,
    Config.node,
    cleanupNode,
  ],
})
