/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { createEffect } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ThemeProvider, useTheme, useThemes } from "../src/context/theme"
import { Selection } from "../src/util/selection"
import { setSelectionDefaults } from "../src/util/selection-defaults"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

afterEach(() => setSelectionDefaults(undefined))

function contrast(a: RGBA, b: RGBA) {
  const luminance = (color: RGBA) => {
    const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

function Blocks(props: { themed: boolean }) {
  const theme = useTheme()
  const themes = useThemes()
  createEffect(() => {
    if (!props.themed) return
    const colors = Selection.selectionColors(theme, theme.background.base)
    setSelectionDefaults({ bg: colors.selectionBg, fg: colors.selectionFg })
  })
  return (
    <box width="100%" height="100%" backgroundColor={theme.background.base}>
      <box paddingLeft={2} backgroundColor={theme.background.raised.base}>
        <text fg={theme.text.base}>user message text here</text>
      </box>
      <box paddingLeft={3}>
        <markdown
          syntaxStyle={themes.currentSyntax()}
          content={"- assistant bullet text here"}
          streaming={false}
          internalBlockMode="top-level"
        />
      </box>
    </box>
  )
}

async function selectedRows(mode: "light" | "dark", themed: boolean) {
  await using temporary = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode={mode} source={emptyThemeSource}>
            <Blocks themed={themed} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 6, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await waitForHighlightedFrame(app, (frame) => frame.includes("assistant bullet"))
    await app.mockMouse.drag(4, 0, 12, 0)
    await app.renderOnce()
    const user = (await app.captureSpans()).lines[0].spans.find((item) => item.text.includes("er mes"))!
    app.renderer.clearSelection()
    await app.mockMouse.drag(6, 1, 14, 1)
    await app.renderOnce()
    const assistant = (await app.captureSpans()).lines[1].spans.find((item) => item.text.includes("ssistant"))!
    return { user, assistant }
  } finally {
    app.renderer.destroy()
  }
}

test.each(["light", "dark"] as const)("selected text in any block stays readable (%s)", async (mode) => {
  const themed = await selectedRows(mode, true)
  expect(contrast(themed.user.fg, themed.user.bg)).toBeGreaterThan(4.5)
  expect(contrast(themed.assistant.fg, themed.assistant.bg)).toBeGreaterThan(4.5)
})

test("the unthemed default is unreadable on the light theme", async () => {
  const plain = await selectedRows("light", false)
  expect(contrast(plain.user.fg, plain.user.bg)).toBeLessThan(4.5)
})
