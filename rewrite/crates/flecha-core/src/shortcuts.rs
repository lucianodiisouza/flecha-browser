//! Platform defaults and conflict handling for Electron-style saved accelerators.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;

pub type Keybindings = BTreeMap<String, Option<String>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Platform {
    Linux,
    Mac,
    Windows,
}

#[derive(Clone, Copy, Debug)]
pub struct Shortcut {
    pub id: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub keys: &'static str,
}

const fn shortcut(
    id: &'static str,
    group: &'static str,
    label: &'static str,
    keys: &'static str,
) -> Shortcut {
    Shortcut {
        id,
        group,
        label,
        keys,
    }
}

pub const SHORTCUTS: &[Shortcut] = &[
    shortcut("newTab", "Getting around", "New tab", "CmdOrCtrl+T"),
    shortcut(
        "openLocation",
        "Getting around",
        "Open location",
        "CmdOrCtrl+L",
    ),
    shortcut("back", "Getting around", "Back", "CmdOrCtrl+["),
    shortcut("forward", "Getting around", "Forward", "CmdOrCtrl+]"),
    shortcut("reload", "Getting around", "Reload", "CmdOrCtrl+R"),
    shortcut(
        "hardReload",
        "Getting around",
        "Hard reload",
        "CmdOrCtrl+Shift+R",
    ),
    shortcut("find", "Getting around", "Find in page", "CmdOrCtrl+F"),
    shortcut(
        "toggleSidebar",
        "Getting around",
        "Show or hide the sidebar",
        "CmdOrCtrl+S",
    ),
    shortcut("settings", "Getting around", "Settings", "CmdOrCtrl+,"),
    shortcut("history", "Getting around", "History", "CmdOrCtrl+Y"),
    shortcut(
        "newFlechinha",
        "Tabs",
        "New Flechinha window",
        "Alt+CmdOrCtrl+N",
    ),
    shortcut("closeTab", "Tabs", "Close tab", "CmdOrCtrl+W"),
    shortcut(
        "reopenTab",
        "Tabs",
        "Reopen closed tab",
        "CmdOrCtrl+Shift+T",
    ),
    shortcut("nextTab", "Tabs", "Switch to recent tab", "Ctrl+Tab"),
    shortcut(
        "previousTab",
        "Tabs",
        "Switch to recent tab, backwards",
        "Ctrl+Shift+Tab",
    ),
    shortcut("pinTab", "Tabs", "Pin or unpin tab", "CmdOrCtrl+D"),
    shortcut("duplicateTab", "Tabs", "Duplicate tab", "Alt+CmdOrCtrl+D"),
    shortcut("muteTab", "Tabs", "Mute or unmute tab", "Ctrl+M"),
    shortcut("clearToday", "Tabs", "Clear Today", "CmdOrCtrl+Shift+K"),
    shortcut("copyLink", "Tabs", "Copy link", "CmdOrCtrl+Shift+C"),
    shortcut(
        "copyMarkdown",
        "Tabs",
        "Copy as Markdown link",
        "Alt+CmdOrCtrl+C",
    ),
    shortcut("screenshot", "Tabs", "Copy screenshot", "CmdOrCtrl+Shift+2"),
    shortcut("nextSpace", "Spaces", "Next Space", "Alt+CmdOrCtrl+Right"),
    shortcut(
        "previousSpace",
        "Spaces",
        "Previous Space",
        "Alt+CmdOrCtrl+Left",
    ),
    shortcut("newSpace", "Spaces", "New Space", "Ctrl+Shift+N"),
    shortcut(
        "splitNew",
        "Split & Peek",
        "Split with a new tab",
        "Ctrl+Shift+=",
    ),
    shortcut(
        "exitSplit",
        "Split & Peek",
        "Exit split view",
        "Ctrl+Shift+-",
    ),
    shortcut("zoomIn", "View", "Zoom in", "CmdOrCtrl+="),
    shortcut("zoomOut", "View", "Zoom out", "CmdOrCtrl+-"),
    shortcut("actualSize", "View", "Actual size", "CmdOrCtrl+0"),
    shortcut(
        "devTools",
        "Developer",
        "Developer Tools",
        "Alt+CmdOrCtrl+I",
    ),
    shortcut(
        "responsive",
        "Developer",
        "Responsive view",
        "Alt+CmdOrCtrl+M",
    ),
    shortcut(
        "nextEnvironment",
        "Developer",
        "Next environment",
        "Alt+CmdOrCtrl+E",
    ),
    shortcut(
        "editBoost",
        "Developer",
        "Edit boost for this site",
        "Alt+CmdOrCtrl+B",
    ),
    shortcut("viewSource", "Developer", "View source", "Alt+CmdOrCtrl+U"),
    shortcut(
        "shortcuts",
        "Getting around",
        "Keyboard shortcuts",
        "CmdOrCtrl+/",
    ),
    shortcut("quit", "Getting around", "Quit Flecha", "Ctrl+Shift+Q"),
];

