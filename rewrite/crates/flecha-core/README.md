# flecha-core

`flecha-core` owns durable tab, Space, folder and window IDs, sidebar state, tab placement, selection and recency, session restore, archive and reopen rules, settings, and shortcut resolution. It also parses command-bar searches and developer aliases and evaluates the tab sleep policy. The application supplies IDs and clocks.

## Storage

`storage::encode` writes schema version 3. `storage::migrate_legacy` reads the saved JSON value from a copy or export of a Chromium profile. It accepts versions 1 and 2 and unversioned snapshots. Version 1 moves each Space's Today tabs into a single window. Version 2 carries over each window's own Today tabs, shared pins and Favorites, and recently closed windows.

`storage::load` returns repaired state plus the writes needed to keep damaged and last-good copies. Apply recovery writes in order and call `LoadedState::started` after startup succeeds. The application owns the storage path, atomic writes and error reporting.

## Engine and UI

CEF owns browser handles, cookie stores, page-state restoration, media state, and applying sleep decisions. Migration retains navigation URLs and titles. Chromium's opaque `pageState` and the old agent bridge token are dropped because the new engine and services own those formats and credentials.

GPUI owns command-bar ranking across sources, Peeks, shortcut registration, local date labels and general layout undo. The core retains archive-based reopen and durable closed-window restore. Suggestion request scheduling, cancellation, character-set decoding and cookie policy belong to the HTTP client. Responsive split metadata is migrated. Creating and operating its mirrored browser belongs to the engine and UI.
