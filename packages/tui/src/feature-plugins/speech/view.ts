export * as SpeechView from "./view"

import { CodeRenderable, type MarkdownRenderable, type MouseEvent, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"

export type Range = { start: number; end: number }
export type Spot = { partID: string; messageID: string; node: CodeRenderable; offset: number }

// Tables are skipped by request. Code, html and rules have nothing to say.
const SKIP = new Set(["code", "table", "hr", "html", "space", "def"])

const views = new Map<string, MarkdownRenderable>()
const [reading, setReading] = createSignal<Renderable>()
let lit: { node: CodeRenderable; base: CodeRenderable["onHighlight"] } | undefined
let picked: ((pick: Spot) => void) | undefined

/** The block renderable currently being read, for the transcript to keep in view. */
export { reading }

export function register(partID: string, view: MarkdownRenderable) {
  views.set(partID, view)
}

export function unregister(partID: string, view: MarkdownRenderable) {
  if (views.get(partID) === view) views.delete(partID)
}

/**
 * The prose blocks of a rendered text part in reading order. Markdown renders each
 * paragraph, heading, and list item as a markdown-filetype CodeRenderable whose
 * content is that block's raw markdown; fenced code renders with its own filetype.
 */
export function blocks(partID: string) {
  const view = views.get(partID)
  if (!view || view.isDestroyed) return
  return view._blockStates.flatMap((block) => (SKIP.has(block.token.type) ? [] : prose(block.renderable)))
}

export function show(node: CodeRenderable, sentence: Range, word: Range) {
  if (lit?.node !== node) {
    clear()
    lit = { node, base: node.onHighlight }
  }
  const base = lit.base
  node.onHighlight = async (highlights, context) => [
    ...((await base?.(highlights, context)) ?? highlights),
    [sentence.start, sentence.end, "speech.sentence"],
    [word.start, word.end, "speech.word"],
  ]
  node.requestRender()
  setReading(node)
}

export function clear() {
  if (lit && !lit.node.isDestroyed) {
    lit.node.onHighlight = lit.base
    lit.node.requestRender()
  }
  lit = undefined
  setReading(undefined)
}

export function onPick(handler: (pick: Spot) => void) {
  picked = handler
  return () => {
    if (picked === handler) picked = undefined
  }
}

/** Option+click on a prose word reports where in the block's raw markdown it landed. */
export function click(partID: string, messageID: string, event: MouseEvent) {
  if (!event.modifiers.alt || !picked) return
  const node = blocks(partID)?.find((node) => node === event.target)
  if (!node) return
  const offset = offsetAt(node, event.x, event.y)
  if (offset === undefined) return
  event.stopPropagation()
  picked({ partID, messageID, node, offset })
}

/**
 * Screen cell to raw-markdown offset. The rendered text is the raw markdown with
 * concealed markers removed, plus a space before a shown link URL, so walking
 * both in step and skipping whatever does not match lines them up.
 */
export function offsetAt(node: CodeRenderable, x: number, y: number) {
  const info = node.lineInfo
  const line = y - node.y
  if (line < 0 || line >= info.lineStartCols.length) return
  const column = info.lineStartCols[line] + Math.max(0, Math.min(x - node.x, info.lineWidthCols[line] - 1))
  const plain = node.plainText
  let index = 0
  let width = 0
  for (const char of plain) {
    width += char === "\n" ? 1 : Bun.stringWidth(char)
    if (width > column) break
    index += char.length
  }
  const raw = node.content
  let at = 0
  for (let i = 0; i < index && at < raw.length; ) {
    if (raw[at] === plain[i]) {
      at++
      i++
    } else if (/\s/.test(plain[i])) i++
    else at++
  }
  return at
}

function prose(node: Renderable): CodeRenderable[] {
  if (node instanceof CodeRenderable) return node.filetype === "markdown" ? [node] : []
  return node.getChildren().flatMap((child) => prose(child as Renderable))
}
