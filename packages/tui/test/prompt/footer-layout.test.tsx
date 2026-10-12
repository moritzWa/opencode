/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { RouteProvider } from "../../src/context/route"
import { RunningSubagents } from "../../src/component/prompt/running-subagents"
import { tmpdir } from "../fixture/fixture"

test("long subagent names stay on one line beside fixed speech controls", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  for (const width of [60, 80, 120]) {
    const app = await testRender(
      () => (
        <TestTuiContexts paths={{ state: tmp.path }}>
          <TuiConfigProvider config={createTuiResolvedConfig({})}>
            <KVProvider>
              <ThemeProvider mode="light">
                <RouteProvider>
                  <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
                    <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} gap={1}>
                      <text flexShrink={0} wrapMode="none">
                        esc again to undo
                      </text>
                      <box flexShrink={1} minWidth={0} overflow="hidden">
                        <RunningSubagents
                          list={[
                            { id: "child", title: "opencode-memory recall selector with an extremely long title" },
                          ]}
                        />
                      </box>
                    </box>
                    <box flexShrink={0}>
                      <text wrapMode="none">play − 2.1x + stop</text>
                    </box>
                  </box>
                </RouteProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 5 },
    )
    try {
      await app.renderOnce()
      await Bun.sleep(100)
      await app.renderOnce()
      const lines = app
        .captureCharFrame()
        .split("\n")
        .filter((line) => line.trim())
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("esc again to undo")
      expect(lines[0]).toContain("play − 2.1x + stop")
    } finally {
      app.renderer.destroy()
    }
  }
})
