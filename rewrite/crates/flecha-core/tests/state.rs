use flecha_core::storage::{decode, encode};
use flecha_core::{
    ArchivePolicy, BrowserState, CLOSED_WINDOW_LIMIT, CloseTab, FolderId, Placement, Reopened,
    SpaceId, Tab, TabId, WindowId,
};

#[test]
fn today_belongs_to_one_window_and_shared_tabs_have_one_visible_owner() {
    let home = SpaceId::new("home");
    let work = SpaceId::new("work");
    let first = WindowId::new("first");
    let second = WindowId::new("second");
    let favorite = TabId::new("favorite");
    let pin = TabId::new("pin");
    let today = TabId::new("today");
    let folder = FolderId::new("folder");
    let mut state = BrowserState::new(home.clone(), first.clone());
    assert!(state.add_space(work.clone()));
    assert!(state.update_space(
        &work,
        Some(" Work "),
        Some("💼"),
        Some("#AA1122"),
        Some(true)
    ));
    assert_eq!(state.space(&work).unwrap().color, "#aa1122");
    assert!(state.open_window(second.clone(), Some(&work)));
    assert!(state.add_folder(folder.clone(), "Project", &work, None));
    assert!(state.create_tab(
        favorite.clone(),
        Tab::new("https://example.org/", 0),
        Placement::Favorite,
        None
    ));
    assert!(state.create_tab(
        pin.clone(),
        Tab::new("https://example.org/pin", 0),
        Placement::Pinned {
            space: &work,
            folder: Some(&folder)
        },
        None
    ));
    assert!(state.open_today(
        today.clone(),
        Tab::new("https://example.org/today", 1),
        &second,
        None,
        true
    ));
    assert_eq!(state.tab_ids(&first, &work).unwrap(), [&favorite, &pin]);
    assert_eq!(
        state.tab_ids(&second, &work).unwrap(),
        [&favorite, &pin, &today]
    );
    assert_eq!(
        state.activate(&today, &first, Some(2)),
        Some(second.clone())
    );
    assert_eq!(state.activate(&pin, &first, Some(3)), Some(first.clone()));
    assert_eq!(state.window(&first).unwrap().active_space_id, work);
    assert_eq!(
        state.window(&second).unwrap().visible_tabs(),
        std::slice::from_ref(&today)
    );
    assert_eq!(state.activate(&pin, &second, Some(4)), Some(second.clone()));
    assert!(!state.window(&first).unwrap().visible_tabs().contains(&pin));
    assert_eq!(
        state.window(&second).unwrap().visible_tabs(),
        std::slice::from_ref(&pin)
    );
    assert_eq!(
        state.set_isolated(&work, true),
        [pin.clone(), today.clone()]
    );
    assert!(state.space(&work).unwrap().isolated);
    let missing_folder = FolderId::new("missing");
    assert!(!state.place_tab(
        &today,
        Placement::Pinned {
            space: &work,
            folder: Some(&missing_folder)
        },
        None
    ));
    assert_eq!(
        state.locate(&today),
        Some(Placement::Today {
            space: &work,
            window: &second
        })
    );
    assert!(!state.move_folder(&folder, &work, Some(&folder), None));
    assert!(state.move_folder(&folder, &home, None, None));
    assert_eq!(state.space(&home).unwrap().pinned_tabs(), [&pin]);
    assert!(state.delete_folder(&folder, true, 5));
    assert_eq!(state.space(&home).unwrap().pinned_tabs(), [&pin]);
    assert!(state.set_sidebar_visible(&second, false));
    assert!(state.set_sidebar_visible(&first, true));
    assert!(!state.sidebar_visible(&second));
    assert!(state.sidebar_visible(&first));
}

#[test]
fn recency_skips_unseen_tabs_until_control_tab_commits() {
    let space = SpaceId::new("s");
    let window = WindowId::new("w");
    let oldest = TabId::new("oldest");
    let newest = TabId::new("newest");
    let background = TabId::new("background");
    let mut state = BrowserState::new(space, window.clone());
    for (time, id, active) in [
        (1, &oldest, true),
        (2, &newest, true),
        (3, &background, false),
    ] {
        assert!(state.open_today(
            id.clone(),
            Tab::new("https://example.org/", time),
            &window,
            None,
            active
        ));
    }
    assert_eq!(state.recent_tabs(&window).unwrap(), [&oldest, &background]);
    assert_eq!(
        state.activate(&background, &window, None),
        Some(window.clone())
    );
    let mut state = decode(&encode(&state).unwrap()).unwrap();
    assert!(state.tab(&background).unwrap().unseen);
    assert_eq!(
        state.by_recency([&oldest, &newest, &background]),
        [&newest, &oldest, &background]
    );
    assert!(state.touch(&background, 4));
    assert_eq!(
        state.by_recency([&oldest, &newest, &background]),
        [&background, &newest, &oldest]
    );
}

