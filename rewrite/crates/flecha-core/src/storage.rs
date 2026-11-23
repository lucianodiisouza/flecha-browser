//! JSON snapshots and recovery decisions. The application owns reads, writes and startup.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, value::RawValue};

use crate::state::DEFAULT_SPACE_COLOR;
use crate::{
    ArchivePolicy, ArchivedTab, BrowserState, ClosedWindow, Device, Environment, EnvironmentTarget,
    EpochMillis, FolderId, PinnedNode, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, Settings,
    SidebarWidth, Space, SpaceId, Tab, TabId, Window, WindowId, WindowSpace,
};

/// The first Rust snapshot format. Versions 1 and 2 refer to the Chromium shell.
pub const SCHEMA_VERSION: u64 = 3;

#[derive(Debug)]
pub enum DecodeError {
    Json(serde_json::Error),
    InvalidShape,
    UnsupportedVersion(u64),
    AlreadyMigrated,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "invalid state JSON: {error}"),
            Self::InvalidShape => f.write_str("state has no usable Spaces or tab map"),
            Self::UnsupportedVersion(version) => write!(f, "unsupported state schema {version}"),
            Self::AlreadyMigrated => f.write_str("expected a Chromium shell state copy"),
        }
    }
}

impl std::error::Error for DecodeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

pub fn encode(state: &BrowserState) -> serde_json::Result<String> {
    #[derive(Serialize)]
    struct Snapshot<'a> {
        version: u64,
        #[serde(flatten)]
        state: &'a BrowserState,
    }

    serde_json::to_string_pretty(&Snapshot {
        version: SCHEMA_VERSION,
        state,
    })
}

pub fn decode(json: &str) -> Result<BrowserState, DecodeError> {
    decode_document(json, false)
}

