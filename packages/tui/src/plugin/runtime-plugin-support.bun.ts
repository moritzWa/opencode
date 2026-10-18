import { ensurePluginRuntime, provides } from "@opencode/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

// Capture the host namespaces before registering bare module providers. Bun can
// native-load extensionless NPM dependencies without hitting OpenTUI's prescan;
// those imports must still resolve to the compiled host, not physical peers.
ensurePluginRuntime({
  "@opentui/core": await import("@opentui/core"),
  "@opentui/core/testing": await import("@opentui/core/testing"),
  "@opentui/solid": await import("@opentui/solid"),
  "@opentui/solid/components": await import("@opentui/solid/components"),
  "@opentui/solid/jsx-runtime": await import("@opentui/solid/jsx-runtime"),
  "@opentui/solid/jsx-dev-runtime": await import("@opentui/solid/jsx-dev-runtime"),
  "solid-js": await import("solid-js"),
  "solid-js/store": await import("solid-js/store"),
})
ensureRuntimePluginSupport({
  additional: {
    "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
  preserve: provides,
})
