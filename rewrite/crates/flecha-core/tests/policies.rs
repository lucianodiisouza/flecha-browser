use flecha_core::TabId;
use flecha_core::shortcuts::{
    BindingEdit, BindingError, Keybindings, Platform, display_keys, keys_for, same_keys,
    set_binding, shortcut_map, space_shortcut_label,
};
use flecha_core::sleep::{
    DISCARD_AFTER, DISCARD_AFTER_WALL_CLOCK, FREEZE_AFTER, PROTECTED_RECENT, STATE_DEBOUNCE,
    SleepState, SleepTab, protected_recent, sleep_state,
};

#[test]
fn platform_defaults_register_without_collisions() {
    let bindings = Keybindings::new();
    for platform in [Platform::Mac, Platform::Linux, Platform::Windows] {
        let map = shortcut_map(&bindings, platform);
        for (key, command) in &map {
            for (other, other_command) in &map {
                if key != other {
                    assert!(
                        !same_keys(key, other, platform),
                        "{command} collides with {other_command}"
                    );
                }
            }
        }
        assert_eq!(map["CmdOrCtrl+1"], "selectTab:1");
        let mac = platform == Platform::Mac;
        assert_eq!(
            map[if mac { "Ctrl+1" } else { "Ctrl+Alt+1" }],
            "selectSpace:1"
        );
        assert_eq!(
            map[if mac {
                "Ctrl+Shift+N"
            } else {
                "Ctrl+Alt+Shift+N"
            }],
            "newSpace"
        );
        assert_eq!(
            map.get("Ctrl+Shift+N").map(String::as_str),
            mac.then_some("newSpace")
        );
        assert_eq!(
            map.get("Ctrl+Shift+Q").map(String::as_str),
            (!mac).then_some("quit")
        );
        assert_eq!(map["CmdOrCtrl+,"], "settings");
        assert_eq!(map["Ctrl+Tab"], "nextTab");
        assert_eq!(map["Ctrl+Shift+Tab"], "previousTab");
        assert_eq!(same_keys("CmdOrCtrl+T", "Ctrl+T", platform), !mac);
        assert_eq!(same_keys("CmdOrCtrl+T", "Cmd+T", platform), mac);
    }
    assert_eq!(
        display_keys(Some("Alt+CmdOrCtrl+Shift+T"), Platform::Linux),
        "Ctrl+Alt+Shift+T"
    );
    assert_eq!(
        display_keys(Some("Alt+CmdOrCtrl+Shift+T"), Platform::Mac),
        "⌥⇧⌘T"
    );
    assert_eq!(
        space_shortcut_label(Platform::Linux),
        "Ctrl+Alt+1 … Ctrl+Alt+9"
    );
}

#[test]
fn shortcut_edits_displace_conflicts_and_protect_fixed_families() {
    let linux = Platform::Linux;
    let mut keys = Keybindings::new();
    assert_eq!(
        set_binding(&mut keys, "reload", BindingEdit::Set("Ctrl+T"), linux).unwrap(),
        ["newTab"]
    );
    assert_eq!(keys_for(&keys, "newTab", linux), None);
    for reserved in ["Ctrl+1", "Alt+Ctrl+9", "Ctrl+O"] {
        assert_eq!(
            set_binding(&mut keys, "reload", BindingEdit::Set(reserved), linux),
            Err(BindingError::Reserved)
        );
        assert_eq!(keys_for(&keys, "reload", linux), Some("Ctrl+T"));
    }
    assert_eq!(
        set_binding(&mut keys, "newTab", BindingEdit::Reset, linux).unwrap(),
        ["reload"]
    );
    assert_eq!(keys_for(&keys, "reload", linux), None);
    assert_eq!(keys_for(&keys, "newTab", linux), Some("CmdOrCtrl+T"));
}

#[test]
fn saved_shortcuts_resolve_again_on_a_different_platform() {
    let mut keys = Keybindings::from([
        ("reload".into(), Some("Ctrl+T".into())),
        ("newTab".into(), Some("Ctrl+Alt+1".into())),
    ]);
    assert_eq!(keys_for(&keys, "newTab", Platform::Linux), None);
    assert_eq!(keys_for(&keys, "reload", Platform::Linux), Some("Ctrl+T"));
    keys.remove("newTab");
    assert_eq!(keys_for(&keys, "newTab", Platform::Linux), None);
    assert_eq!(
        keys_for(&keys, "newTab", Platform::Mac),
        Some("CmdOrCtrl+T")
    );
}

