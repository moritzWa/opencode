/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme, useThemes } from "../src/context/theme"
import { createSessionSearch, searchStyle, SessionSearchBar, searchable } from "../src/routes/session/search"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { waitForHighlightedFrame } from "./fixture/frame"

function contrast(a: RGBA, b: RGBA) {
  const luminance = (color: RGBA) => {
    const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

let palette: ReturnType<typeof useTheme>

function Harness() {
  const themes = useThemes()
  palette = useTheme()
  let scroll: ScrollBoxRenderable | undefined
  const search = createSessionSearch({ scroll: () => scroll, content: () => 0 })
  onMount(() => void search.open())
  return (
    <box flexDirection="column" width="100%" height="100%">
      <scrollbox ref={(node: ScrollBoxRenderable) => (scroll = node)} flexGrow={1}>
        <markdown
          ref={(node) => searchable.add(node)}
          syntaxStyle={themes.currentSyntax()}
          content={"The agent said **upstream** is ready.\n\nSecond paragraph."}
          streaming={false}
          internalBlockMode="top-level"
        />
      </scrollbox>
      <SessionSearchBar search={search} />
    </box>
  )
}

test.each(["light", "dark"] as const)("find input and matches stay readable in %s mode", async (mode) => {
  await using temporary = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode={mode} source={emptyThemeSource}>
            <Keymap.Provider>
              <Harness />
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 70, height: 12, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await waitForHighlightedFrame(app, (frame) => frame.includes("Second paragraph") && frame.includes("Find"))
    await app.mockInput.typeText("upstream")
    await waitForHighlightedFrame(app, (frame) => frame.includes("1/1"))
    const lines = app.captureSpans().lines
    const message = lines[0].spans.find((item) => item.text.includes("upstream"))!
    const body = lines.flatMap((line) => line.spans).find((item) => item.text.includes("Second"))!
    const input = lines.at(-1)!.spans.find((item) => item.text.includes("upstream"))!

    expect(message.bg.equals(body.bg)).toBe(false)
    expect(contrast(message.fg, message.bg)).toBeGreaterThan(4.5)
    expect(input.fg.equals(palette.text.base)).toBe(true)
    expect(contrast(input.fg, input.bg.a === 0 ? palette.background.raised.base : input.bg)).toBeGreaterThan(4.5)
  } finally {
    app.renderer.destroy()
  }
})

test("current match is distinct from the other matches and every state is readable", () => {
  const themes = [
    { base: "#FFFFFF", text: "#000000", warning: "#966C1E" },
    { base: "#1C1C1C", text: "#FFFFFF", warning: "#FFC107" },
    { base: "#FAF4ED", text: "#575279", warning: "#EA9D34" },
    { base: "#282A36", text: "#F8F8F2", warning: "#F1FA8C" },
  ]
  themes.forEach((item) => {
    const style = searchStyle({
      background: { base: RGBA.fromHex(item.base) },
      text: { base: RGBA.fromHex(item.text), feedback: { warning: { base: RGBA.fromHex(item.warning) } } },
    })
    expect(style.match.bg.equals(RGBA.fromHex(item.base))).toBe(false)
    expect(style.current.bg.equals(style.match.bg)).toBe(false)
    expect(contrast(style.match.fg, style.match.bg)).toBeGreaterThan(4.5)
    expect(contrast(style.current.fg, style.current.bg)).toBeGreaterThan(4.5)
  })
})
