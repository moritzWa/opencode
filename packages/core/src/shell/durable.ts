export * as ShellDurable from "./durable.js"

import path from "path"
import { Duration, Effect } from "effect"
import type { Shell } from "@opencode/schema/shell"

/**
 * Background shell commands that outlive the server that started them.
 *
 * The command runs as a detached process group whose stdout and stderr go straight to its output
 * file, so no pipe ties it to the server. A small wrapper writes its exit status next to the output
 * when the command ends. A record file beside them says who started it, so a later server can find
 * the command again, wait for it, and report its real result.
 *
 *   sh_x.json  who/what/where, the process id and its start time
 *   sh_x.out   combined output, written by the command itself
 *   sh_x.exit  the exit code, or `lost` when the process vanished without writing one
 */
export type Entry = {
  id: string
  command: string
  cwd: string
  shell: string
  file: string
  metadata: Shell.Metadata
  // The location directory that owns it. A server adopts only its own location's commands.
  directory: string
  pid: number
  // The process start time, so a recycled process id is never taken for the command.
  identity?: string
  started: number
  // Absolute time at which the command must be stopped, if it has a timeout.
  deadline?: number
}

export type Exit = { code: number; at: number } | { lost: true; at: number }

export type Outcome =
  | { _tag: "exited"; code: number; at: number }
  | { _tag: "lost"; at: number }
  // The record was deleted: the command was stopped on purpose.
  | { _tag: "removed" }

// Under the global data directory, one folder per project.
export const DIRECTORY = "shell"

const POLL = Duration.millis(200)
const GRACE_MS = 3_000
const LOST = "lost"
export const LOST_NOTE =
  "\n[opencode] The command's process disappeared without reporting an exit status (the machine may have restarted). Its output above may be incomplete.\n"

// Runs the command and records its exit status. The status file is renamed into place so a reader
// never sees half of it. `$1` is that file and the rest is the shell and its arguments.
//
// The wrapper outlives a signal sent to the whole group so it can still write the status: a signal
// that reaches only the wrapper is passed on to the command, and the status written is the command's.
// A handler, unlike an ignored signal, is not inherited by the command.
// `$1.ready` is created once the handlers are in place, so `spawn` can wait for it.
const WRAPPER = [
  'exit_file=$1; shift; "$@" & child=$!',
  "trap 'kill -TERM $child 2>/dev/null' TERM; trap 'kill -INT $child 2>/dev/null' INT; trap 'kill -HUP $child 2>/dev/null' HUP",
  ': > "$exit_file.ready"',
  "wait $child; code=$?",
  "while kill -0 $child 2>/dev/null; do wait $child; code=$?; done",
  'printf %s "$code" > "$exit_file.tmp" && mv "$exit_file.tmp" "$exit_file"',
].join("\n")

export const supported = process.platform !== "win32"

export const files = (file: string) => ({
  out: file,
  record: file.replace(/\.out$/, ".json"),
  exit: file.replace(/\.out$/, ".exit"),
})

export async function spawn(input: {
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  file: string
}) {
  const { spawn } = await import("node:child_process")
  const { open } = await import("node:fs/promises")
  const out = await open(input.file, "a")
  try {
    const env = Object.fromEntries(
      Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const child = spawn("/bin/sh", ["-c", WRAPPER, "sh", files(input.file).exit, input.shell, ...input.args], {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: ["ignore", out.fd, out.fd],
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", reject)
    })
    child.unref()
    await ready(files(input.file).exit + ".ready")
    return { pid: child.pid!, identity: await identity(child.pid!) }
  } finally {
    await out.close()
  }
}

// Until the wrapper can pass a signal on, one sent right after the start would kill it without a status.
async function ready(marker: string) {
  const { access, unlink } = await import("fs/promises")
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (
      await access(marker).then(
        () => true,
        () => false,
      )
    )
      return unlink(marker).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export async function identity(pid: number) {
  const { execFile } = await import("node:child_process")
  return new Promise<string | undefined>((resolve) =>
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 2_000, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
    ),
  )
}

/** Whether the process still exists and, when its start time is given, is still the same process. */
export async function alive(pid: number, expected?: string) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false
  }
  return expected === undefined ? true : (await identity(pid)) === expected
}

// Whether any process of the command's group remains.
const group = (pid: number) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(-pid, name)
    return
  } catch {}
  try {
    process.kill(pid, name)
  } catch {}
}

/** Stops the command's whole process group: a polite signal first, then a forced one. */
export const stop = (entry: Pick<Entry, "pid">) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => signal(entry.pid, "SIGTERM"))
    const deadline = Date.now() + GRACE_MS
    while (Date.now() < deadline) {
      if (!group(entry.pid)) return
      yield* Effect.sleep(Duration.millis(50))
    }
    yield* Effect.sync(() => signal(entry.pid, "SIGKILL"))
  })

