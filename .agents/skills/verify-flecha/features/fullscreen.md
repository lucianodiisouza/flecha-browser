# Fullscreen and sidebar

## Sub-features

Docked and hidden sidebar, page fullscreen, and explicit browser fullscreen.

## How to get to it (user POV)

Enable the sidebar in page fullscreen under Settings. Enter fullscreen from the page, hide and restore the sidebar, then exit fullscreen. Repeat from an explicitly fullscreen browser window.

## Driving it with the Linux harness

```bash
node chromium/tests/native-fullscreen.mjs "$browser" "$artifacts/fullscreen.png"
```

Require exit code 0. The harness checks the native window state, the page's fullscreen element, and restored window controls, with screenshots in light and dark.

## Gotchas

This harness uses the shell in `chromium/shell/dist`. The native fullscreen patches must match the behavior under test. Screenshot generation alone does not prove the last transition succeeded.
