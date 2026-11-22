# Flecha on CEF and GPUI: rewrite plan

Status: proposed 2026-11-23. Phase 0 needs approval. Later phases depend on Phase 0 results.

## Decision and what it implies

The owner has decided: Flecha's whole frontend moves to GPUI, the engine moves to CEF through cef-rs, and CEF follows the beta channel.

Hosting CEF inside a window that GPUI owns forces CEF's Alloy style on the platforms that matter most:

- **macOS** (the release platform): CEF 158's `cef_types_mac.h` says "Alloy style will always be used if `windowless_rendering_enabled` is true or if `parent_view` is provided."
- **Native Wayland** (the owner's desktop): stock CEF cannot embed a browser into an existing Wayland window ([#2804](https://github.com/chromiumembedded/cef/issues/2804), [PR #4233](https://github.com/chromiumembedded/cef/pull/4233) is open). The remaining route is off-screen rendering (OSR), and OSR is always Alloy.

Chrome style in a native child window exists only on X11 and Windows. It is not a product option. It stays useful as a control in tests, to tell CEF-wide failures from Alloy-only failures.

So the product is **GPUI drawing every pixel, with each tab an Alloy-style OSR browser whose frames GPUI composites.** Known costs of that, from CEF sources and maintainer statements:

| Area | Alloy OSR behavior | Plan |
|---|---|---|
| Chrome Web Store extensions | Chrome extension API is Chrome-style only. `chrome://extensions` is blocked in Alloy ([#3859](https://github.com/chromiumembedded/cef/issues/3859), [#4255](https://github.com/chromiumembedded/cef/issues/4255)) | Spike 0 measures what actually works |
| Password manager, autofill UI | Unverified for OSR | Spike 0 measures it |
| Permission prompts | CEF denies media and ignores other requests unless the host handles them | Build GPUI prompts |
| Print preview | Disabled for windowless browsers | Use `Print` or a GPUI preview over `PrintToPDF` |
| DevTools | Must open as a separate Chrome-style window ([#4353](https://github.com/chromiumembedded/cef/issues/4353)) | Accept, or build a CDP frontend later |
| Clipboard on Wayland OSR | Copy does not reach the system clipboard ([#4341](https://github.com/chromiumembedded/cef/issues/4341)) | Spike 1 checks it |
| RTX video super resolution | Lives inside Viz (patches 0074, 0076). Prebuilt CEF cannot carry it | Owner decision: drop, defer, or build CEF from source |
| Google sign-in | Google's policy names CEF as blocked ([Google](https://developers.googleblog.com/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/)) | Spike 0 gate |

Google sign-in is why Flecha left Electron. If it fails in Alloy OSR, the rewrite cannot reach parity. User-agent spoofing is out of scope.

## Pins (verified 2026-11-23)

- **CEF:** the newest beta-channel build is `158.0.3+g8c29be2+chromium-158.0.8127.18`. It was published as beta on 2026-11-13 and promoted to stable on 2026-11-20 ([index](https://cef-builds.spotifycdn.com/index.json)). No 159 beta exists yet. Flecha today is on Chromium 158.0.8127.2.
- **cef-rs:** the latest release binds 156.0.31. Open [PR #520](https://github.com/tauri-apps/cef-rs/pull/520) at `32d6bc558545933eb1b4620aac4bc4799299c129` binds 158.0.3. It also has `cef/src/osr_texture_import/` with `dmabuf.rs`, `d3d11.rs` and `iosurface.rs`. It depends on `wgpu = "30"`.
- **GPUI:** Zed revision `f126950f9d3b62666f97437ae5d4ccac2272c4db` (2026-11-22). Its wgpu renderer drops surface batches (`crates/gpui_wgpu/src/wgpu_renderer.rs:1545`, "Surfaces are macOS-only"). Zed pins wgpu to a git revision (`cddb2f5d`), which conflicts with cef-rs's registry wgpu 30.

### Beta channel rule

- Resolve the newest `beta` entry in the CEF index. `download-cef` supports `Channel::Beta`.
- Pin the exact CEF version string and SHA-1 in the repo, together with the cef-rs revision.
- When a new beta appears before cef-rs publishes bindings, regenerate them with cef-rs's own update tooling on a Flecha-owned branch of cef-rs. The update lands only after the Phase 0 sign-in and compositor checks pass on the new build.
- Do not move to a beta until CEF publishes it in the index. Never track CEF master.

## Phase 0: go/no-go spikes

Phase 0 code lives under `rewrite/spikes/` on this branch. `chromium/` stays the shipping browser and is not touched.

### Spike 0: Alloy OSR sign-in and Chrome features (gate)

Build a minimal cef-rs app on the pins above with an Alloy-style OSR browser. Software `OnPaint` into a plain window is enough, so no GPUI work is needed. Use shipping flags: sandbox on, no remote-debugging port or pipe, `navigator.webdriver` false, CEF's default user agent unmodified.

Build the same binary as a windowed Chrome-style browser on X11, as the control.

The owner runs these by hand with a purpose-made Google account. Nothing records credentials. Every check runs in both modes, and the existing Flecha build serves as a reference:

1. Gmail sign-in with MFA, then restart and confirm the session survives.
2. Sign out and sign back in.
3. "Sign in with Google" on a third-party site.
4. Install a real Web Store extension that has a content script and a popup. Check that the content script runs and that the popup can open.
5. Save a password and fill it back in.
6. Grant camera permission through a host prompt.
7. Print.

**Done check:** a table of pass/fail per check per mode, with no account identifiers. If check 1 fails in Alloy OSR, stop and return to the owner.

### Spike 1: compositor and input on real hardware

This needs a GPUI fork with a surface path on Linux. First evaluate [bite-gpui's dma-buf surface](https://github.com/bite-gpui/bite-gpui/pull/10) and [gpui-pre](https://github.com/vegidio/gpui-pre). Write our own patch only if neither fits. Resolve the wgpu version conflict in this spike.

Done check, on the owner's real native Wayland session with NVIDIA, then on X11:

- A moving frame counter page shows no stale or blank frames.
- Resize and a DPI change.
- A GPUI overlay drawn on top of the page.
- `<select>` popup, IME input, and dragging a file in.
- Copying text from the page and pasting it into another app.
- The page and the shell are reachable with the screen reader (Orca).
- CPU, GPU and frame-time numbers, compared with today's Flecha on the same page using `chromium/tests/perf-bench.mjs`.

The macOS IOSurface path needs the owner's MacBook. Windows D3D11 needs a Windows machine; none is known.

### Spike 2: event loop and agent access

- Drive CEF's external message pump from GPUI's main thread. Done check: an idle window uses no measurable CPU, and pages keep animating while GPUI animates.
- Reach a tab through CEF's per-browser DevTools calls (`SendDevToolsMessage`), never a port or pipe. Done check: the page sees `navigator.webdriver === false` while the call runs.

### Phase 0 agent split

- Spike 0: one Opus 5.5 agent builds it. The owner runs the manual checks.
- Spike 1: one GPT 6.2 Sol agent does the GPUI fork evaluation and surface work. One Opus 5.5 agent does CEF OSR, input and IME.
- Spike 2: one Opus 5.5 agent.
- A non-author verifier checks each spike's done check before it counts.

## Later phases (conditional, re-planned after Phase 0)

### Phase 1: vertical slice

Rust workspace `rewrite/` with these crates:

| Crate | Owns |
|---|---|
| `flecha-core` | Durable tab and Space IDs, versioned storage, migration, session restore |
| `flecha-cef` | Browser and request-context handles, CEF callbacks, typed events keyed by tab ID and browser generation |
| `flecha-surface` | Texture import and compositing |
| `flecha-ui` | GPUI windows, sidebar, command bar, focus |
| `flecha-services` | Import, local-server discovery, MCP over loopback with token |

Slice: open a tab, then split it, Peek and promote, move it to Flechinha and back, close, and restart. Separate-cookie Spaces use one persistent `CefRequestContext` per isolated Space. Port existing store and suggestion fixtures. Adapt the native harness assertions to GPUI.

### Phase 2: parallel feature work

Each unit gets its own worktree and PR and integrates through the vertical slice. One owner (the parent agent) keeps the typed event contracts.

- **GPT 6.2 Sol:** core state and migration from today's saved state, command bar and suggestions, Spaces and sidebar UI, history and archive, settings and shortcuts, browser and Arc import (the Node importers stay behind stdio until the Rust port passes their fixtures).
- **Opus 5.5:** CEF lifecycle and popups, downloads with danger decisions, ad blocking with adblock-rust, Boosts injection, permission prompts, the macOS surface and helper bundles, tab sleep, MCP agent server.

### Phase 3: parity and cutover

The owner's workflows pass on installed packages: signed and notarized macOS helpers, the Linux sandbox, restart, update and rollback. Profiles migrate into a new folder, and the old profile stays untouched. The Chromium-fork browser is retired only after the owner accepts.

## What I need from the owner

1. Approval for Phase 0 only.
2. v1 platform scope.
3. The outcome if Alloy OSR sign-in fails in Spike 0.
4. Someone to run Spike 0's manual checks with a purpose-made Google account.
5. Permission to open test windows on the real Wayland session (Spike 1), and someone to confirm what they show.
6. After Spike 0: accept or reject the extension, password and print-preview results.
7. After Spike 0: the VSR decision.

No durations are given. There is no measured basis for them yet.

## Sources

- Independent review by GPT 6.2 Astra: [cef-gpui-astra-review-20261123.md](cef-gpui-astra-review-20261123.md)
