import { appendFileSync } from "fs"

// Timing records for finding slow session switches, appended as JSON lines to the file named by
// OPENCODE_TUI_PERF_LOG. Without it nothing is recorded.
const file = process.env.OPENCODE_TUI_PERF_LOG

export function perf(event: string, fields: Record<string, unknown> = {}) {
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ t: Date.now(), event, pid: process.pid, ...fields }) + "\n")
  } catch {}
}

export async function timed<T>(timings: Record<string, number>, name: string, task: Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await task
  } finally {
    timings[name] = Math.round(performance.now() - started)
  }
}

/** Record every stretch the event loop was blocked for at least `threshold` ms. */
export function watchEventLoop(threshold = 50) {
  if (!file) return
  const interval = 20
  let expected = performance.now() + interval
  setInterval(() => {
    const now = performance.now()
    const lag = now - expected
    if (lag >= threshold) perf("tui.event_loop_blocked", { ms: Math.round(lag) })
    expected = now + interval
  }, interval).unref?.()
}
