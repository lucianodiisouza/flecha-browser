# Sidebar width persistence

Run `node --test chromium/tests/shell-state-updates.test.mjs` after changing `setSidebarWidth`, `saveNow`, or `persistState` in `chromium/shared/store.ts`.

An older full-state save must never overwrite an acknowledged sidebar width. The test queues one full-state save and one width save in both orders, then explores every success and failure combination at the storage boundary. It calls the real Store, holds each write open with a controlled promise, and checks the bytes sent to storage, the width visible to readers and the change notifications. This model covers those two overlapping requests. Browser delivery and storage service internals are outside its scope.

Replay the test against the parent of `f902dc4` to see the historical failure, where both operations reached storage together. If the protocol changes, rerun both that historical reproduction and the current queue before updating the verified property.
