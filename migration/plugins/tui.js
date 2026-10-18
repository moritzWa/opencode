import { adapt } from "opencode-read-aloud/v2-compat"
import backslash from "./legacy/tui-plugins/backslash-newline.js"
import links from "./legacy/tui-plugins/clickable-links.js"
import folds from "./legacy/tui-plugins/fold-diffs.js"
import pr from "./legacy/tui-plugins/pr-footer.js"
import title from "./legacy/tui-plugins/session-title.js"
import peers from "opencode-plugin-peers/tui"

export default {
  id: "moritz-parity-tui",
  async setup(context) {
    const bridge = adapt(context)
    try {
      for (const plugin of [backslash, links, folds, pr, title, peers]) {
        await plugin.tui(bridge.api, plugin === folds ? { bash_output: true, bash_min_lines: 0, ...context.options.folds } : context.options[plugin.id])
      }
      return bridge.dispose
    } catch (error) {
      await bridge.dispose()
      throw error
    }
  },
}
