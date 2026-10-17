import { expect, test } from "bun:test"
import { CodeRenderable, RGBA, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { findMatches, searchable, highlightMatches, clearHighlights, matchRow } from "../src/routes/session/search"

test("literal smart-case search highlights separate occurrences and wrapped unicode columns", async () => {
  const setup = await createTestRenderer({ width: 18, height: 12, useThread: false })
  const syntax = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })
  const node = new CodeRenderable(setup.renderer, {
    content: "界😀 find find\nFind [literal] find",
    filetype: "text",
    syntaxStyle: syntax,
    width: 18,
    wrapMode: "word",
    drawUnstyledText: true,
  })
  setup.renderer.root.add(node)
  searchable.add(node)
  try {
    await setup.renderOnce()
    const matches = findMatches(setup.renderer.root, "find", setup.renderer.widthMethod)
    expect(matches).toHaveLength(4)
    expect(matches[0].start).toBe(5)
    expect(matches[1].start).toBe(10)
    expect(findMatches(setup.renderer.root, "Find", setup.renderer.widthMethod)).toHaveLength(1)
    expect(findMatches(setup.renderer.root, "[literal]", setup.renderer.widthMethod)).toHaveLength(1)
    expect(matchRow(matches[3])).toBeGreaterThan(matchRow(matches[0]))
    const color = RGBA.fromHex("#ffffff")
    highlightMatches(matches, 1, { match: { fg: color, bg: color }, current: { fg: color, bg: color } })
    const firstLine = matches[0].target.buffer.getLineHighlights(0)
    expect(firstLine.filter((item) => item.hlRef === 0x5e01)).toHaveLength(2)
    expect(firstLine.filter((item) => item.hlRef === 0x5e02)).toHaveLength(1)
    clearHighlights(matches)
    expect(
      matches[0].target.buffer.getLineHighlights(0).filter((item) => item.hlRef === 0x5e01 || item.hlRef === 0x5e02),
    ).toHaveLength(0)
  } finally {
    setup.renderer.destroy()
    syntax.destroy()
  }
})
