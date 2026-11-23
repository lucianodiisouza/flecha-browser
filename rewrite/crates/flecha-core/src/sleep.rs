//! Pure tab sleep policy. The engine supplies active-use time and applies its decisions.

use std::cmp::Reverse;
use std::collections::BTreeSet;

use crate::{EpochMillis, TabId};

// Policy values come from chromium/shared/tabSleep.ts.
pub const FREEZE_AFTER: EpochMillis = 30 * 60_000;
pub const DISCARD_AFTER: EpochMillis = 4 * 60 * 60_000;
pub const DISCARD_AFTER_WALL_CLOCK: EpochMillis = 24 * 60 * 60_000;
pub const PROTECTED_RECENT: usize = 10;
pub const STATE_DEBOUNCE: EpochMillis = 60_000;
pub const EVALUATE_EVERY: EpochMillis = 5 * 60_000;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SleepState {
    #[default]
    Alive,
    Frozen,
    Discarded,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SleepTab<'a> {
    pub url: Option<&'a str>,
    pub last_active: EpochMillis,
    pub used_at: EpochMillis,
    pub shown: bool,
    pub in_hidden_space: bool,
    pub media: bool,
    pub state: SleepState,
    pub changed_at: Option<EpochMillis>,
}

pub fn protected_recent<'a>(
    tabs: impl IntoIterator<Item = (&'a TabId, EpochMillis)>,
) -> BTreeSet<&'a TabId> {
    let mut tabs: Vec<_> = tabs.into_iter().collect();
    tabs.sort_by_key(|&(_, last_active)| Reverse(last_active));
    tabs.into_iter()
        .take(PROTECTED_RECENT)
        .map(|(id, _)| id)
        .collect()
}

pub fn sleep_state(
    tab: SleepTab<'_>,
    now: EpochMillis,
    active_use: EpochMillis,
    protected: bool,
) -> SleepState {
    let blocklisted = tab.url.is_some_and(|url| {
        [
            "https://www.notion.so/",
            "https://dev.notion.so/",
            "https://stg.notion.so/",
            "https://app.notion.com/",
        ]
        .iter()
        .any(|prefix| url.starts_with(prefix))
    });
    if tab.shown || tab.media || blocklisted {
        return SleepState::Alive;
    }
    if tab.state == SleepState::Discarded
        || tab
            .changed_at
            .is_some_and(|changed| now.saturating_sub(changed) < STATE_DEBOUNCE)
    {
        return tab.state;
    }
    let idle = active_use.saturating_sub(tab.used_at);
    if idle >= DISCARD_AFTER || now.saturating_sub(tab.last_active) >= DISCARD_AFTER_WALL_CLOCK {
        if protected {
            SleepState::Frozen
        } else {
            SleepState::Discarded
        }
    } else if tab.in_hidden_space || idle >= FREEZE_AFTER {
        SleepState::Frozen
    } else {
        SleepState::Alive
    }
}
