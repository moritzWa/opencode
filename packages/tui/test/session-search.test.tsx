import { expect, test } from "bun:test"
import { CodeRenderable, RGBA, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { findMatches, searchable, paintSearchMatches, matchRow } from "../src/routes/session/search"

test("literal smart-case search highlights separate occurrences and wrapped unicode columns", async () => {
  const setup = await createTestRenderer({ width: 18, height: 12 })
  const syntax = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, setup.renderer.nativeScene)
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
    const foreground = RGBA.fromHex("#ffffff")
    const background = RGBA.fromHex("#654321")
    const selected = RGBA.fromHex("#123456")
    const paint = (buffer: Parameters<typeof paintSearchMatches>[0]) =>
      paintSearchMatches(
        buffer,
        matches,
        1,
        { match: { fg: foreground, bg: background }, current: { fg: foreground, bg: selected } },
        { x: 0, y: 0, width: 18, height: 12 },
        setup.renderer.widthMethod,
      )
    setup.renderer.addPostProcessFn(paint)
    await setup.renderOnce()
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.some((span) => span.text.includes("find") && span.bg.equals(background))).toBe(true)
    expect(spans.some((span) => span.text.includes("find") && span.bg.equals(selected))).toBe(true)
    setup.renderer.removePostProcessFn(paint)
    await setup.renderOnce()
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => span.bg.equals(background)),
    ).toBe(false)
  } finally {
    setup.renderer.destroy()
    syntax.destroy()
  }
})