pub fn default_keys(id: &str, platform: Platform) -> Option<&'static str> {
    match (id, platform) {
        ("newSpace", Platform::Linux | Platform::Windows) => Some("Ctrl+Alt+Shift+N"),
        ("history", Platform::Linux | Platform::Windows) => Some("Ctrl+H"),
        ("quit", Platform::Mac) => None,
        _ => SHORTCUTS
            .iter()
            .find(|command| command.id == id)
            .map(|command| command.keys),
    }
}

pub fn fixed_shortcuts(platform: Platform) -> BTreeMap<String, String> {
    let modifier = if platform == Platform::Mac {
        "Ctrl"
    } else {
        "Ctrl+Alt"
    };
    let mut fixed = BTreeMap::from([("CmdOrCtrl+O".into(), "openInFlecha".into())]);
    // The sidebar and Chromium register tab and Space selection for digits 1 through 9.
    for number in 1..=9 {
        fixed.insert(format!("CmdOrCtrl+{number}"), format!("selectTab:{number}"));
        fixed.insert(
            format!("{modifier}+{number}"),
            format!("selectSpace:{number}"),
        );
    }
    fixed
}

pub fn keys_for<'a>(bindings: &'a Keybindings, id: &str, platform: Platform) -> Option<&'a str> {
    let index = SHORTCUTS.iter().position(|command| command.id == id)?;
    match bindings.get(id) {
        Some(None) => None,
        Some(Some(keys)) if !keys.is_empty() => {
            if is_reserved(keys, platform)
                || SHORTCUTS[..index]
                    .iter()
                    .any(|command| custom_matches(bindings, command.id, keys, platform))
            {
                None
            } else {
                Some(keys)
            }
        }
        _ => {
            let fallback = default_keys(id, platform)?;
            (!SHORTCUTS.iter().any(|command| {
                command.id != id && custom_matches(bindings, command.id, fallback, platform)
            }))
            .then_some(fallback)
        }
    }
}

fn custom_matches(bindings: &Keybindings, id: &str, keys: &str, platform: Platform) -> bool {
    bindings
        .get(id)
        .and_then(Option::as_deref)
        .is_some_and(|custom| !custom.is_empty() && same_keys(custom, keys, platform))
}

fn is_reserved(keys: &str, platform: Platform) -> bool {
    fixed_shortcuts(platform)
        .keys()
        .any(|fixed| same_keys(fixed, keys, platform))
}

