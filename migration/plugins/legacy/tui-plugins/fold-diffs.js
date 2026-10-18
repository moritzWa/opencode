// @bun
// ../../../../../../../.config/opencode/tui-plugins/fold-diffs.js
import { TextRenderable } from "@opentui/core";
var DEFAULTS = {
  lines: 0,
  min_lines: 6,
  stats: true,
  folded: true,
  key: "ctrl+o",
  bash: true,
  bash_lines: 1,
  bash_output: false
};
var TITLES = [/^\u2190 Edit /, /^# Wrote /, /^\u2190 Patched /, /^# Created /, /^# Deleted /, /^# Moved /];
var PROMPT = "$ ";
var SWEEP_MS = 2000;
function children(node) {
  return typeof node?.getChildren === "function" ? node.getChildren() : [];
}
function plain(node) {
  const value = node?.plainText;
  return typeof value === "string" ? value : children(node).map(plain).filter(Boolean).join(" ") || undefined;
}
function isDiff(node) {
  return typeof node?.diff === "string";
}
function isCode(node) {
  return typeof node?.content === "string" && typeof node?.filetype === "string";
}
function shellCommand(block) {
  const kids = children(block);
  if (!kids.length || kids.length > 3)
    return;
  for (const child of kids) {
    const inner = children(child);
    if (!inner.length)
      continue;
    const text = plain(inner[0]);
    if (typeof text !== "string" || !text.startsWith(PROMPT))
      return;
    return { node: inner[0], text, box: child };
  }
}
function commandRows(node, text) {
  const height = typeof node?.height === "number" ? node.height : 0;
  return Math.max(text.split(`
`).length, height);
}
function bulk(node, found = []) {
  if (!node || node.isDestroyed)
    return found;
  if (isDiff(node) || isCode(node)) {
    found.push(node);
    return found;
  }
  for (const child of children(node))
    bulk(child, found);
  return found;
}
function isTranscript(node) {
  return typeof node?.scrollTo === "function" && typeof node?.scrollHeight === "number" && (typeof node.id === "string" && /^session:.*:transcript$/.test(node.id) || node.stickyScroll === true && node.stickyStart === "bottom");
}
function findTranscript(node) {
  if (!node || node.isDestroyed)
    return;
  if (isTranscript(node))
    return node;
  if (typeof node.scrollTo === "function")
    return;
  for (const child of children(node)) {
    const hit = findTranscript(child);
    if (hit)
      return hit;
  }
}
function blockTitle(node) {
  const kids = children(node);
  if (kids.length < 2)
    return;
  const head = plain(kids[0]);
  if (!head)
    return;
  return TITLES.some((re) => re.test(head)) ? head : undefined;
}
function scan(node, hits = [], shell = true) {
  if (!node || node.isDestroyed)
    return hits;
  if (blockTitle(node) || shell && shellCommand(node)) {
    hits.push(node);
    return hits;
  }
  for (const child of children(node))
    scan(child, hits, shell);
  return hits;
}
function summarise(nodes) {
  let added = 0;
  let removed = 0;
  let lines = 0;
  let diffs = 0;
  for (const node of nodes) {
    if (isDiff(node)) {
      diffs++;
      for (const line of node.diff.split(`
`)) {
        if (line.startsWith("+++") || line.startsWith("---"))
          continue;
        if (line.startsWith("+"))
          added++;
        else if (line.startsWith("-"))
          removed++;
      }
      continue;
    }
    lines += node.content.split(`
`).length;
  }
  if (diffs)
    return { size: added + removed, label: `+${added} \u2212${removed}` };
  return { size: lines, label: `${lines} ${lines === 1 ? "line" : "lines"}` };
}
var fold_diffs_default = {
  id: "opencode-fold-diffs",
  tui: async (api, options) => {
    const opts = { ...DEFAULTS, ...options ?? {} };
    const peek = Math.max(0, Number(opts.lines) || 0);
    const floor = Math.max(0, Number(opts.min_lines) || 0);
    const shell = opts.bash !== false;
    const shellPeek = Math.max(0, Number(opts.bash_lines) || 0);
    const shellFloor = opts.bash_min_lines === undefined ? floor : Math.max(0, Number(opts.bash_min_lines) || 0);
    const shellOutput = opts.bash_output === true;
    const known = new WeakMap;
    const owned = new Set;
    let folding = opts.folded !== false;
    let titles = opts.stats !== false;
    let cached;
    function transcript() {
      if (cached && !cached.isDestroyed)
        return cached;
      cached = findTranscript(api.renderer.root);
      return cached;
    }
    function apply(state, fold) {
      state.folded = fold;
      state.body.forEach((node, index) => {
        try {
          if (state.hide && index > 0) {
            node.visible = fold ? false : state.visible[index];
            return;
          }
          node.maxHeight = fold ? index === 0 ? state.peek : 0 : undefined;
          node.overflow = fold ? "hidden" : state.overflow[index];
        } catch {}
      });
      if (state.chrome) {
        try {
          state.block.gap = fold ? 0 : 1;
          state.block.paddingTop = fold ? 0 : 1;
          state.block.paddingBottom = fold ? 0 : 1;
          if (state.inner)
            state.inner.gap = fold ? 0 : 1;
        } catch {}
      }
      if (!titles || !state.title)
        return;
      const next = fold ? `${state.title.text} ${state.suffix}` : state.title.text;
      try {
        state.title.node.content = next;
      } catch {
        titles = false;
        return;
      }
      if (plain(state.title.node) !== next)
        titles = false;
    }
    function adoptDiff(block) {
      const title = blockTitle(block);
      if (!title)
        return false;
      const kids = children(block);
      const body = [];
      const heavy = [];
      for (const child of kids.slice(1)) {
        const found = bulk(child);
        if (!found.length)
          continue;
        body.push(child);
        heavy.push(...found);
      }
      if (!body.length)
        return false;
      const stats = summarise(heavy);
      if (stats.size < floor)
        return false;
      const head = kids[0];
      const titleNode = typeof head.plainText === "string" ? head : new TextRenderable(api.renderer, { content: "", fg: api.theme.current.textMuted });
      if (titleNode !== head)
        head.add(titleNode);
      const state = {
        block,
        body,
        overflow: body.map((node) => node.overflow),
        title: { node: titleNode, text: titleNode === head ? title : "" },
        inserted: titleNode !== head,
        suffix: `${stats.label} \xB7 click to expand`,
        peek,
        chrome: peek === 0,
        folded: false
      };
      known.set(block, state);
      owned.add(state);
      block.onMouseUp = () => {
        if (api.renderer.getSelection?.()?.getSelectedText?.())
          return;
        apply(state, !state.folded);
      };
      if (folding)
        apply(state, true);
      return true;
    }
    function adoptShell(block) {
      const found = shellCommand(block);
      if (!found)
        return;
      if (commandRows(found.node, found.text) < shellFloor)
        return;
      const body = shellOutput ? [found.node, ...children(found.box).slice(1)] : [found.node];
      const state = {
        block,
        body,
        overflow: body.map((node) => node.overflow),
        visible: body.map((node) => node.visible),
        title: undefined,
        peek: shellPeek,
        chrome: shellOutput,
        hide: shellOutput,
        inner: found.box,
        folded: false
      };
      known.set(block, state);
      owned.add(state);
      found.node.onMouseUp = (event) => {
        if (api.renderer.getSelection?.()?.getSelectedText?.())
          return;
        apply(state, !state.folded);
        event?.stopPropagation?.();
      };
      if (folding)
        apply(state, true);
    }
    function adopt(block) {
      if (adoptDiff(block))
        return;
      if (shell)
        adoptShell(block);
    }
    function sweep() {
      for (const state of owned)
        if (state.block.isDestroyed)
          owned.delete(state);
      if (api.route.current.name !== "session")
        return;
      const box = transcript();
      if (!box)
        return;
      for (const block of scan(box, [], shell)) {
        if (known.has(block))
          continue;
        adopt(block);
      }
    }
    function all(fold) {
      folding = fold;
      const box = transcript();
      if (!box)
        return 0;
      let count = 0;
      for (const block of scan(box, [], shell)) {
        const state = known.get(block);
        if (!state || state.folded === fold)
          continue;
        apply(state, fold);
        count++;
      }
      return count;
    }
    let pending;
    function schedule() {
      if (pending)
        return;
      pending = setTimeout(() => {
        pending = undefined;
        sweep();
      }, 120);
    }
    const offs = [
      api.event.on("message.part.updated", schedule),
      api.event.on("message.updated", schedule)
    ];
    const timer = setInterval(sweep, SWEEP_MS);
    schedule();
    api.keymap.registerLayer({
      mode: "base",
      priority: 100,
      commands: [
        {
          name: "fold_diffs.toggle",
          title: "Fold / unfold file diffs",
          category: "Plugin",
          run() {
            sweep();
            const fold = !folding;
            const changed = all(fold);
            api.ui.toast({
              variant: "info",
              message: changed ? `${fold ? "Folded" : "Unfolded"} ${changed} ${changed === 1 ? "block" : "blocks"}` : `New file blocks will be ${fold ? "folded" : "unfolded"}`,
              duration: 2000
            });
            return true;
          }
        }
      ],
      bindings: opts.key ? [{ key: opts.key, cmd: "fold_diffs.toggle", desc: "Fold / unfold file diffs", preventDefault: true }] : []
    });
    api.lifecycle.onDispose(() => {
      for (const state of owned) {
        if (state.block.isDestroyed)
          continue;
        apply(state, false);
        if (state.inserted)
          state.title.node.destroy();
        if (state.inner)
          state.body[0].onMouseUp = undefined;
        else
          state.block.onMouseUp = undefined;
      }
      owned.clear();
      clearInterval(timer);
      if (pending)
        clearTimeout(pending);
      for (const off of offs)
        if (typeof off === "function")
          off();
    });
  }
};
export {
  fold_diffs_default as default
};

//# debugId=8A1FADD6463BA44064756E2164756E21
