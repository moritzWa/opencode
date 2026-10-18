// @bun
// ../../../../../../../.config/opencode/tui-plugins/session-title.js
import { createElement, effect, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";
var DEFAULTS = { max: 48, min: 12 };
var tui = async (api, rawOptions) => {
  if (typeof api.slots?.register !== "function")
    return;
  const options = { ...DEFAULTS, ...rawOptions ?? {} };
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right(_ctx, props) {
        const root = createElement("box");
        const text = createElement("text");
        const [width, setWidth] = createSignal(Infinity);
        setProp(root, "flexShrink", 1);
        setProp(root, "minWidth", 0);
        setProp(root, "maxWidth", options.max);
        setProp(root, "onSizeChange", function() {
          setWidth(this.width);
        });
        setProp(text, "wrapMode", "none");
        setProp(text, "truncate", true);
        setProp(text, "flexShrink", 1);
        setProp(text, "minWidth", 0);
        effect((prev) => {
          const title = api.state.session.get(props.session_id)?.title ?? "";
          const cut = width() < Math.min(options.min, title.length);
          return setProp(text, "fg", cut ? api.theme.current.backgroundElement : api.theme.current.textMuted, prev);
        });
        insert(text, () => api.state.session.get(props.session_id)?.title ?? "");
        insert(root, text);
        return root;
      }
    }
  });
};
var session_title_default = { id: "session-title", tui };
export {
  session_title_default as default
};

//# debugId=A0C721336E06DBB864756E2164756E21