export async function readExit(file: string): Promise<Exit | undefined> {
  const { readFile, stat } = await import("fs/promises")
  const target = files(file).exit
  const text = await readFile(target, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const at = await stat(target).then(
    (info) => info.mtimeMs,
    () => Date.now(),
  )
  if (text === LOST) return { lost: true, at }
  const code = Number.parseInt(text, 10)
  // A reader never sees a partial status, so anything else is not one.
  return Number.isNaN(code) ? undefined : { code, at }
}

/**
 * Records that the process vanished without a status and says so in the output. Only the first
 * caller writes, so two servers looking at the same command cannot both add the note.
 */
export async function markLost(file: string) {
  const { writeFile, appendFile } = await import("fs/promises")
  const first = await writeFile(files(file).exit, LOST, { flag: "wx" }).then(
    () => true,
    () => false,
  )
  if (first) await appendFile(file, LOST_NOTE).catch(() => {})
}

/** The signal a shell reports as `128 + n`, when `code` looks like one. */
export async function signalName(code: number) {
  if (code <= 128 || code > 128 + 64) return undefined
  const { constants } = await import("os")
  return Object.entries(constants.signals).find(([, value]) => value === code - 128)?.[0]
}

/**
 * Waits until the command ends, however that happens. The status file is the truth; a vanished
 * process with no status is `lost`. With `verify`, the process start time must still match first.
 */
export const wait = (entry: Entry, verify: boolean) =>
  Effect.gen(function* () {
    let first = verify
    for (;;) {
      // Checked first: a command stopped on purpose may write a status as it dies, but removal wins.
      const present = yield* Effect.promise(() => exists(files(entry.file).record))
      if (!present) return { _tag: "removed" } as const
      const exit = yield* Effect.promise(() => readExit(entry.file))
      if (exit) return outcome(exit)
      const running = yield* Effect.promise(() => alive(entry.pid, first ? entry.identity : undefined))
      first = false
      if (!running) {
        // The wrapper may have written its status between the two checks.
        const late = yield* Effect.promise(() => readExit(entry.file))
        return late ? outcome(late) : ({ _tag: "lost", at: Date.now() } as const)
      }
      yield* Effect.sleep(POLL)
    }
  })

const outcome = (exit: Exit): Outcome =>
  "lost" in exit ? { _tag: "lost", at: exit.at } : { _tag: "exited", code: exit.code, at: exit.at }

async function exists(file: string) {
  const { access } = await import("fs/promises")
  return access(file).then(
    () => true,
    () => false,
  )
}

export async function save(entry: Entry) {
  const { writeFile, rename } = await import("fs/promises")
  const target = files(entry.file).record
  await writeFile(`${target}.tmp`, JSON.stringify(entry))
  await rename(`${target}.tmp`, target)
}

/** Marks the command as stopped on purpose, before its process is stopped. */
export async function dropRecord(entry: Pick<Entry, "file">) {
  const { unlink } = await import("fs/promises")
  await unlink(files(entry.file).record).catch(() => {})
}

export async function drop(entry: Pick<Entry, "file">) {
  const { unlink } = await import("fs/promises")
  const target = files(entry.file)
  await Promise.all([target.record, target.exit, target.out].map((file) => unlink(file).catch(() => {})))
}

/** Every command recorded in one project's shell directory. */
export async function load(directory: string): Promise<Entry[]> {
  const { readdir, readFile } = await import("fs/promises")
  const names = await readdir(directory).catch(() => [])
  const entries = await Promise.all(
    names
      .filter((name) => /^sh_[0-9a-f]{12}.*\.json$/.test(name))
      .map((name) =>
        readFile(path.join(directory, name), "utf8").then(
          (text) => parse(text),
          () => undefined,
        ),
      ),
  )
  return entries.filter((entry): entry is Entry => entry !== undefined)
}

/** The record of a command, wherever in the shell root its project directory is. */
export async function find(root: string, id: string) {
  const { readdir } = await import("fs/promises")
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const found = (await load(path.join(root, project.name))).find((entry) => entry.id === id)
    if (found) return found
  }
  return undefined
}

/** IDs of commands whose process is still running, so retention never removes their files. */
export async function running(directory: string) {
  const entries = await load(directory)
  const ids = await Promise.all(
    entries.map(async (entry) =>
      (await readExit(entry.file)) ? undefined : (await alive(entry.pid)) ? entry.id : undefined,
    ),
  )
  return new Set(ids.filter((id): id is string => id !== undefined))
}

function parse(text: string): Entry | undefined {
  try {
    const value = JSON.parse(text)
    if (typeof value?.id !== "string" || typeof value.file !== "string" || typeof value.pid !== "number")
      return undefined
    return value as Entry
  } catch {
    return undefined
  }
}

/** The end of the output, bounded the way tool output is. */
export async function tail(file: string, limits: { maxLines: number; maxBytes: number }) {
  const { open } = await import("fs/promises")
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - limits.maxBytes)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString("utf8")
    const lines = text.split("\n")
    if (text.endsWith("\n")) lines.pop()
    const truncated = start > 0 || lines.length > limits.maxLines
    return {
      output: lines.length > limits.maxLines ? lines.slice(-limits.maxLines).join("\n") : text,
      truncated,
      size,
    }
  } finally {
    await handle.close()
  }
}

export async function countLines(file: string) {
  const { open } = await import("fs/promises")
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return 0
  try {
    const buffer = Buffer.alloc(64 * 1024)
    let lines = 0
    let last = 10
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length)
      if (bytesRead === 0) break
      for (let index = buffer.indexOf(10); index !== -1 && index < bytesRead; index = buffer.indexOf(10, index + 1))
        lines++
      last = buffer[bytesRead - 1]!
    }
    // A final line without a newline still counts.
    return last === 10 ? lines : lines + 1
  } finally {
    await handle.close()
  }
}
