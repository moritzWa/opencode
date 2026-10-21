import { EditBufferRenderable, TextBufferRenderable, TextTableRenderable, type RGBA } from "@opentui/core"

type Selectable = {
  _selectionBg?: RGBA
  _selectionFg?: RGBA
  [owned]?: true
}

const owned = Symbol("theme selection colors")
let colors: { bg: RGBA; fg: RGBA } | undefined
let installed = false

// OpenTUI paints an unset selection as the cell's inverse, and text drawn over a block background has a
// transparent cell, so it turns into black on the ink color. Give every text renderable and editor that does not
// choose its own selection colors the theme's.
export function setSelectionDefaults(next?: { bg: RGBA; fg: RGBA }) {
  colors = next
  if (installed || !next) return
  installed = true
  ;[
    [TextBufferRenderable.prototype, "onSelectionChanged"],
    [TextTableRenderable.prototype, "onSelectionChanged"],
    [EditBufferRenderable.prototype, "onSelectionChanged"],
    [EditBufferRenderable.prototype, "setSelection"],
  ].forEach(([prototype, method]) => {
    const target = prototype as unknown as Record<string, (this: Selectable, ...args: unknown[]) => unknown>
    const original = target[method as string]
    target[method as string] = function (this: Selectable, ...args: unknown[]) {
      if (colors && (this[owned] || (this._selectionBg === undefined && this._selectionFg === undefined))) {
        this._selectionBg = colors.bg
        this._selectionFg = colors.fg
        this[owned] = true
      }
      return original.apply(this, args)
    }
  })
}
