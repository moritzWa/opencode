export * as SpeechView from "./view"

import { CodeRenderable, type MarkdownRenderable, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"

export type Range = { start: number; end: number }

// Tables are skipped by request. Code, html and rules have nothing to say.
const SKIP = new Set(["code", "table", "hr", "html", "space", "def"])

const views = new Map<string, MarkdownRenderable>()
const [reading, setReading] = createSignal<Renderable>()
let lit: { node: CodeRenderable; base: CodeRenderable["onHighlight"] } | undefined

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

function prose(node: Renderable): CodeRenderable[] {
  if (node instanceof CodeRenderable) return node.filetype === "markdown" ? [node] : []
  return node.getChildren().flatMap((child) => prose(child as Renderable))
}
