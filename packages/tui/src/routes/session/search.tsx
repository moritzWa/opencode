import {
  TextBufferRenderable,
  TextTableRenderable,
  resolveRenderLib,
  type Renderable,
  type TextBuffer,
  type LineInfo,
  type ScrollBoxRenderable,
  type WidthMethod,
  type RGBA,
  type SyntaxStyle,
} from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { Keymap } from "../../context/keymap"

export const searchable = new WeakSet<Renderable>()
const MATCH_REF = 0x5e01
const CURRENT_REF = 0x5e02

type SearchTarget = {
  text: string
  read: () => string
  buffer: TextBuffer
  top: () => number
  lines: () => LineInfo
  alive: () => boolean
  redraw: () => void
}

export type SearchMatch = {
  target: SearchTarget
  start: number
  end: number
  column: number
  line: number
}
type SearchStyle = { match: { fg: RGBA; bg: RGBA }; current: { fg: RGBA; bg: RGBA } }

export function findMatches(root: Renderable, query: string, widthMethod: WidthMethod): SearchMatch[] {
  if (!query) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), /\p{Lu}/u.test(query) ? "gu" : "giu")
  return collectTargets(root, false).flatMap((target) => {
    const hits = [...target.text.matchAll(pattern)]
    if (!hits.length) return []
    const columns = measureColumns(target.text, widthMethod)
    return hits.map((hit) => ({
      target,
      start: columns.highlight[hit.index],
      end: columns.highlight[hit.index + hit[0].length],
      column: columns.line[hit.index],
      line: columns.line[hit.index] - columns.highlight[hit.index],
    }))
  })
}

export function matchRow(match: SearchMatch) {
  const line = match.target.lines().lineStartCols.findLastIndex((start) => start <= match.column)
  return match.target.top() + Math.max(line, 0)
}

export function clearHighlights(matches: SearchMatch[]) {
  new Set(matches.map((match) => match.target)).forEach((target) => {
    if (!target.alive()) return
    target.buffer.removeHighlightsByRef(MATCH_REF)
    target.buffer.removeHighlightsByRef(CURRENT_REF)
    target.redraw()
  })
}

export function highlightMatches(matches: SearchMatch[], current: number, style: SearchStyle) {
  matches.forEach((match, index) => {
    if (!match.target.alive()) return
    const syntax = match.target.buffer.getSyntaxStyle()
    if (!syntax) return
    const ids = styleIds(syntax, style)
    match.target.buffer.addHighlightByCharRange({
      start: match.start,
      end: match.end,
      styleId: ids.match,
      priority: 200,
      hlRef: MATCH_REF,
    })
    if (index === current)
      match.target.buffer.addHighlightByCharRange({
        start: match.start,
        end: match.end,
        styleId: ids.current,
        priority: 210,
        hlRef: CURRENT_REF,
      })
    match.target.redraw()
  })
}

