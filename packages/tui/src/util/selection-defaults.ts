import { TextBufferRenderable, TextTableRenderable, type RGBA } from "@opentui/core"

type Selectable = {
  _selectionBg?: RGBA
  _selectionFg?: RGBA
  [owned]?: true
}

const owned = Symbol("theme selection colors")
let colors: { bg: RGBA; fg: RGBA } | undefined
let installed = false

// OpenTUI paints an unset selection as the cell's inverse, and text drawn over a block background has a
// transparent cell, so it turns into black on the ink color. Give every text renderable that does not choose
// its own selection colors the theme's.
export function setSelectionDefaults(next?: { bg: RGBA; fg: RGBA }) {
  colors = next
  if (installed || !next) return
  installed = true
  ;[TextBufferRenderable.prototype, TextTableRenderable.prototype].forEach((prototype) => {
    const original = prototype.onSelectionChanged
    prototype.onSelectionChanged = function (this: Selectable, selection) {
      if (colors && (this[owned] || (this._selectionBg === undefined && this._selectionFg === undefined))) {
        this._selectionBg = colors.bg
        this._selectionFg = colors.fg
        this[owned] = true
      }
      return original.call(this as never, selection)
    }
  })
}
