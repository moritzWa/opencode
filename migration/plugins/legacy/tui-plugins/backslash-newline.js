// @bun
// ../../../../../../../.config/opencode/tui-plugins/backslash-newline.js
var backslashBeforeCursor = (editor) => {
  const text = editor.plainText;
  const offset = editor.cursorOffset;
  if (typeof offset !== "number")
    return text.endsWith("\\");
  if (offset <= 0)
    return false;
  if (typeof editor.getTextRange === "function")
    return editor.getTextRange(offset - 1, offset) === "\\";
  return text[offset - 1] === "\\";
};
var plugin = {
  id: "backslash-newline",
  tui: async (api) => {
    api.keymap.registerLayer({
      mode: "base",
      commands: [
        {
          name: "backslash.newline",
          title: "Newline after backslash",
          hidden: true,
          run() {
            const editor = api.renderer.currentFocusedRenderable;
            if (!editor || typeof editor.plainText !== "string" || typeof editor.newLine !== "function") {
              return false;
            }
            if (!backslashBeforeCursor(editor))
              return false;
            if (typeof editor.deleteCharBackward === "function")
              editor.deleteCharBackward();
            else if (typeof editor.setText === "function" && editor.plainText.endsWith("\\")) {
              editor.setText(editor.plainText.slice(0, -1));
              if (typeof editor.gotoBufferEnd === "function")
                editor.gotoBufferEnd();
            } else
              return false;
            editor.newLine();
            return true;
          }
        }
      ],
      bindings: [{ key: "return", cmd: "backslash.newline", desc: "Newline when \\ is before the cursor" }]
    });
  }
};
var backslash_newline_default = plugin;
export {
  backslash_newline_default as default
};

//# debugId=D9E3E7EBFB445A7E64756E2164756E21
