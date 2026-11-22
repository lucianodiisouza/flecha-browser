# Coding-agent tabs

## Sub-features

The agent bridge opens a tab in its folder, works in the background, and keeps other extensions out until the tab leaves the folder.

## How to get to it (user POV)

Open Coding Agents in Settings to enable the bridge. While an agent owns a tab, keep typing in a regular tab and confirm that focus stays there.

## Driving it with the Linux harness

```bash
node chromium/tests/native-agent.mjs "$browser" "$artifacts"
```

The harness uses the bundled host and its own loopback fixtures. Require the `PASS` lines for agent actions, the regular tab retaining keystrokes, and extension isolation. Retain any screenshots and the exit code.

## Gotchas

Use a binary containing patch `0080` for extension isolation. The harness enables the bridge in its own profile. Use that profile for the run.
