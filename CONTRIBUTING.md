# Contributing to Flecha

Thanks for looking. Flecha is a young project with a strong opinion about how it should look and feel, so it helps to read this before sending anything.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, your operating system and version, and the Flecha version. A screenshot or a short screen recording helps a lot for anything visual. For a crash, say what the page or action was.

## Setup

Use Node 24 for the repository checks and pre-commit hook. Native setup depends on the platform. The shared Linux build is described below. See [README.md](README.md#build-from-source) for the upstream Apple Silicon macOS setup.

```bash
npm ci
npm run check
```

`npm run check` runs `check:source` and `check:build`. CI uses those same commands, with Node 24 for source checks and Node 26 for bundles. Use the split if building with a cold ad-block cache fails under Node 24.

The hook formats staged configuration and tooling files, then checks an isolated copy of the Git index. `npm run lint:all` shows the full Oxlint report. `npm run lint` requires the checked-in counts by file and rule to match the current findings. When fixing an existing finding, reduce its count or remove the entry from `tools/checks/lint-baseline.json`.

The CI scripts job also runs ShellCheck, pinned actionlint, and `chromium/scripts/check-patches.sh`. See [the workflow](.github/workflows/ci.yml) for the exact commands. The patch check fetches the files needed from `chromium/CHROMIUM_VERSION` and applies the series in order.

The shell and native host can also be checked with the pinned [tsrs compiler](https://github.com/oxc-project/tsrs):

```bash
npm run typecheck:tsrs
```

`npm run check` runs tsrs on Linux x64, Linux arm64 and Apple Silicon macOS, where the pinned package provides binaries. On other platforms the gate logs the skip and still requires `npm run typecheck`. tsrs uses a TypeScript 7.1 development snapshot to check both projects without emitting files.

## Reuse the Linux build across worktrees

The compiled Chromium 158 snapshot lives outside worktrees at `~/flecha-builds/chromium-158-linux/out/Dev`. From a checkout containing this launcher:

```bash
npm ci
npm run browser:linux
```

The launcher rebuilds only that checkout's TypeScript shell and import helper, installs the helper into its `.flecha-profile`, and launches the shared browser with that shell. Each checkout has a separate profile. It refuses a locked profile rather than changing a running session. The shared native output is never built or modified by the launcher.

Use `FLECHA_CHROMIUM_OUT` or `--out` to select another compiled output, and `--profile` for an explicit profile. Both paths must be absolute. For example:

```bash
npm run browser:linux -- --out /absolute/path/to/out/Dev --profile /absolute/path/to/user-data
```

For automated proof in an isolated Linux browser, see [Verify Flecha](.agents/skills/verify-flecha/SKILL.md).

To check that a coding agent works in the background (its tab opens in the agent's folder, its clicks, typing and screenshots leave your tab and keystrokes alone, and other extensions, such as a password manager that adds its own frames to pages, stay out of its tabs but still run in yours), run the agent check against a compiled Linux browser. The browser must include patch 0080 for the extension steps. It uses its own Xvfb display, temporary profile and helper, and needs Xvfb, a C++ compiler and the X11/XTest development libraries:

```bash
npm run shell:build && npm run host:build
node chromium/tests/native-agent.mjs /absolute/path/to/out/Release/chrome [/absolute/path/to/screenshots]
```

Worktrees with native C++ patch changes need a matching native build. Keep using the preserved, already-patched source tree for those incremental builds; the shared snapshot is a runtime and backup, not a replacement source checkout. Do not run the upstream macOS reset/apply scripts against that extracted Linux tree. Windows and macOS need native binaries for their own OS; this snapshot and launcher are Linux-only.

## Two kinds of change

**Shell changes** (anything under `chromium/shell/`, `chromium/shared/` or `chromium/native-host/`) need no Chromium build. This is where most work happens:

```bash
node chromium/shell/build.mjs          # or: npm run shell:watch
chromium/scripts/run.sh                # relaunch the dev build with the new shell
```

**Native changes** (window frame, Peek, extension APIs, anything Chromium itself must do) are patches against the Chromium checkout, kept in `chromium/patches/` as plain unified diffs.

### Writing a patch

1. Run `chromium/scripts/apply.sh` so the checkout has every existing patch.
2. Edit the checkout under `$CHROMIUM_SRC` (see `chromium/scripts/env.sh`).
3. For a change that stands alone, use `git diff > chromium/patches/NNNN-short-name.patch`, containing only your edit. Patches apply in filename order. For a follow-up to an existing patch, regenerate that patch's diff for the files it covers.
4. Run `chromium/scripts/apply.sh` again on its own: it resets every file it touches, then applies all patches in order, so it proves the set still applies cleanly. Without a checkout, `chromium/scripts/check-patches.sh` proves the same against `chromium/CHROMIUM_VERSION`.
5. Build with `chromium/scripts/build.sh` and try it.

Keep a patch small and about one thing. Put a comment at the top of new files, and `// Flecha:` comments at the edits inside Chromium's files, saying why. New code goes in new files where possible, so Chromium upgrades hurt less. Packaging patches are numbered from 0050.

## Style

- Match the naming, structure and formatting of nearby code.
- Comments explain why, not what. A short doc comment on each module and on anything whose reason isn't obvious; none on the obvious.
- No new dependencies without a reason. The shell is bundled by esbuild into an MV3 extension and should stay small.
- Don't copy Arc code, assets or text. Interface ideas are fair game; implementations are our own.

## Design

Flecha's interface has to feel polished, at the level of Arc itself. Spacing, alignment, motion, dark mode and corner radii are part of correctness here. If you change something visible, check it in light and dark, and attach a screenshot to the pull request.

## Commits

Make small, focused commits, one idea each, in conventional style:

```
feat(chromium): the release dmg opens as an installer window
fix(shell): the frame page draws no empty-state card of its own
docs: README lists what the Chromium build has
```

Use `feat`, `fix`, `docs`, `refactor`, `chore`, with a scope (`chromium`, `shell`, `native-host`) when it helps. Say what changed and why in a sentence or two when the title isn't enough. A patch and the shell code that uses it can be separate commits.

## License

By contributing you agree that your work is released under the [MIT license](LICENSE).
