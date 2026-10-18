# Compiled TUI plugin runtime ownership

The compiled host uses OpenTUI 0.5.17. A normal NPM consumer can physically install newer peers, including 0.6.6. Those files must remain installed without creating a second renderer, Solid owner tree, or environment registry.

Two loading paths bypassed shared import rewriting:

- A local default re-export bridge could make Bun native-load its NPM target as a nested dependency. That also bypassed the target's reactive JSX compilation.
- The OpenTUI prescan uses URL-style resolution for extensionless imports. `./player` can remain an extensionless URL while Bun actually loads `player.ts`. That transitive native import can reach physical peer modules.

The SDK now accepts additional host-owned exports through its canonical runtime provider. The TUI supplies its bundled OpenTUI/Solid namespaces before loading external plugins. Existing owners cannot be replaced. Pure default re-export bridges first load their dependency through the normal SDK entry loader, then evaluate the bridge normally. No source files are relocated or copied, peer versions are unchanged, and import errors remain visible.

The built-in prompt footer also read `useConfig()` during asynchronous plugin setup, outside its Solid owner. It now reads configuration in the slot render function.

## Verification

The compiled regression uses the same SDK runtime-map build plugin as the production CLI. A tarball is installed with real physical OpenTUI 0.6.6 peers and no source symlinks. It checks constructor/function identity, late SDK initialization, plugin context, reactive painting, the native footer, and both dual `/tui` and dedicated `/v2` entries through direct NPM and local-wrapper paths.

From `packages/tui`, run the self-contained compiled regression through the shared heavy-job wrapper:

```bash
python3 ~/.claude/scripts/heavy-job.py --wait -- \
  bun test --timeout 120000 test/compiled-runtime.test.ts
```

The production regression uses an actual compiled CLI, its normal default command, a real PTY, a headless native terminal decoder, and an isolated HTTP/SSE fixture. It installs the selected profile's exact five archives normally, retains physical 0.6.6 peers, and checks the actual Todo sidebar, prompt footer, and raw Ctrl+S speech action. Speech stays idle with no answer, so it does not synthesize audio or launch a media helper. Profile launch scripts are rejected because they can override isolation.

Set `OPENCODE_COMPILED_CLI` to the native executable built by `packages/cli/script/build.ts`, not a profile launcher. Set `OPENCODE_COMPILED_PROFILE_PACKAGES` to the source profile's read-only `package.json` with archive dependencies:

```bash
python3 ~/.claude/scripts/heavy-job.py --wait -- \
  env OPENCODE_COMPILED_CLI="$OPENCODE_COMPILED_CLI" \
      OPENCODE_COMPILED_PROFILE_PACKAGES="$OPENCODE_COMPILED_PROFILE_PACKAGES" \
  bun test test/compiled-cli-runtime.test.ts --rerun-each 10
```

The original migration binary, SHA-256 `243bf3ea1e506799b0e3ba97ae48be78283c8e114482e69632803d53ec30820c`, reproduced both duplicate environment registration and missing ConfigProvider failures under this isolated production harness. The corrected CLI passed repeated startup and keyboard checks using the unchanged archives and physical peer versions.
