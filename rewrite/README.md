# Flecha rewrite: GPUI frontend on CEF

The plan, the decisions behind it, and what each phase must prove are in [docs/cef-gpui-rewrite-plan.md](../docs/cef-gpui-rewrite-plan.md). `chromium/` is still the shipping browser. Nothing here changes it.

## Layout

- `pins.toml`: CEF, cef-rs and GPUI versions. All crates use these pins.
- `crates/<name>`: product crates (`flecha-core`, `flecha-cef`, `flecha-surface`, `flecha-ui`, `flecha-services`).
- `spikes/<name>`: Phase 0 go/no-go spikes. Each spike has a `REPORT.md` with its done check and results.

A unit adds its crate path to `members` in `Cargo.toml`.

## Building on the workstation

The workstation runs one heavy build at a time. Every `cargo build`, `cargo test` or `cargo run` that compiles CEF or GPUI waits for a shared lock and runs in the agent build slice:

```sh
flock "$XDG_RUNTIME_DIR/flecha-rewrite-build.lock" \
  bash ~/.claude/skills/hosts/scripts/agent-build run cargo build -j 14
```

Run it from `rewrite/`, with Cargo's target dir left at `rewrite/target`. If a build is killed for memory, check `free -g` before retrying.

## Running windows

Never open a test window on the owner's desktop session. Use Xvfb for X11, or a headless Wayland compositor (for example `weston --backend=headless`) with its own `WAYLAND_DISPLAY`. Stop the compositors and browsers you start by PID.
