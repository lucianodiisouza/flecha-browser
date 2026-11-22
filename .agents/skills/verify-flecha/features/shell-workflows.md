# Shell workflows

## Sub-features

Command bar, spaces and tabs, Settings, bookmarks and browser imports, History, and downloads.

## How to get to it (user POV)

Use the sidebar and command bar to control tabs. Open Settings for imports and preferences, History to find visits, and the sidebar download list for downloads.

## Driving it with the Linux harness

```bash
node chromium/tests/native-workflows.mjs "$browser" "$artifacts"
```

The suite starts a loopback server, seeds import fixtures and drives the extension and browser. Require a `PASS` for each requested journey. The CLI exit code covers the whole suite. Capture the corresponding screenshot and assertion, such as the import appearing in its Space or a downloaded file and its completed status.

## Gotchas

The binary must include the native frame and APIs exercised by the selected journey. A later unrelated failure leaves earlier `PASS` evidence intact and makes the full suite incomplete.