/// Migrates the JSON state value from a copied Chromium profile or export.
pub fn migrate_legacy(copy: &str) -> Result<BrowserState, DecodeError> {
    decode_document(copy, true)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Slot {
    Current,
    LastGood,
    Damaged,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BackupWrite {
    pub slot: Slot,
    pub value: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Recovery {
    LastGood,
    Fresh,
}

#[derive(Debug)]
pub struct LoadedState {
    pub state: Option<BrowserState>,
    pub recovered: Option<Recovery>,
    /// Apply in this order. A failed backup write does not invalidate the loaded state.
    pub recovery_writes: Vec<BackupWrite>,
    last_good_after_start: Option<BackupWrite>,
}

impl LoadedState {
    /// Promote the repaired startup snapshot only after the application starts successfully.
    /// This is the original startup state, regardless of subsequent runtime edits.
    pub fn started(&mut self) -> Option<BackupWrite> {
        self.last_good_after_start.take()
    }
}

/// Read the two stored JSON strings or retain the exact damaged value if it was not a string.
/// A newer schema is surfaced as an error so an older binary cannot overwrite it.
pub fn load(saved: Option<&Value>, last_good: Option<&Value>) -> Result<LoadedState, DecodeError> {
    let mut loaded = LoadedState {
        state: None,
        recovered: None,
        recovery_writes: Vec::new(),
        last_good_after_start: None,
    };
    let Some(saved) = saved else {
        return Ok(loaded);
    };
    if let Some(state) = readable(saved)? {
        let repaired = Value::String(encode(&state).map_err(DecodeError::Json)?);
        if last_good != Some(&repaired) {
            loaded.last_good_after_start = Some(BackupWrite {
                slot: Slot::LastGood,
                value: repaired,
            });
        }
        loaded.state = Some(state);
        return Ok(loaded);
    }

    loaded.recovery_writes.push(BackupWrite {
        slot: Slot::Damaged,
        value: saved.clone(),
    });
    if let Some(copy) = last_good
        && let Some(fallback) = readable(copy)?
    {
        loaded.state = Some(fallback);
        loaded.recovered = Some(Recovery::LastGood);
        loaded.recovery_writes.push(BackupWrite {
            slot: Slot::Current,
            value: copy.clone(),
        });
    } else {
        loaded.recovered = Some(Recovery::Fresh);
    }
    Ok(loaded)
}

fn readable(value: &Value) -> Result<Option<BrowserState>, DecodeError> {
    match value.as_str().map(decode) {
        Some(Ok(state)) => Ok(Some(state)),
        Some(Err(error @ DecodeError::UnsupportedVersion(_))) => Err(error),
        _ => Ok(None),
    }
}

fn decode_document(json: &str, legacy_only: bool) -> Result<BrowserState, DecodeError> {
    // RawValue scans nested values without constructing a recursive tree. Apply the
    // default recursion limit when materializing each recognized field below.
    let fields: BTreeMap<String, &RawValue> =
        serde_json::from_str(json).map_err(DecodeError::Json)?;
    if let Some(version) = fields.get("version") {
        let version: Value = serde_json::from_str(version.get()).map_err(DecodeError::Json)?;
        match version.as_u64().or_else(|| match version.as_f64() {
            Some(1.0) => Some(1),
            Some(2.0) => Some(2),
            Some(3.0) => Some(SCHEMA_VERSION),
            _ => None,
        }) {
            Some(1 | 2) => {}
            Some(SCHEMA_VERSION) if legacy_only => return Err(DecodeError::AlreadyMigrated),
            Some(SCHEMA_VERSION) => {}
            Some(version) => return Err(DecodeError::UnsupportedVersion(version)),
            None => return Err(DecodeError::InvalidShape),
        }
    }
    let mut raw = Map::new();
    for key in [
        "tabs",
        "spaces",
        "activeSpaceId",
        "windows",
        "closedWindows",
        "favorites",
        "archive",
        "sidebarVisible",
        "sidebarWidth",
        "theme",
        "searchEngine",
        "archiveAfterHours",
        "keybindings",
        "environments",
        "window",
        "peekPinnedLinks",
        "openLinksInFlechinha",
        "sidebarInPageFullscreen",
        "downloadsFolder",
        "askWhereToSave",
        "adBlock",
        "adBlockAllowed",
        "onboarded",
        "sitePermissions",
    ] {
        if let Some(value) = fields.get(key) {
            raw.insert(
                key.into(),
                serde_json::from_str(value.get()).map_err(DecodeError::Json)?,
            );
        }
    }
    repair(raw).ok_or(DecodeError::InvalidShape)
}

fn repair(mut raw: Map<String, Value>) -> Option<BrowserState> {
    let raw_tabs = raw.remove("tabs")?;
    let tabs: BTreeMap<_, _> = raw_tabs
        .as_object()?
        .iter()
        .filter_map(|(id, tab)| Some((TabId::new(id), repair_tab(tab)?)))
        .collect();
    let raw_spaces = raw.remove("spaces")?;
    let mut seen_spaces = BTreeSet::new();
    let raw_spaces: Vec<_> = raw_spaces
        .as_array()?
        .iter()
        .filter_map(|space| {
            let id = SpaceId::new(space.get("id")?.as_str()?);
            seen_spaces.insert(id.clone()).then_some((id, space))
        })
        .collect();
    let first_space = raw_spaces.first()?.0.clone();
    let mut placed = BTreeSet::new();
    let mut claim = |value: &Value| {
        let id = TabId::new(value.as_str()?);
        (tabs.contains_key(&id) && placed.insert(id.clone())).then_some(id)
    };
    let favorites = list(raw.get("favorites")).filter_map(&mut claim).collect();
    let mut folders = BTreeSet::new();
    let spaces = raw_spaces
        .iter()
        .map(|(id, space)| repair_space(id, space, &mut folders, &mut claim))
        .collect();

    let legacy;
    let raw_windows = match raw.get("windows").and_then(Value::as_array) {
        Some(windows) => windows.as_slice(),
        None => {
            let spaces = raw_spaces
                .iter()
                .map(|(id, space)| (id.as_str().into(), (*space).clone()))
                .collect();
            let mut win = Map::new();
            win.insert("spaces".into(), Value::Object(spaces));
            if let Some(active) = raw.get("activeSpaceId") {
                win.insert("activeSpaceId".into(), active.clone());
            }
            legacy = [Value::Object(win)];
            &legacy
        }
    };
    let input_closed = || {
        list(raw.get("closedWindows")).filter_map(|win| Some((millis(win.get("closedAt")?)?, win)))
    };
    let reserved: BTreeSet<_> = raw_windows
        .iter()
        .chain(input_closed().map(|(_, win)| win))
        .filter_map(|win| win.get("id")?.as_str())
        .collect();
    let mut assigned = BTreeSet::new();
    let mut sequence = 0;
    let mut window = |value: &Value| {
        let genuine = value.get("id").and_then(Value::as_str).map(WindowId::new);
        let id = genuine
            .filter(|id| assigned.insert(id.clone()))
            .unwrap_or_else(|| {
                loop {
                    sequence += 1;
                    let id = format!("recovered-window-{sequence}");
                    if !reserved.contains(id.as_str()) {
                        break WindowId::new(id);
                    }
                }
            });
        repair_window(value, id, &seen_spaces, &first_space, &mut claim)
    };
    let mut windows: Vec<_> = raw_windows
        .iter()
        .filter(|value| value.is_object())
        .map(&mut window)
        .collect();
    if windows.is_empty() {
        windows.push(window(&Value::Null));
    }
    let closed_windows = input_closed()
        .map(|(closed_at, value)| ClosedWindow {
            window: window(value),
            closed_at,
        })
        .filter(|closed| !closed.window.spaces.is_empty())
        .collect();
    let archive = list(raw.get("archive"))
        .filter_map(|entry| {
            Some(ArchivedTab {
                url: entry.get("url")?.as_str()?.into(),
                title: entry.get("title")?.as_str()?.into(),
                closed_at: millis(entry.get("closedAt")?)?,
            })
        })
        .collect();
    let sidebar_visible = raw
        .get("sidebarVisible")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let settings = repair_settings(&mut raw);
    let mut state = BrowserState {
        spaces,
        windows,
        closed_windows,
        favorites,
        tabs,
        archive,
        sidebar_visible,
        settings,
    };
    state.repair_selections();
    normalize_mobile(&mut state);
    state.repair_visible_tabs();
    Some(state)
}

fn repair_tab(raw: &Value) -> Option<Tab> {
    let mut tab = Tab::new(raw.get("url")?.as_str()?, 0);
    if let Some(title) = raw.get("title").and_then(Value::as_str) {
        tab.title = title.into();
    }
    tab.last_active = raw
        .get("lastActive")
        .and_then(coerce_millis)
        .unwrap_or_default();
    tab.favicon = field(raw, "favicon");
    tab.custom_title = field(raw, "customTitle");
    tab.muted = field(raw, "muted");
    tab.device = field(raw, "device");
    tab.home_url = field(raw, "homeUrl");
    tab.unseen = field(raw, "unseen").unwrap_or_default();
    tab.agent = field(raw, "agent").unwrap_or_default();
    tab.history = raw.get("history").and_then(|history| {
        let entries = history.get("entries")?.as_array()?;
        if entries
            .iter()
            .all(|entry| entry.get("pageState").is_none_or(Value::is_string))
        {
            serde_json::from_value(history.clone()).ok()
        } else {
            None
        }
    });
    Some(tab)
}

fn repair_space(
    id: &SpaceId,
    raw: &Value,
    folders: &mut BTreeSet<FolderId>,
    claim: &mut impl FnMut(&Value) -> Option<TabId>,
) -> Space {
    Space {
        id: id.clone(),
        name: field(raw, "name").unwrap_or_else(|| "Space".into()),
        emoji: field(raw, "emoji"),
        color: field(raw, "color").unwrap_or_else(|| DEFAULT_SPACE_COLOR.into()),
        isolated: field(raw, "isolated").unwrap_or_default(),
        pinned_collapsed: field(raw, "pinnedCollapsed").unwrap_or_default(),
        pinned: repair_pins(raw.get("pinned"), folders, claim),
    }
}

fn repair_pins(
    raw: Option<&Value>,
    folders: &mut BTreeSet<FolderId>,
    claim: &mut impl FnMut(&Value) -> Option<TabId>,
) -> Vec<PinnedNode> {
    list(raw)
        .filter_map(|node| match node.get("kind")?.as_str()? {
            "tab" => Some(vec![PinnedNode::Tab {
                tab_id: claim(node.get("tabId")?)?,
            }]),
            "folder" => {
                let id = FolderId::new(node.get("id")?.as_str()?);
                let first = folders.insert(id.clone());
                let children = repair_pins(node.get("children"), folders, claim);
                if first {
                    Some(vec![PinnedNode::Folder {
                        id,
                        name: field(node, "name").unwrap_or_else(|| "Folder".into()),
                        open: field(node, "open").unwrap_or_default(),
                        children,
                    }])
                } else {
                    Some(children)
                }
            }
            _ => None,
        })
        .flatten()
        .collect()
}

fn repair_window(
    raw: &Value,
    id: WindowId,
    spaces: &BTreeSet<SpaceId>,
    first: &SpaceId,
    claim: &mut impl FnMut(&Value) -> Option<TabId>,
) -> Window {
    let active_space_id = field::<SpaceId>(raw, "activeSpaceId")
        .filter(|id| spaces.contains(id))
        .unwrap_or_else(|| first.clone());
    let spaces = raw
        .get("spaces")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, ws)| {
            let id = SpaceId::new(id);
            if !spaces.contains(&id) || !ws.is_object() {
                return None;
            }
            Some((
                id,
                WindowSpace {
                    today: list(ws.get("today")).filter_map(&mut *claim).collect(),
                    active_tab_id: field(ws, "activeTabId"),
                    split: field(ws, "split"),
                    split_mode: field(ws, "splitMode"),
                    split_ratio: field::<f64>(ws, "splitRatio")
                        .filter(|ratio| *ratio > 0.0 && *ratio < 1.0),
                },
            ))
        })
        .collect();
    Window {
        id,
        active_space_id,
        spaces,
        sidebar_visible: field(raw, "sidebarVisible"),
    }
}

fn normalize_mobile(state: &mut BrowserState) {
    let mut mirrors = BTreeSet::new();
    for ws in state
        .windows
        .iter_mut()
        .flat_map(|win| win.spaces.values_mut())
    {
        if ws.split_mode.is_none() {
            continue;
        }
        if let Some([_, phone]) = &ws.split
            && ws.today.contains(phone)
            && state
                .tabs
                .get(phone)
                .is_some_and(|tab| tab.device == Some(Device::Mobile))
        {
            mirrors.insert(phone.clone());
        } else {
            ws.split_mode = None;
        }
    }
    for closed in &mut state.closed_windows {
        closed.window.spaces.retain(|_, ws| {
            if ws.split_mode.take().is_some()
                && let Some([desktop, phone]) = ws.split.take()
                && ws.today.contains(&phone)
                && state
                    .tabs
                    .get(&phone)
                    .is_some_and(|tab| tab.device == Some(Device::Mobile))
            {
                ws.today.retain(|id| *id != phone);
                state.tabs.remove(&phone);
                if ws.active_tab_id == Some(phone) && ws.today.contains(&desktop) {
                    ws.active_tab_id = Some(desktop);
                }
            }
            if ws
                .active_tab_id
                .as_ref()
                .is_none_or(|id| !ws.today.contains(id))
            {
                ws.active_tab_id = ws
                    .today
                    .iter()
                    .min_by_key(|id| {
                        state
                            .tabs
                            .get(id)
                            .map(|tab| (tab.unseen, std::cmp::Reverse(tab.last_active)))
                    })
                    .cloned();
            }
            !ws.today.is_empty()
        });
    }
    state
        .closed_windows
        .retain(|closed| !closed.window.spaces.is_empty());
    for (id, tab) in &mut state.tabs {
        if !mirrors.contains(id) {
            tab.device = None;
        }
    }
}

fn repair_settings(raw: &mut Map<String, Value>) -> Settings {
    fn take<T: DeserializeOwned>(raw: &mut Map<String, Value>, key: &str) -> Option<T> {
        serde_json::from_value(raw.remove(key)?).ok()
    }

    Settings {
        sidebar_width: take::<f64>(raw, "sidebarWidth")
            .filter(|width| {
                (f64::from(SIDEBAR_MIN_WIDTH)..=f64::from(SIDEBAR_MAX_WIDTH)).contains(width)
            })
            .and_then(SidebarWidth::clamp)
            .unwrap_or_default(),
        theme: take(raw, "theme").unwrap_or_default(),
        search_engine: take(raw, "searchEngine").unwrap_or_default(),
        archive_policy: take(raw, "archiveAfterHours")
            .and_then(ArchivePolicy::from_hours)
            .unwrap_or_default(),
        keybindings: take(raw, "keybindings").unwrap_or_default(),
        environments: raw
            .remove("environments")
            .and_then(repair_environments)
            .unwrap_or_default(),
        window: raw
            .get("window")
            .filter(|window| window.get("maximized").is_none_or(Value::is_boolean))
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        peek_pinned_links: take(raw, "peekPinnedLinks"),
        open_links_in_flechinha: take(raw, "openLinksInFlechinha"),
        sidebar_in_page_fullscreen: take(raw, "sidebarInPageFullscreen"),
        downloads_folder: take(raw, "downloadsFolder"),
        ask_where_to_save: take(raw, "askWhereToSave"),
        ad_block: take(raw, "adBlock"),
        ad_block_allowed: take::<Vec<String>>(raw, "adBlockAllowed").filter(|hosts| {
            hosts.iter().all(|host| {
                host.split('.').all(|label| {
                    !label.is_empty()
                        && label
                            .bytes()
                            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')
                })
            })
        }),
        onboarded: take(raw, "onboarded"),
        site_permissions: take(raw, "sitePermissions"),
    }
}

fn repair_environments(raw: Value) -> Option<Vec<Environment>> {
    raw.as_array()?
        .iter()
        .map(|env| {
            Some(Environment {
                id: field(env, "id")?,
                name: field(env, "name")?,
                targets: env
                    .get("targets")?
                    .as_array()?
                    .iter()
                    .map(|target| {
                        Some(EnvironmentTarget {
                            label: field(target, "label")?,
                            origin: field(target, "origin")?,
                            auto_label: field(target, "autoLabel"),
                        })
                    })
                    .collect::<Option<_>>()?,
            })
        })
        .collect()
}

fn list(value: Option<&Value>) -> impl Iterator<Item = &Value> {
    value.and_then(Value::as_array).into_iter().flatten()
}

fn field<T: DeserializeOwned>(value: &Value, key: &str) -> Option<T> {
    T::deserialize(value.get(key)?).ok()
}

fn millis(value: &Value) -> Option<EpochMillis> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|time| time as EpochMillis))
}

fn coerce_millis(value: &Value) -> Option<EpochMillis> {
    if let Some(text) = value.as_str() {
        let text = text.trim();
        for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
            if let Some(digits) = text
                .strip_prefix(prefix)
                .or_else(|| text.strip_prefix(&prefix.to_ascii_uppercase()))
            {
                return EpochMillis::from_str_radix(digits, radix).ok();
            }
        }
        return text
            .parse::<f64>()
            .ok()
            .filter(|time| time.is_finite())
            .map(|time| time as EpochMillis);
    }
    value
        .as_bool()
        .map(EpochMillis::from)
        .or_else(|| millis(value))
}
