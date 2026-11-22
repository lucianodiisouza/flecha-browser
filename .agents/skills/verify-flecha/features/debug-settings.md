# Debug settings

## Sub-features

The video-buffer workaround takes effect on restart. A launch flag forces it on for that session.

## How to get to it (user POV)

Open Settings, choose Debug, and toggle the video-buffer workaround. Relaunch Flecha and return to the same setting.

## Driving it with the Linux harness

```bash
node chromium/tests/native-debug-settings.mjs "$browser" "$artifacts"
```

The harness clicks the actual Debug toggle, verifies the active state before and after restart, turns it off again, and checks that the forced override protects the toggle. Require exit code 0 and the `PASS` lines for save, relaunch, restart, disable, and override. Review `debug-settings-light.png` and `debug-settings-dark.png` in `$artifacts`.

## Gotchas

The binary must support Debug Settings and the video-buffer diagnostics. The harness exercises the preference and override. Measuring video playback or GPU behavior needs separate hardware verification.