#[test]
fn undo_reopens_whichever_closed_most_recently() {
    let space = SpaceId::new("s");
    let first = WindowId::new("first");
    let second = WindowId::new("second");
    let today = TabId::new("today");
    let tab = TabId::new("tab");
    let favorite = TabId::new("favorite");
    let mut state = BrowserState::new(space.clone(), first.clone());
    assert!(!state.close_window(&first, 0));
    assert!(state.open_window(second.clone(), None));
    assert!(state.open_today(
        today.clone(),
        Tab::new("https://example.org/", 1),
        &second,
        None,
        true
    ));
    assert!(state.open_today(
        tab.clone(),
        Tab::new("https://example.org/closed", 2),
        &first,
        None,
        true
    ));
    assert!(state.create_tab(
        favorite.clone(),
        Tab::new("https://example.org/home", 3),
        Placement::Favorite,
        None
    ));
    state.tab_mut(&favorite).unwrap().url = "https://example.org/somewhere".into();
    assert_eq!(state.close_tab(&favorite, 4), CloseTab::Unloaded);
    assert_eq!(
        state.tab(&favorite).unwrap().url,
        "https://example.org/home"
    );
    assert_eq!(
        state.activate(&favorite, &second, Some(5)),
        Some(second.clone())
    );
    assert!(state.close_window(&second, 6));
    assert!(!state.open_tabs().contains_key(&today));
    assert_eq!(state.close_tab(&tab, 7), CloseTab::Archived);
    let mut state = decode(&encode(&state).unwrap()).unwrap();
    let reopen = TabId::new("reopened");
    assert_eq!(
        state.reopen_last(reopen.clone(), 8),
        Some(Reopened::Tab(reopen.clone()))
    );
    assert_eq!(
        state.tab(&reopen).unwrap().url,
        "https://example.org/closed"
    );
    assert_eq!(
        state.reopen_last(TabId::new("unused"), 9),
        Some(Reopened::Window(second.clone()))
    );
    assert_eq!(state.focused_window().id, second);
    assert_eq!(
        state.focused_window().visible_tabs(),
        std::slice::from_ref(&today)
    );
}

#[test]
fn closed_window_limit_archives_displaced_today_tabs() {
    let window = WindowId::new("main");
    let mut state = BrowserState::new(SpaceId::new("s"), window);
    for n in 0..=CLOSED_WINDOW_LIMIT {
        let window = WindowId::new(format!("window{n}"));
        let tab = TabId::new(format!("tab{n}"));
        assert!(state.open_window(window.clone(), None));
        assert!(state.open_today(
            tab,
            Tab::new(format!("https://example.org/{n}"), 0),
            &window,
            None,
            false
        ));
        assert!(state.close_window(&window, 1));
    }
    assert_eq!(state.closed_windows().len(), CLOSED_WINDOW_LIMIT);
    assert!(state.tab(&TabId::new("tab0")).is_none());
    assert_eq!(state.archive()[0].url, "https://example.org/0");
}

#[test]
fn archive_policy_expires_only_inactive_today_tabs_and_archive_is_searchable() {
    let space = SpaceId::new("s");
    let window = WindowId::new("w");
    let second = WindowId::new("second");
    let selected = TabId::new("selected");
    let pane = TabId::new("pane");
    let stale = TabId::new("stale");
    let edge = TabId::new("edge");
    let mut state = BrowserState::new(space, window.clone());
    assert_eq!(state.settings.archive_policy, ArchivePolicy::HALF_DAY);
    assert_eq!(
        [
            ArchivePolicy::HALF_DAY,
            ArchivePolicy::DAY,
            ArchivePolicy::WEEK,
            ArchivePolicy::THIRTY_DAYS,
            ArchivePolicy::NEVER
        ]
        .map(ArchivePolicy::hours),
        [12.0, 24.0, 168.0, 720.0, 0.0]
    );
    assert!(state.open_window(second.clone(), None));
    for (id, owner, time) in [
        (&pane, &window, 0),
        (&selected, &window, 0),
        (&stale, &second, 0),
        (&edge, &second, 1),
    ] {
        assert!(state.open_today(
            id.clone(),
            Tab::new("https://www.example.org/project/notes", time),
            owner,
            None,
            false
        ));
    }
    assert!(state.set_split(&window, [selected.clone(), pane.clone()]));
    let cutoff = 12 * 60 * 60 * 1000 + 1;
    state.settings.archive_policy = ArchivePolicy::NEVER;
    assert!(state.archive_stale(cutoff).is_empty());
    state.settings.archive_policy = ArchivePolicy::HALF_DAY;
    assert_eq!(state.archive_stale(cutoff), [stale]);
    assert!(state.tab(&edge).is_some());
    assert_eq!(state.search_archive("example project").len(), 1);
    assert!(state.search_archive("unrelated").is_empty());
    assert_eq!(
        state.window(&window).unwrap().visible_tabs(),
        [selected, pane]
    );
}
