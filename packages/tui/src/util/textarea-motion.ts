import { EditBuffer, TextareaRenderable, type LogicalCursor, type RGBA } from "@opentui/core"

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })

type Motion = {
  editBuffer: EditBuffer
  editorView: {
    getSelection: () => { start: number; end: number } | null
    setSelection: (start: number, end: number, bg?: RGBA, fg?: RGBA) => void
  }
  _selectionBg?: RGBA
  _selectionFg?: RGBA
  updateSelectionForMovement: (select: boolean, beforeMovement: boolean) => void
  clearSelection: () => boolean
}

const anchors = new WeakMap<object, number>()
let installed = false

// Make cursor motion in the prompt behave like a macOS text field: Option+Right stops after a word, not after the
// punctuation that follows it, and a keyboard selection ends at the cursor instead of one cell past it.
export function installTextareaMotion() {
  if (installed) return
  installed = true

  // OpenTUI finds word boundaries from line-break opportunities, so punctuation that cannot start a line ("?", ".",
  // ")") belongs to the word before it. Use the Unicode word segments instead, skipping spaces and punctuation.
  EditBuffer.prototype.getNextWordBoundary = function () {
    const cursor = this.getCursorPosition()
    const lines = this.getText().split("\n")
    const line = lines[cursor.row] ?? ""
    const end = words(line).find((word) => word.end > cursor.col)?.end
    if (end !== undefined) return at(this, cursor.row, end)
    if (cursor.row + 1 < lines.length) return at(this, cursor.row + 1, 0)
    return at(this, cursor.row, Bun.stringWidth(line))
  }

  EditBuffer.prototype.getPrevWordBoundary = function () {
    const cursor = this.getCursorPosition()
    const lines = this.getText().split("\n")
    const start = words(lines[cursor.row] ?? "").findLast((word) => word.start < cursor.col)?.start
    if (start !== undefined) return at(this, cursor.row, start)
    if (cursor.row > 0) return at(this, cursor.row - 1, Bun.stringWidth(lines[cursor.row - 1] ?? ""))
    return at(this, 0, 0)
  }

  // OpenTUI extends a keyboard selection like a mouse drag, which covers the cell under the cursor as well: one
  // Shift+Right from the start of "hello" selects "he". Let it track the selection, then select the offsets between
  // the anchor and the cursor.
  const prototype = TextareaRenderable.prototype as unknown as Motion
  const original = prototype.updateSelectionForMovement
  prototype.updateSelectionForMovement = function (this: Motion, select, beforeMovement) {
    if (!select) return original.call(this, select, beforeMovement)
    const cursor = this.editBuffer.getCursorPosition().offset
    if (beforeMovement) {
      const selection = this.editorView.getSelection()
      anchors.set(this, !selection ? cursor : cursor === selection.start ? selection.end : selection.start)
      return original.call(this, select, beforeMovement)
    }
    original.call(this, select, beforeMovement)
    const anchor = anchors.get(this) ?? cursor
    const head = this.editBuffer.getCursorPosition().offset
    if (anchor === head) {
      this.clearSelection()
      return
    }
    this.editorView.setSelection(Math.min(anchor, head), Math.max(anchor, head), this._selectionBg, this._selectionFg)
  }
}

function words(line: string) {
  let col = 0
  return Array.from(segmenter.segment(line)).flatMap((part) => {
    const start = col
    col += Bun.stringWidth(part.segment)
    return part.isWordLike ? [{ start, end: col }] : []
  })
}

function at(buffer: EditBuffer, row: number, col: number): LogicalCursor {
  return { row, col, offset: buffer.positionToOffset(row, col) }
}
