import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { CodeRenderable } from "@opentui/core"
import { createSignal, Show } from "solid-js"
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

const KV_RATE = "speech_speed"
const DEFAULT_RATE = 1.7
const TICK_MS = 40
const STEP = 0.1
// Resuming a beat early makes the first word after a pause audible again.
const RESUME_REWIND = 0.4

type Segment = { partID: string; index: number; node: CodeRenderable }

type Status = "idle" | "loading" | "playing" | "paused"

type Reading = {
  sessionID: string
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
  const [rate, setRate] = createSignal(clampRate(api.kv.get(KV_RATE, DEFAULT_RATE)))
  const [status, setStatus] = createSignal<Status>("idle")
  const [sessionID, setSessionID] = createSignal<string>()

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

  async function open(answer: { sessionID: string; messageID: string; partIDs: string[] }) {
    stop()
    const segments = answer.partIDs.flatMap((partID) =>
      (blocks(partID) ?? []).map((node, index) => ({ partID, index, node })),
    )
    const script = build(segments.map((segment) => segment.node.content))
    if (!script.text) return api.ui.toast({ variant: "info", message: "Nothing to read in this answer" })
    setSessionID(answer.sessionID)
    setStatus("loading")
    const clip = await load(script.text).catch(fail)
    if (!clip) return setStatus("idle")
    current = {
      sessionID: answer.sessionID,
      messageID: answer.messageID,
      segments,
      script,
      clip,
      position: 0,
      word: -1,
    }
    await start(0)
  }

  async function start(from: number) {
    const reading = current
    if (!reading) return
    const playback = await play(reading.clip, Math.max(0, from), rate()).catch(fail)
    if (!playback || current !== reading) return playback?.stop()
    reading.playback = playback
    setStatus("playing")
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
    setStatus("paused")
  }

  function stop() {
    if (current) halt(current)
    current = undefined
    clear()
    setStatus("idle")
  }

  async function restart() {
    const answer = currentAnswer(api)
    if (!answer) return api.ui.toast({ variant: "info", message: "No answer to read yet" })
    await open(answer)
  }

  async function speed(delta: number) {
    setRate(clampRate(rate() + delta))
    api.kv.set(KV_RATE, rate())
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
        namespace: "palette",
        run() {
          void toggle()
          return true
        },
      },
      {
        name: command.stop,
        title: "Stop reading aloud",
        category: "Speech",
        namespace: "palette",
        run() {
          stop()
          return true
        },
      },
      {
        name: command.restart,
        title: "Read answer from the start",
        category: "Speech",
        namespace: "palette",
        run() {
          void restart()
          return true
        },
      },
      {
        name: command.faster,
        title: "Read aloud faster",
        category: "Speech",
        namespace: "palette",
        run() {
          void speed(STEP)
          return true
        },
      },
      {
        name: command.slower,
        title: "Read aloud slower",
        category: "Speech",
        namespace: "palette",
        run() {
          void speed(-STEP)
          return true
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("speech", Object.values(command)),
  })

  api.slots.register({
    order: 50,
    slots: {
      session_prompt_footer(_ctx, props) {
        // A bare Show here would make the slot host re-run on every status change.
        return (
          <box>
            <Show when={status() !== "idle" && sessionID() === props.session_id}>
              <Controls
                api={api}
                status={status()}
                rate={rate()}
                onToggle={() => void toggle()}
                onSpeed={(delta) => void speed(delta)}
                onStop={stop}
              />
            </Show>
          </box>
        )
      },
    },
  })

  api.lifecycle.onDispose(stop)
}

function Controls(props: {
  api: TuiPluginApi
  status: Status
  rate: number
  onToggle: () => void
  onSpeed: (delta: number) => void
  onStop: () => void
}) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme().accent} onMouseUp={props.onToggle}>
        {props.status === "playing" ? "‖ pause" : props.status === "loading" ? "… loading" : "▸ play"}
      </text>
      <text fg={theme().textMuted} onMouseUp={() => props.onSpeed(-STEP)}>
        −
      </text>
      <text fg={theme().text}>{props.rate.toFixed(2).replace(/0$/, "")}x</text>
      <text fg={theme().textMuted} onMouseUp={() => props.onSpeed(STEP)}>
        +
      </text>
      <text fg={theme().textMuted} onMouseUp={props.onStop}>
        ■
      </text>
    </box>
  )
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
  const sessionID = route.params.sessionID
  const answer = finalAnswer(api.state.session.messages(sessionID), api.state.part)
  return answer && { sessionID, ...answer }
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
  const rate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_RATE
  return Math.round(Math.min(3, Math.max(0.5, rate)) * 100) / 100
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
