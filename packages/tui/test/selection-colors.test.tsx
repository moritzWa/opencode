/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { ThemeProvider, useTheme, type ThemeSource } from "../src/context/theme"
import { Selection } from "../src/util/selection"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

function contrast(a: RGBA, b: RGBA) {
  const luminance = (color: RGBA) => {
    const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

function Block(props: { themed: boolean }) {
  const theme = useTheme()
  return (
    <box width="100%" height="100%" backgroundColor={theme.background.base}>
      <box paddingLeft={2} backgroundColor={theme.background.raised.base}>
        <text
          fg={theme.text.base}
          {...(props.themed ? Selection.selectionColors(theme, theme.background.raised.base) : {})}
        >
          user message text here
        </text>
      </box>
    </box>
  )
}

async function selected(
  mode: "light" | "dark",
  themed: boolean,
  source: ThemeSource = emptyThemeSource,
  name?: string,
) {
  await using temporary = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig(name ? { theme: { name, mode } } : {})}>
          <ThemeProvider mode={mode} source={source}>
            <Block themed={themed} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 4, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("user message"))
    await app.mockMouse.drag(4, 0, 12, 0)
    await app.renderOnce()
    const spans = (await app.captureSpans()).lines[0].spans
    return spans.find((item) => item.text.includes("er mes"))!
  } finally {
    app.renderer.destroy()
  }
}

test.each(["light", "dark"] as const)("selected text in a block stays readable (%s)", async (mode) => {
  const plain = await selected(mode, false)
  const themed = await selected(mode, true)
  // The unthemed default paints black text on the ink color; the themed selection keeps contrast.
  if (mode === "light") expect(contrast(plain.fg, plain.bg)).toBeLessThan(4.5)
  expect(contrast(themed.fg, themed.bg)).toBeGreaterThan(4.5)
})
