use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::shortcuts::Keybindings;

/// Chromium's uncollapsed vertical tab strip bounds, used by sidebarWidth.ts.
pub const SIDEBAR_MIN_WIDTH: u16 = 126;
pub const SIDEBAR_MAX_WIDTH: u16 = 400;
/// Flecha's kFlechaSidebarWidth.
pub const SIDEBAR_DEFAULT_WIDTH: u16 = 260;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SidebarWidth(u16);

impl SidebarWidth {
    pub fn clamp(pixels: f64) -> Option<Self> {
        if pixels.is_nan() {
            return None;
        }
        let rounded = pixels
            .clamp(f64::from(SIDEBAR_MIN_WIDTH), f64::from(SIDEBAR_MAX_WIDTH))
            .round();
        Some(Self(rounded as u16))
    }

    pub fn pixels(self) -> u16 {
        self.0
    }
}

impl Default for SidebarWidth {
    fn default() -> Self {
        Self(SIDEBAR_DEFAULT_WIDTH)
    }
}

/// The presets in Flecha Settings. Existing profiles can also hold custom hours.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ArchivePolicy(f64);

impl ArchivePolicy {
    pub const HALF_DAY: Self = Self(12.0);
    pub const DAY: Self = Self(24.0);
    pub const WEEK: Self = Self(7.0 * Self::DAY.0);
    pub const THIRTY_DAYS: Self = Self(30.0 * Self::DAY.0);
    pub const NEVER: Self = Self(0.0);

    pub fn from_hours(hours: f64) -> Option<Self> {
        (hours.is_finite() && hours >= 0.0).then_some(Self(hours))
    }

    pub fn hours(self) -> f64 {
        self.0
    }
}

impl Default for ArchivePolicy {
    fn default() -> Self {
        Self::HALF_DAY
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchEngine {
    #[default]
    Google,
    DuckDuckGo,
    Bing,
    Brave,
    Kagi,
    Ecosia,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentTarget {
    pub label: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_label: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub targets: Vec<EnvironmentTarget>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionDecision {
    Allow,
    Block,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    pub search_engine: SearchEngine,
    pub sidebar_width: SidebarWidth,
    #[serde(rename = "archiveAfterHours")]
    pub archive_policy: ArchivePolicy,
    pub keybindings: Keybindings,
    pub environments: Vec<Environment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peek_pinned_links: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_links_in_flechinha: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_in_page_fullscreen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads_folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_where_to_save: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ad_block: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ad_block_allowed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onboarded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_permissions: Option<BTreeMap<String, BTreeMap<String, PermissionDecision>>>,
}
