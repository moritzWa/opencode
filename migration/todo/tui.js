// @bun
// src/tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";

// rpc.js
import { Rpc } from "@opencode/plugin/rpc";
var Todos = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: { type: "string", description: "Brief task description" },
      status: { type: "string", description: "pending, in_progress, completed, or cancelled" },
      priority: { type: "string", description: "high, medium, or low" }
    },
    required: ["content", "status", "priority"]
  }
};
var SessionInput = {
  type: "object",
  additionalProperties: false,
  properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"]
};
var State = {
  type: "object",
  additionalProperties: false,
  properties: { sessionID: { type: "string" }, todos: Todos, revision: { type: "integer", minimum: 0 } },
  required: ["sessionID", "todos", "revision"]
};
var TodoRpc = Rpc.define({
  id: "moritz-todo",
  methods: {
    get: { input: SessionInput, output: State },
    update: {
      input: {
        ...SessionInput,
        properties: { ...SessionInput.properties, todos: Todos },
        required: ["sessionID", "todos"]
      },
      output: State
    }
  },
  events: { changed: { schema: State } }
});

// src/tui.tsx
function TodoSidebar(props) {
  const [open, setOpen] = createSignal(true);
  const visible = createMemo(() => props.todos.length > 0 && props.todos.some((item) => item.status !== "completed"));
  return _$createComponent(Show, {
    get when() {
      return visible();
    },
    get children() {
      var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("b");
      _$insertNode(_el$, _el$2);
      _$setProp(_el$, "flexShrink", 0);
      _$insertNode(_el$2, _el$4);
      _$setProp(_el$2, "flexDirection", "row");
      _$setProp(_el$2, "gap", 1);
      _$setProp(_el$2, "onMouseDown", () => props.todos.length > 2 && setOpen((value) => !value));
      _$insert(_el$2, _$createComponent(Show, {
        get when() {
          return props.todos.length > 2;
        },
        get children() {
          var _el$3 = _$createElement("text");
          _$insert(_el$3, () => open() ? "\u25BC" : "\u25B6");
          _$effect((_$p) => _$setProp(_el$3, "fg", props.theme.text.base, _$p));
          return _el$3;
        }
      }), _el$4);
      _$insertNode(_el$4, _el$5);
      _$insertNode(_el$5, _$createTextNode(`Todo`));
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return props.todos.length <= 2 || open();
        },
        get children() {
          return _$createComponent(For, {
            get each() {
              return props.todos;
            },
            children: (item) => (() => {
              var _el$7 = _$createElement("box"), _el$8 = _$createElement("text"), _el$9 = _$createTextNode(`[`), _el$0 = _$createTextNode(`] `), _el$10 = _$createElement("text");
              _$insertNode(_el$7, _el$8);
              _$insertNode(_el$7, _el$10);
              _$setProp(_el$7, "flexDirection", "row");
              _$insertNode(_el$8, _el$9);
              _$insertNode(_el$8, _el$0);
              _$setProp(_el$8, "flexShrink", 0);
              _$insert(_el$8, (() => {
                var _c$ = _$memo(() => item.status === "completed");
                return () => _c$() ? "\u2713" : item.status === "in_progress" ? "\u2022" : " ";
              })(), _el$0);
              _$setProp(_el$10, "flexGrow", 1);
              _$setProp(_el$10, "wrapMode", "word");
              _$insert(_el$10, () => item.content);
              _$effect((_p$) => {
                var _v$ = item.status === "in_progress" ? props.theme.text.feedback.warning.base : props.theme.text.muted, _v$2 = item.status === "in_progress" ? props.theme.text.feedback.warning.base : props.theme.text.muted;
                _v$ !== _p$.e && (_p$.e = _$setProp(_el$8, "fg", _v$, _p$.e));
                _v$2 !== _p$.t && (_p$.t = _$setProp(_el$10, "fg", _v$2, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$7;
            })()
          });
        }
      }), null);
      _$effect((_$p) => _$setProp(_el$4, "fg", props.theme.text.base, _$p));
      return _el$;
    }
  });
}
var tui_default = {
  id: "moritz-todo",
  setup(context) {
    const rpc = context.client.rpc(TodoRpc);
    const [states, setStates] = createStore({});
    const active = new Map;
    const controller = new AbortController;
    const accept = (state) => {
      if (controller.signal.aborted)
        return;
      if (state.revision < (states[state.sessionID]?.revision ?? -1))
        return;
      setStates(state.sessionID, state);
    };
    const refresh = (sessionID) => {
      const location = context.data.session.get(sessionID)?.location ?? context.location;
      return rpc.get({
        sessionID
      }, {
        location,
        signal: controller.signal
      }).then(accept).catch((error) => {
        if (!controller.signal.aborted)
          context.ui.toast.show({
            variant: "error",
            message: `Could not load todos: ${error.message}`
          });
      });
    };
    const events = context.data.listen(({
      details
    }) => {
      if (details.type === "rpc.moritz-todo.changed")
        accept(details.data);
    });
    const connected = context.data.on("server.connected", () => {
      active.forEach((_, sessionID) => {
        refresh(sessionID);
      });
    });
    const slot = context.ui.slot({
      append: "sidebar.content",
      render(props) {
        createEffect(() => {
          const sessionID = props.sessionID;
          active.set(sessionID, (active.get(sessionID) ?? 0) + 1);
          refresh(sessionID);
          onCleanup(() => {
            const count = active.get(sessionID) - 1;
            if (count)
              active.set(sessionID, count);
            if (!count)
              active.delete(sessionID);
          });
        });
        return _$createComponent(TodoSidebar, {
          get todos() {
            return states[props.sessionID]?.todos ?? [];
          },
          get theme() {
            return context.theme;
          }
        });
      }
    });
    return () => {
      controller.abort();
      events();
      connected();
      slot();
    };
  }
};
export {
  TodoSidebar,
  tui_default as default
};
