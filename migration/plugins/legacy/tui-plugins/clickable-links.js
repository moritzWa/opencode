// @bun
// ../../../../../../../.config/opencode/tui-plugins/clickable-links.js
import { getLinkId } from "@opentui/core";
var tui = async (api) => {
  let pressed;
  api.renderer.root.onMouse = (event) => {
    if (event.type === "down") {
      pressed = event.button === 0 && !event.modifiers.alt && !event.modifiers.shift ? { x: event.x, y: event.y, url: linkAt(api.renderer, event) } : undefined;
      return;
    }
    if (event.type === "drag" && pressed && (pressed.x !== event.x || pressed.y !== event.y)) {
      pressed = undefined;
      return;
    }
    if (event.type !== "up")
      return;
    const click = pressed;
    pressed = undefined;
    if (!click?.url || click.x !== event.x || click.y !== event.y)
      return;
    if (api.renderer.getSelection()?.getSelectedText())
      return;
    if (linkAt(api.renderer, event) !== click.url)
      return;
    event.preventDefault();
    event.stopPropagation();
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const child = Bun.spawn([command, click.url], { stdout: "ignore", stderr: "ignore" });
    child.exited.then((code) => {
      if (code)
        api.ui.toast({ variant: "error", message: `Could not open ${click.url}` });
    });
  };
  api.lifecycle.onDispose(() => {
    api.renderer.root.onMouse = undefined;
  });
};
function linkAt(renderer, event) {
  if (renderer.getLinkAt?.(event.x, event.y))
    return;
  const buffer = renderer.currentRenderBuffer;
  if (event.x < 0 || event.y < 0 || event.x >= buffer.width || event.y >= buffer.height)
    return;
  const id = getLinkId(buffer.buffers.attributes[event.y * buffer.width + event.x]);
  const url = id && buffer.lib.linkGetUrl(id, 16384);
  if (url && /^https?:\/\//i.test(url))
    return url;
  const node = event.target;
  if (node?.filetype !== "markdown" || !node.lineInfo || typeof node.content !== "string")
    return;
  const line = event.y - node.y;
  const info = node.lineInfo;
  if (line < 0 || line >= info.lineStartCols.length || event.x < node.x)
    return;
  const column = event.x - node.x;
  if (column >= info.lineWidthCols[line])
    return;
  const cell = info.lineStartCols[line] + column;
  let width = 0;
  let index = 0;
  for (const char of node.plainText) {
    width += char === `
` ? 1 : Bun.stringWidth(char);
    if (width > cell)
      break;
    index += char.length;
  }
  const raw = node.content;
  let offset = 0;
  for (let at = 0;at < index && offset < raw.length; ) {
    if (raw[offset] === node.plainText[at]) {
      offset++;
      at++;
    } else if (/\s/.test(node.plainText[at]))
      at++;
    else
      offset++;
  }
  for (const match of raw.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    let target = match[0].replace(/[.,;:!?]+$/, "");
    while (target.endsWith(")") && (target.match(/\(/g)?.length ?? 0) < (target.match(/\)/g)?.length ?? 0))
      target = target.slice(0, -1);
    const label = raw.slice(0, match.index).endsWith("](") ? raw.lastIndexOf("[", match.index) : -1;
    if (offset >= (label < 0 ? match.index : label) && offset < match.index + target.length)
      return target;
  }
}
var clickable_links_default = { id: "clickable-links", tui };
export {
  clickable_links_default as default
};

//# debugId=8F6F90F5A28CBDBE64756E2164756E21