export function createSessionSearch(input: {
  scroll: () => ScrollBoxRenderable | undefined
  content: () => unknown
  prepare?: () => Promise<unknown>
}) {
  const renderer = useRenderer()
  const theme = useTheme()
  const [active, setActive] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [matches, setMatches] = createSignal<SearchMatch[]>([])
  const [current, setCurrent] = createSignal(-1)
  const style = createMemo(() => ({
    match: { fg: theme.text.formfield.selected, bg: theme.background.formfield.selected },
    current: { fg: theme.text.formfield.focused, bg: theme.background.formfield.focused },
  }))

  function rescan(viewport = false) {
    const scroll = input.scroll()
    if (!scroll || scroll.isDestroyed) return
    const previous = matches()[current()]
    const row = !viewport && previous?.target.alive() ? matchRow(previous) : scroll.viewport.y
    clearHighlights(matches())
    const found = findMatches(scroll.content, query(), renderer.widthMethod)
    // Preserve the exact occurrence on a wrapped line when the node survives a restyle.
    const exact =
      !viewport && previous
        ? found.findIndex((hit) => hit.target.buffer === previous.target.buffer && hit.start === previous.start)
        : -1
    const index =
      exact >= 0
        ? exact
        : Math.max(
            0,
            found.findIndex((hit) => matchRow(hit) >= row),
          )
    setMatches(found)
    setCurrent(found.length ? index : -1)
    highlightMatches(found, index, style())
    if (viewport && found[index]) reveal(found[index], scroll)
  }

  function step(direction: 1 | -1) {
    const scroll = input.scroll()
    if (!scroll || !matches().length) return
    const next = (current() + direction + matches().length) % matches().length
    clearHighlights(matches())
    highlightMatches(matches(), next, style())
    setCurrent(next)
    reveal(matches()[next], scroll)
  }

  function close() {
    clearHighlights(matches())
    setActive(false)
    setQuery("")
    setMatches([])
    setCurrent(-1)
  }

  createEffect(
    on(
      () => active() && input.content(),
      () => {
        if (!active() || !query()) return
        const timer = setTimeout(() => rescan(), 60)
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )
  createEffect(() => {
    if (!active() || !query()) return
    style()
    const timer = setInterval(() => {
      const scroll = input.scroll()
      if (!scroll) return
      if (
        matches().some(
          (match) =>
            !match.target.alive() ||
            match.target.read() !== match.target.text ||
            (matchRow(match) >= scroll.viewport.y &&
              matchRow(match) < scroll.viewport.y + scroll.viewport.height &&
              !match.target.buffer.getLineHighlights(match.line).some((item) => item.hlRef === MATCH_REF)),
        )
      )
        rescan()
    }, 150)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(close)
  return {
    active,
    query,
    current,
    total: () => matches().length,
    async open() {
      setActive(true)
      await input.prepare?.()
      if (active()) rescan(true)
    },
    close,
    search(value: string) {
      setQuery(value)
      rescan(true)
    },
    next: () => step(1),
    previous: () => step(-1),
  }
}

export function SessionSearchBar(props: { search: ReturnType<typeof createSessionSearch> }) {
  const theme = useTheme()
  const config = useConfig()
  Keymap.createLayer(() => ({
    priority: 20,
    commands: [
      { bind: "escape", title: "Close search", group: "Search", run: props.search.close },
      { bind: "return", title: "Next match", group: "Search", run: props.search.next },
      { bind: "down", title: "Next match", group: "Search", run: props.search.next },
      { bind: "shift+return", title: "Previous match", group: "Search", run: props.search.previous },
      { bind: "up", title: "Previous match", group: "Search", run: props.search.previous },
    ],
  }))
  return (
    <box flexDirection="row" flexShrink={0} gap={1} paddingLeft={1} backgroundColor={theme.background.raised.base}>
      <text fg={theme.text.base}>Find</text>
      <input
        focused
        ref={(node) => queueMicrotask(() => !node.isDestroyed && node.focus())}
        onInput={props.search.search}
        placeholder="Search messages"
        placeholderColor={theme.text.muted}
        cursorColor={theme.text.base}
        cursorStyle={config.data.cursor}
        flexGrow={1}
      />
      <text fg={theme.text.muted}>
        {props.search.query()
          ? props.search.total()
            ? `${props.search.current() + 1}/${props.search.total()}`
            : "no matches"
          : ""}
      </text>
      <text fg={theme.text.muted}>enter/↓ next · ↑ prev · esc</text>
    </box>
  )
}

function collectTargets(node: Renderable, inside: boolean): SearchTarget[] {
  const within = inside || searchable.has(node)
  return [
    ...(within ? targetsOf(node) : []),
    ...node.getChildren().flatMap((child) => collectTargets(child as Renderable, within)),
  ]
}

function targetsOf(node: Renderable): SearchTarget[] {
  if (node instanceof TextBufferRenderable)
    return [
      {
        text: node.plainText,
        read: () => node.plainText,
        buffer: (node as unknown as { textBuffer: TextBuffer }).textBuffer,
        top: () => node.y,
        lines: () => node.lineInfo,
        alive: () => !node.isDestroyed,
        redraw: () => node.requestRender(),
      },
    ]
  if (!(node instanceof TextTableRenderable)) return []
  // OpenTUI's table cells own independent buffers; the table itself has none.
  const table = node as unknown as {
    _cells?: { textBuffer: TextBuffer; textBufferView: { lineInfo: LineInfo } }[][]
    _layout?: { rowOffsets: number[] }
    _cellPaddingY?: number
    invalidateRasterOnly?: () => void
  }
  if (!table._cells || !table.invalidateRasterOnly) return []
  return table._cells.flatMap((row, rowIndex) =>
    row.map((cell) => ({
      text: cell.textBuffer.getPlainText(),
      read: () => cell.textBuffer.getPlainText(),
      buffer: cell.textBuffer,
      top: () => node.y + (table._layout?.rowOffsets[rowIndex] ?? 0) + 1 + (table._cellPaddingY ?? 0),
      lines: () => cell.textBufferView.lineInfo,
      alive: () => !node.isDestroyed && table._cells?.[rowIndex]?.includes(cell) === true,
      redraw: () => {
        table.invalidateRasterOnly?.()
        node.requestRender()
      },
    })),
  )
}

function measureColumns(text: string, widthMethod: WidthMethod) {
  const highlight = new Int32Array(text.length + 1)
  const line = new Int32Array(text.length + 1)
  if (/^[\x20-\x7e\n]*$/.test(text)) {
    let newlines = 0
    for (let index = 0; index <= text.length; index++) {
      highlight[index] = index - newlines
      line[index] = index
      if (text[index] === "\n") newlines++
    }
    return { highlight, line }
  }
  const graphemes = [...new Intl.Segmenter().segment(text)]
  const lib = resolveRenderLib()
  const encoded = lib.encodeUnicode(text, widthMethod)
  const widths = encoded?.data.map((item) => item.width)
  if (encoded) lib.freeUnicode(encoded)
  const cells = graphemes.filter((item) => item.segment !== "\n")
  let width = 0
  let newlines = 0
  let cell = 0
  graphemes.forEach((grapheme) => {
    highlight.fill(width, grapheme.index, grapheme.index + grapheme.segment.length)
    line.fill(width + newlines, grapheme.index, grapheme.index + grapheme.segment.length)
    if (grapheme.segment === "\n") {
      newlines++
      return
    }
    width += widths?.length === cells.length ? widths[cell++] : Bun.stringWidth(grapheme.segment)
  })
  highlight[text.length] = width
  line[text.length] = width + newlines
  return { highlight, line }
}

const registered = new WeakMap<SyntaxStyle, { style: SearchStyle; match: number; current: number }>()
function styleIds(syntax: SyntaxStyle, style: SearchStyle) {
  const cached = registered.get(syntax)
  if (cached?.style === style) return cached
  const ids = {
    style,
    match: syntax.registerStyle("search.match", style.match),
    current: syntax.registerStyle("search.current", { ...style.current, bold: true }),
  }
  registered.set(syntax, ids)
  return ids
}
function reveal(match: SearchMatch, scroll: ScrollBoxRenderable) {
  const row = matchRow(match)
  const viewport = scroll.viewport
  if (row >= viewport.y + 1 && row < viewport.y + viewport.height - 1) return
  scroll.scrollBy(row - (viewport.y + Math.floor(viewport.height / 2)))
}
