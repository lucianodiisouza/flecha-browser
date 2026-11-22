---
name: verify-flecha
description: Drive a compiled Flecha Browser on an isolated Linux X display. Use for changes to browser workflows, native settings, fullscreen and the sidebar, or coding-agent tabs that require proof in the running app.
---

# Verify Flecha

1. Select the journey in [the feature map](features/README.md). Use the repository's Linux harnesses from any agent that can run shell commands. Use an absolute path to a Linux Flecha `chrome` binary built against `chromium/CHROMIUM_VERSION`. If the change touches native code, use a binary built with those patches. Matching Chromium versions alone do not establish patch provenance.
2. From the repo root, run `npm ci` and `npm run check:build`. The harnesses load the shell in `chromium/shell/dist`. The agent and broad workflow harnesses also install the freshly bundled native host into their temporary profile.
3. Check the binary and shell before driving the app. Set `browser` to the binary path, then run:

   ```bash
   test -x "$browser" && "$browser" --version
   cat chromium/CHROMIUM_VERSION
   test -s chromium/shell/dist/manifest.json
   command -v Xvfb
   artifacts=$(mktemp -d -t flecha-proof.XXXXXXXX)
   ```

   For the broad workflow and agent checks, also confirm `c++` and the X11 and XTest development libraries are available. The harness compiles `chromium/tests/x11-input.cc` in its scratch profile.
4. Run the feature's command and retain its exit code and `PASS` lines. The harness starts its own Xvfb, browser and temporary profile. The feature's first `PASS` confirms a usable session. On a stall, record the last `PASS` and the pending step. For changes to the sidebar save queue, also run the [persistence check](features/persistence.md).
5. Confirm the command exits and the evidence remains under `$artifacts`. The harness owns browser and Xvfb cleanup. To cancel, send Ctrl+C to the harness and wait for it to exit. Keep the proof directory and leave the user's browser and profile alone.