pub fn shortcut_map(bindings: &Keybindings, platform: Platform) -> BTreeMap<String, String> {
    let mut map = fixed_shortcuts(platform);
    for command in SHORTCUTS {
        if let Some(keys) = keys_for(bindings, command.id, platform) {
            map.insert(keys.into(), command.id.into());
        }
    }
    map
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BindingEdit<'a> {
    Reset,
    Unbind,
    Set(&'a str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BindingError {
    UnknownCommand,
    InvalidAccelerator,
    Reserved,
}

/// Applies the edit and returns the IDs of commands that lost their bindings.
pub fn set_binding(
    bindings: &mut Keybindings,
    id: &str,
    edit: BindingEdit<'_>,
    platform: Platform,
) -> Result<Vec<&'static str>, BindingError> {
    static ACCELERATOR: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:(?:(?:Ctrl|Alt|Shift|Cmd|CmdOrCtrl)\+){1,4}[^+]+|F[0-9]{1,2})$").unwrap()
    });
    if !SHORTCUTS.iter().any(|command| command.id == id) {
        return Err(BindingError::UnknownCommand);
    }
    let default = default_keys(id, platform);
    let keys = match edit {
        BindingEdit::Reset => default,
        BindingEdit::Unbind => {
            bindings.insert(id.into(), None);
            return Ok(Vec::new());
        }
        BindingEdit::Set(keys) if !ACCELERATOR.is_match(keys) => {
            return Err(BindingError::InvalidAccelerator);
        }
        BindingEdit::Set(keys) => Some(keys),
    };
    let mut displaced = Vec::new();
    if let Some(keys) = keys {
        if is_reserved(keys, platform) {
            return Err(BindingError::Reserved);
        }
        for command in SHORTCUTS.iter().filter(|command| command.id != id) {
            let occupied = keys_for(bindings, command.id, platform)
                .is_some_and(|current| same_keys(current, keys, platform))
                || custom_matches(bindings, command.id, keys, platform);
            if occupied {
                bindings.insert(command.id.into(), None);
                displaced.push(command.id);
            }
        }
        if default.is_none_or(|fallback| !same_keys(keys, fallback, platform)) {
            bindings.insert(id.into(), Some(keys.into()));
            return Ok(displaced);
        }
    }
    bindings.remove(id);
    Ok(displaced)
}

pub fn same_keys(a: &str, b: &str, platform: Platform) -> bool {
    let normalize = |keys: &str| {
        let mut parts: Vec<_> = parts(keys, platform).map(str::to_ascii_lowercase).collect();
        parts.sort_unstable();
        parts
    };
    normalize(a) == normalize(b)
}

fn parts(keys: &str, platform: Platform) -> impl DoubleEndedIterator<Item = &str> {
    keys.split('+').map(move |part| match part {
        "CmdOrCtrl" | "CommandOrControl" if platform == Platform::Mac => "Cmd",
        "CmdOrCtrl" | "CommandOrControl" | "Control" => "Ctrl",
        "Command" => "Cmd",
        "Option" => "Alt",
        _ => part,
    })
}

pub fn display_keys(keys: Option<&str>, platform: Platform) -> String {
    let Some(keys) = keys.filter(|keys| !keys.is_empty()) else {
        return String::new();
    };
    let mut parts = parts(keys, platform);
    let key = parts.next_back().unwrap_or_default();
    let modifiers: BTreeSet<_> = parts.collect();
    let ordered = ["Ctrl", "Alt", "Shift", "Cmd"];
    if platform == Platform::Mac {
        let mut label: String = ordered
            .into_iter()
            .zip(['⌃', '⌥', '⇧', '⌘'])
            .filter_map(|(modifier, symbol)| modifiers.contains(modifier).then_some(symbol))
            .collect();
        match key {
            "Left" => label.push('←'),
            "Right" => label.push('→'),
            "Up" => label.push('↑'),
            "Down" => label.push('↓'),
            "Return" | "Enter" => label.push('↩'),
            "Tab" => label.push('⇥'),
            "Space" => label.push_str("Space"),
            "Escape" => label.push_str("Esc"),
            "Backspace" => label.push('⌫'),
            "Delete" => label.push('⌦'),
            "-" => label.push('−'),
            _ => label.push_str(&key.to_uppercase()),
        }
        label
    } else {
        let mut label: Vec<_> = ordered
            .into_iter()
            .filter(|modifier| modifiers.contains(modifier))
            .map(|modifier| if modifier == "Cmd" { "Super" } else { modifier }.to_owned())
            .collect();
        label.push(if key.chars().count() == 1 {
            key.to_uppercase()
        } else {
            key.into()
        });
        label.join("+")
    }
}

pub fn space_shortcut_label(platform: Platform) -> String {
    let modifier = if platform == Platform::Mac {
        "Ctrl"
    } else {
        "Ctrl+Alt"
    };
    format!(
        "{} … {}",
        display_keys(Some(&format!("{modifier}+1")), platform),
        display_keys(Some(&format!("{modifier}+9")), platform)
    )
}
