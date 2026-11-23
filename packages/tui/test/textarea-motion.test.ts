import { EditBuffer, TextareaRenderable, ResourceContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "bun:test"
import { installTextareaMotion } from "../src/util/textarea-motion"

installTextareaMotion()

function boundary(text: string, row: number, col: number, direction: "next" | "prev") {
  const context = new ResourceContext({ objectCapacity: 8, renderCellsMax: 1 })
  const buffer = EditBuffer.create("wcwidth", context)
  try {
    buffer.setText(text)
    buffer.setCursorToLineCol(row, col)
    const result = direction === "next" ? buffer.getNextWordBoundary() : buffer.getPrevWordBoundary()
    return [result.row, result.col]
  } finally {
    buffer.destroy()
    context.destroy()
  }
}

test("moving to the next word stops before trailing punctuation", () => {
  expect(boundary("account archie thread?", 0, 15, "next")).toEqual([0, 21])
  expect(boundary("account archie thread?", 0, 21, "next")).toEqual([0, 22])
})

test("moving to the previous word starts at the word, not the punctuation before it", () => {
  expect(boundary("account archie thread?", 0, 22, "prev")).toEqual([0, 15])
  expect(boundary("account archie thread?", 0, 21, "prev")).toEqual([0, 15])
  expect(boundary("(hello), world", 0, 14, "prev")).toEqual([0, 9])
  expect(boundary("(hello), world", 0, 9, "prev")).toEqual([0, 1])
  expect(boundary("(hello), world", 0, 1, "prev")).toEqual([0, 0])
})

test("punctuation and spaces between words are skipped", () => {
  expect(boundary("(hello), world", 0, 0, "next")).toEqual([0, 6])
  expect(boundary("(hello), world", 0, 6, "next")).toEqual([0, 14])
})

test("word movement continues across lines", () => {
  expect(boundary("ab\ncd", 0, 2, "next")).toEqual([1, 0])
  expect(boundary("ab\ncd", 1, 0, "prev")).toEqual([0, 2])
})

test("wide characters count as two columns", () => {
  expect(boundary("日本 ok", 0, 0, "next")[1]).toBeGreaterThan(0)
  expect(boundary("hi 😀 ok", 0, 3, "next")).toEqual([0, 8])
})

async function textarea(text: string, col: number) {
  const setup = await createTestRenderer({ width: 40, height: 5 })
  const input = new TextareaRenderable(setup.renderer, { width: 40, height: 3, initialValue: text })
  setup.renderer.root.add(input)
  input.editBuffer.setCursorToLineCol(0, col)
  return {
    input,
    // What Cmd+C reads: the renderer's selection, not the textarea's own.
    copied: () => setup.renderer.getSelection()?.getSelectedText(),
    [Symbol.dispose]: () => setup.renderer.destroy(),
  }
}

test("selecting the next word stops before the punctuation after it", async () => {
  using view = await textarea("account archie thread?", 15)
  view.input.moveWordForward({ select: true })
  expect(view.input.getSelectedText()).toBe("thread")
  expect(view.copied()).toBe("thread")
  view.input.moveWordBackward({ select: true })
  expect(view.input.hasSelection()).toBe(false)
})

test("a keyboard selection ends at the cursor, not one cell past it", async () => {
  using view = await textarea("hello world foo", 0)
  view.input.moveCursorRight({ select: true })
  expect(view.input.getSelectedText()).toBe("h")
  view.input.moveCursorRight({ select: true })
  expect(view.input.getSelectedText()).toBe("he")
  view.input.moveCursorLeft({ select: true })
  view.input.moveCursorLeft({ select: true })
  expect(view.input.hasSelection()).toBe(false)
  expect(view.copied()).toBeUndefined()
})

test("selecting backward leaves out the cell the cursor started on", async () => {
  using view = await textarea("hello world foo", 11)
  view.input.moveCursorLeft({ select: true })
  expect(view.input.getSelectedText()).toBe("d")
  view.input.moveWordBackward({ select: true })
  expect(view.input.getSelectedText()).toBe("world")
  expect(view.copied()).toBe("world")
  view.input.moveCursorRight({ select: true })
  expect(view.input.getSelectedText()).toBe("orld")
})

test("selecting to the end of the line takes exactly the rest of the line", async () => {
  using view = await textarea("hello world", 6)
  view.input.gotoLineEnd({ select: true })
  expect(view.input.getSelectedText()).toBe("world")
})
