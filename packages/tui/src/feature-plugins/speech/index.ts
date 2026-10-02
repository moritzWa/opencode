import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { CodeRenderable } from "@opentui/core"
import type { BuiltinTuiPlugin } from "../builtins"
import { build, source, wordAt, type Script } from "./script"
import { load, play, type Clip, type Playback } from "./player"
import { blocks, clear, show } from "./view"

const id = "internal:speech"

const command = {
  toggle: "speech.toggle",
  stop: "speech.stop",
  restart: "speech.restart",
  faster: "speech.faster",
  slower: "speech.slower",
} as const

const KV_RATE = "speech_rate"
const TICK_MS = 40
// Resuming a beat early makes the first word after a pause audible again.
const RESUME_REWIND = 0.4

type Segment = { partID: string; index: number; node: CodeRenderable }

type Reading = {
  messageID: string
  segments: Segment[]
  script: Script
  clip: Clip
  position: number
  word: number
  playback?: Playback
  timer?: ReturnType<typeof setInterval>
}

const tui: TuiPlugin = async (api) => {
  let current: Reading | undefined
  let rate = clampRate(api.kv.get(KV_RATE, 1))

  const fail = (error: unknown) =>
    api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : String(error) })

  // A second press while the first one is still waiting on ElevenLabs or ffmpeg
  // would otherwise start a second playback on top of it.
  let busy = false
  async function toggle() {
    if (busy) return
    busy = true
    await step().finally(() => (busy = false))
  }

  async function step() {
    if (current?.playback) return pause()
    const answer = currentAnswer(api)
    if (current && (!answer || current.messageID === answer.messageID)) return start(current.position - RESUME_REWIND)
    if (!answer) return api.ui.toast({ variant: "info", message: "No answer to read yet" })
    await open(answer)
  }

  async function open(answer: { messageID: string; partIDs: string[] }) {
    stop()
    const segments = answer.partIDs.flatMap((partID) =>
      (blocks(partID) ?? []).map((node, index) => ({ partID, index, node })),
    )
    const script = build(segments.map((segment) => segment.node.content))
    if (!script.text) return api.ui.toast({ variant: "info", message: "Nothing to read in this answer" })
    const clip = await load(script.text).catch(fail)
    if (!clip) return
    current = { messageID: answer.messageID, segments, script, clip, position: 0, word: -1 }
    await start(0)
  }

  async function start(from: number) {
    const reading = current
    if (!reading) return
    const playback = await play(reading.clip, Math.max(0, from), rate).catch(fail)
    if (!playback || current !== reading) return playback?.stop()
    reading.playback = playback
    reading.timer = setInterval(() => tick(reading), TICK_MS)
    void playback.ended.then(() => {
      if (reading.playback !== playback) return
      if (reading.clip.error) fail(reading.clip.error)
      stop()
    })
  }

  function pause() {
    const reading = current
    if (!reading?.playback) return
    reading.position = reading.playback.position()
    halt(reading)
  }

  function stop() {
    if (current) halt(current)
    current = undefined
    clear()
  }

  async function restart() {
    const answer = currentAnswer(api)
    if (!answer) return api.ui.toast({ variant: "info", message: "No answer to read yet" })
    await open(answer)
  }

  async function speed(delta: number) {
    rate = clampRate(rate + delta)
    api.kv.set(KV_RATE, rate)
    api.ui.toast({ variant: "info", message: `Reading speed ${rate}x`, duration: 1200 })
    const reading = current
    if (!reading?.playback) return
    reading.position = reading.playback.position()
    halt(reading)
    await start(reading.position)
  }

  function tick(reading: Reading) {
    if (!reading.playback) return
    const index = wordAt(reading.script, reading.clip.starts, reading.playback.position())
    if (index < 0 || index === reading.word) return
    reading.word = index
    const word = reading.script.words[index]
    const sentence =
      reading.script.sentences.find((range) => range.start <= word.start && word.end <= range.end) ?? word
    const target = source(reading.script, word)
    const node = resolve(reading.segments[target.segment])
    if (!node) return
    show(node, source(reading.script, sentence), target)
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: command.toggle,
        title: "Read answer aloud / pause",
        category: "Speech",
        run() {
          void toggle()
          return true
        },
      },
      {
        name: command.stop,
        title: "Stop reading aloud",
        category: "Speech",
        run() {
          stop()
          return true
        },
      },
      {
        name: command.restart,
        title: "Read answer from the start",
        category: "Speech",
        run() {
          void restart()
          return true
        },
      },
      {
        name: command.faster,
        title: "Read aloud faster",
        category: "Speech",
        run() {
          void speed(0.25)
          return true
        },
      },
      {
        name: command.slower,
        title: "Read aloud slower",
        category: "Speech",
        run() {
          void speed(-0.25)
          return true
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("speech", Object.values(command)),
  })

  api.lifecycle.onDispose(stop)
}

/**
 * The text a reader would call the answer: the last assistant message with text,
 * and only the text after its last tool call, so "let me check the router" style
 * progress lines from earlier steps are not read.
 */
export function finalAnswer(messages: readonly Message[], parts: (messageID: string) => readonly Part[]) {
  return messages
    .toReversed()
    .filter((message) => message.role === "assistant")
    .map((message) => {
      const all = parts(message.id)
      const tail = all.slice(all.findLastIndex((part) => part.type === "tool") + 1)
      return { messageID: message.id, partIDs: tail.filter(isAnswerText).map((part) => part.id) }
    })
    .find((answer) => answer.partIDs.length > 0)
}

function currentAnswer(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session" || !route.params || typeof route.params.sessionID !== "string") return
  return finalAnswer(api.state.session.messages(route.params.sessionID), api.state.part)
}

function isAnswerText(part: Part): part is TextPart {
  return part.type === "text" && !part.synthetic && part.text.trim().length > 0
}

/** Markdown may rebuild its blocks (a theme change does); look the node up again when it has. */
function resolve(segment: Segment | undefined) {
  if (!segment) return
  if (!segment.node.isDestroyed) return segment.node
  const node = blocks(segment.partID)?.[segment.index]
  if (node) segment.node = node
  return node
}

function halt(reading: Reading) {
  clearInterval(reading.timer)
  reading.timer = undefined
  const playback = reading.playback
  reading.playback = undefined
  playback?.stop()
}

function clampRate(value: unknown) {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : 1
  return Math.round(Math.min(3, Math.max(0.5, rate)) * 100) / 100
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