#[test]
fn sleep_distinguishes_active_use_and_wall_clock() {
    use SleepState::{Alive, Discarded, Frozen};
    let now = 10 * DISCARD_AFTER_WALL_CLOCK;
    let minute = 60_000;
    let tab = SleepTab {
        last_active: now,
        ..SleepTab::default()
    };
    let frozen = SleepTab {
        state: Frozen,
        ..tab
    };
    assert_eq!(sleep_state(tab, now, FREEZE_AFTER - minute, false), Alive);
    assert_eq!(sleep_state(tab, now, FREEZE_AFTER, false), Frozen);
    assert_eq!(
        sleep_state(frozen, now, DISCARD_AFTER - minute, false),
        Frozen
    );
    assert_eq!(sleep_state(frozen, now, DISCARD_AFTER, false), Discarded);
    let day_idle = SleepTab {
        last_active: now - DISCARD_AFTER_WALL_CLOCK,
        ..tab
    };
    assert_eq!(sleep_state(day_idle, now, 0, false), Discarded);
    assert_eq!(
        sleep_state(
            SleepTab {
                last_active: day_idle.last_active + minute,
                ..tab
            },
            now,
            0,
            false
        ),
        Alive
    );

    let tabs: Vec<_> = (0..12)
        .map(|i| (TabId::new(format!("t{i}")), now - i * minute))
        .collect();
    let kept = protected_recent(tabs.iter().map(|(id, last)| (id, *last)));
    assert_eq!(
        kept,
        tabs.iter()
            .take(PROTECTED_RECENT)
            .map(|(id, _)| id)
            .collect()
    );
    assert_eq!(sleep_state(tab, now, DISCARD_AFTER, true), Frozen);
    assert_eq!(sleep_state(day_idle, now, 0, true), Frozen);
}

#[test]
fn sleep_prioritizes_visibility_media_and_debounce() {
    use SleepState::{Alive, Discarded, Frozen};
    let now = 10 * DISCARD_AFTER_WALL_CLOCK;
    let tab = SleepTab {
        last_active: now,
        ..SleepTab::default()
    };
    for url in [
        "https://www.notion.so/a",
        "https://dev.notion.so/",
        "https://stg.notion.so/x",
        "https://app.notion.com/p",
    ] {
        assert_eq!(
            sleep_state(
                SleepTab {
                    url: Some(url),
                    ..tab
                },
                now,
                DISCARD_AFTER,
                false
            ),
            Alive,
            "{url}"
        );
    }
    for url in [
        "https://notion.so/a",
        "https://www.notion.so.example.com/",
        "https://example.com/?u=https://www.notion.so/",
    ] {
        assert_eq!(
            sleep_state(
                SleepTab {
                    url: Some(url),
                    ..tab
                },
                now,
                DISCARD_AFTER,
                false
            ),
            Discarded,
            "{url}"
        );
    }
    let hidden = SleepTab {
        in_hidden_space: true,
        ..tab
    };
    assert_eq!(sleep_state(hidden, now, 0, false), Frozen);
    assert_eq!(sleep_state(hidden, now, DISCARD_AFTER, false), Discarded);
    assert_eq!(sleep_state(hidden, now, DISCARD_AFTER, true), Frozen);
    for shown in [
        SleepTab {
            shown: true,
            state: Frozen,
            ..tab
        },
        SleepTab { media: true, ..tab },
        SleepTab {
            media: true,
            ..hidden
        },
    ] {
        assert_eq!(sleep_state(shown, now, DISCARD_AFTER, false), Alive);
    }
    let recent_change = SleepTab {
        changed_at: Some(now - STATE_DEBOUNCE + 1),
        ..tab
    };
    assert_eq!(sleep_state(recent_change, now, DISCARD_AFTER, false), Alive);
    let settled = SleepTab {
        changed_at: Some(now - STATE_DEBOUNCE),
        ..tab
    };
    assert_eq!(sleep_state(settled, now, DISCARD_AFTER, false), Discarded);
    assert_eq!(
        sleep_state(
            SleepTab {
                state: Discarded,
                ..tab
            },
            now,
            0,
            false
        ),
        Discarded
    );
}
