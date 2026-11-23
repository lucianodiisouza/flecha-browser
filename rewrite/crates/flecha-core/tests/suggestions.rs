use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use flecha_core::suggestions::{
    EnvironmentTone, MAX_SUGGESTIONS, MatchQuality, SuggestionAction, describe_environment,
    developer_suggestions, format_targets, match_quality, parse_suggestions, parse_targets,
    resolve_input, suggestable,
};
use flecha_core::{Environment, SearchEngine};
use serde_json::{Value, json};

#[test]
fn parses_each_engine_response_and_filters_unsuitable_rows() {
    let google = r#"["githu",["github","https://github.com/","github copilot"],["","GitHub",""],[],{"google:suggesttype":["QUERY","NAVIGATION","QUERY"]}]"#;
    let calculator = r#"["1+1",["= 2","1+1 math"],["Calculator",""],[],{"google:suggesttype":["CALCULATOR","QUERY"]}]"#;
    let bing = r#"["weather",["weather","weather stockholm"],[],[],{"google:suggestrelevance":[1300,1299]}]"#;
    let list = r#"["weather",["weather radar","Weather Radar","weather online"]]"#;
    assert_eq!(
        parse_suggestions(google, "githu"),
        ["github", "github copilot"]
    );
    assert_eq!(parse_suggestions(calculator, "1+1"), ["1+1 math"]);
    assert_eq!(parse_suggestions(bing, "weather"), ["weather stockholm"]);
    assert_eq!(
        parse_suggestions(list, "weather"),
        ["weather radar", "weather online"]
    );
    assert_eq!(parse_suggestions(")]}'\n[\"a\",[\"ab\"]]", "a"), ["ab"]);
    assert_eq!(
        parse_suggestions(r#"["a",[1,null,{"q":"x"},"ab"],null,null,"meta"]"#, "a"),
        ["ab"]
    );
    for body in [
        r#"["weathe",["weather"]]"#,
        "not json",
        r#"{"a":1}"#,
        r#"["a","b"]"#,
    ] {
        assert!(parse_suggestions(body, "a").is_empty(), "{body}");
    }
    let entries: Vec<_> = (0..15).map(|i| format!("q {i}")).collect();
    assert_eq!(
        parse_suggestions(&json!(["q", entries]).to_string(), "q").len(),
        MAX_SUGGESTIONS
    );
    for engine in [
        SearchEngine::Google,
        SearchEngine::DuckDuckGo,
        SearchEngine::Bing,
        SearchEngine::Brave,
        SearchEngine::Kagi,
        SearchEngine::Ecosia,
    ] {
        let url = engine.suggestion_url("café").unwrap();
        assert!(url.starts_with("https://") && url.contains("caf%C3%A9"));
        assert_eq!(engine.suggestion_url("https://example.test/private"), None);
    }
    assert_eq!(
        SearchEngine::DuckDuckGo.search_url("github.com"),
        "https://duckduckgo.com/?q=github.com"
    );
    assert_eq!(
        resolve_input("github.com", SearchEngine::DuckDuckGo),
        "https://github.com"
    );
}

#[test]
fn suggestion_requests_keep_private_input_local() {
    for (query, expected) in [
        ("github.com", false),
        ("https://example.com/a?b", false),
        ("localhost:3000", false),
        ("chrome://settings", false),
        ("about:blank", false),
        ("file:///etc/passwd", false),
        ("javascript:alert(1)", false),
        ("mailto:a@b.c", false),
        ("/home/me/notes.txt", false),
        ("~/notes", false),
        ("./x", false),
        ("\\\\server\\share", false),
        ("C:\\Users\\me", false),
        ("  ", false),
        ("example.com?token=secret", false),
        ("example.com#section", false),
        ("example.com:8443", false),
        ("me@example.com", false),
        ("user:password@example.com", false),
        ("192.168.1.10/private", false),
        ("192.168.1.10", false),
        ("10.0.0.1:8080", false),
        ("[::1]:3000", false),
        ("intranet.example.local/wiki", false),
        ("bücher.de/konto", false),
        ("chrome:", false),
        ("view-source:example.com", false),
        ("example.com.?token=secret", false),
        ("127.1/private?token=secret", false),
        ("0x7f.1", false),
        ("example。com?token=secret", false),
        ("intranet/wiki", false),
        ("intranet:8080", false),
        ("example.com?token=secret more words", false),
        ("me@example.com hello", false),
        ("mailto:someone", false),
        ("example.com/private/.. hello", false),
        ("example.com:80 hello", false),
        ("example.com:080 hello", false),
        ("example.com/%2e%2e hello", false),
        ("[::1]:80 hello", false),
        ("localhost:80 hello", false),
        ("intranet/private/..", false),
        ("intranet/%2e%2e", false),
        ("intranet\\private\\..", false),
        ("intranet/", false),
        ("example.com\n/private?token=secret", false),
        ("example.com\t/private", false),
        ("notes user:secret@host hello", false),
        ("user:secret@host hello", false),
        ("https:example.com/private?token=secret words", false),
        ("see example.com?token=secret", false),
        ("site:example.com cats", false),
        ("chrome:", false),
        ("%65xample%2ecom", false),
        ("%65xample%2ecom/private", false),
        ("notes 127.0.0.1:8080", false),
        ("notes 127.1:80", false),
        ("notes 127.0.0.1/80", false),
        ("notes %65xample%2ecom%3Fq", false),
        ("see 10.0.0.1:22 now", false),
        ("notes 127.0.0.1", false),
        ("notes 127。0。0。1", false),
        ("notes 0x7f.0.0.1", false),
        ("2130706433:80", false),
        ("notes 2130706433:80", false),
        ("notes 2130706433/80", false),
        ("notes 017700000001:80", false),
        ("notes intranet/", false),
        ("notes example.com/", false),
        ("notes example.com?", false),
        ("notes example.com#", false),
        ("notes chrome:", false),
        ("chrome: notes", false),
        ("notes file:", false),
        ("notes about:", false),
        ("notes 127.0.0.1.", false),
        ("see (127.0.0.1).", false),
        ("notes 127.0.0.1,", false),
        ("notes 2130706433?", false),
        ("2130706433#", false),
        ("notes 0x7f000001#", false),
        ("notes chrome-search:", false),
        ("notes isolated-app:", false),
        ("notes chrome-distiller:", false),
        ("\"chrome:\" notes", false),
        ("see example.com/.", false),
        ("notes [::1].", false),
        ("notes 127。0。0。1。", false),
        ("notes 127.0.0.1。", false),
        ("notes 127｡0｡0｡1｡", false),
        ("notes 0x7f。0。0。1。", false),
        ("notes 0177。0。0。1。", false),
        ("notes 127.0.0.1.。", false),
        ("notes 127。0。0。1。、", false),
        ("notes 127。0。0。1。」", false),
        ("notes 127.0.0.1.』", false),
        ("notes 「127。0。0。1。」", false),
        ("サーバー「127.0.0.1」です", false),
        ("notes 🙂127.0.0.1🙂", false),
        ("notes «127.0.0.1»", false),
        ("「example.com」", false),
        ("notes (127.​0.0.1)", false),
        ("example.​com", false),
        ("127.​1", false),
        ("example­.com", false),
        ("❤ example.com", false),
        ("🙂 example.com", false),
        ("👍🏽 example.com", false),
        ("「こんにちは」 世界", true),
        ("サーバー「example.com」は遅い", true),
        ("notes «quoted» 🙂", true),
        ("-- done.", true),
        ("! e.g.", true),
        ("... U.S.A.", true),
        ("❤️ done.", true),
        ("notes 1984?", true),
        ("what is 42?", true),
        ("e.g. this", true),
        ("the U.S.A. today", true),
        ("version 1.2.3.", true),
        ("notes 今日は晴れ。", true),
        ("all done.", true),
        ("\"quoted words\"", true),
        ("(parenthetical note)", true),
        ("notes 127.1", true),
        ("version 1.2.3", true),
        ("2026/10/26 events", true),
        ("08:30 standup", true),
        ("re: notes", true),
        ("is it down?", true),
        ("ratio 4:3", true),
        ("1984", true),
        ("2130706433", true),
        ("0x80070005", true),
        ("0306406152", true),
        ("meeting 1/2/2026", true),
        ("at 10:30:15", true),
        ("100%", true),
        ("50%25 off", true),
        ("how to: bake bread", true),
        ("re: meeting notes", true),
        ("c++ vector", true),
        ("c++", true),
        ("what is 3.5 / 2", true),
        ("what is example.com", true),
        ("example.com is down", true),
        ("weather?", true),
        ("C#", true),
        ("C# generics", true),
        ("1/2 cup", true),
        ("10:30 meeting", true),
        ("16:9 monitor", true),
        ("@handle posts", true),
        ("#hashtag", true),
    ] {
        assert_eq!(suggestable(query), expected, "{query:?}");
    }
}

#[test]
fn developer_aliases_and_local_decoders() {
    let now = 1_700_000_000_000;
    let current = Some("https://github.com/team/project/tree/main");
    for (query, url) in [
        ("gh team/project", "https://github.com/team/project"),
        ("gh #42", "https://github.com/team/project/pull/42"),
        (
            "gh cross platform",
            "https://github.com/search?q=cross%20platform",
        ),
        (
            "npm @team/package",
            "https://www.npmjs.com/package/@team/package",
        ),
        (
            "npm build tools",
            "https://www.npmjs.com/search?q=build%20tools",
        ),
        (
            "MDN fetch()",
            "https://developer.mozilla.org/en-US/search?q=fetch()",
        ),
        ("caniuse CSS grid", "https://caniuse.com/?search=CSS%20grid"),
        (
            "so cargo test",
            "https://stackoverflow.com/search?q=cargo%20test",
        ),
    ] {
        assert_eq!(
            developer_suggestions(query, current, &[], now)[0].action,
            SuggestionAction::Open(url.into())
        );
    }
    for query in [
        "constructor hello",
        "__proto__ hello",
        "170000000000",
        "1700000000x",
    ] {
        assert!(developer_suggestions(query, current, &[], now).is_empty());
    }
    let header = json!({ "alg": "none" });
    let payload = json!({ "sub": "räksmörgås", "exp": 1_700_000_060 });
    let h = URL_SAFE_NO_PAD.encode(header.to_string());
    let p = URL_SAFE_NO_PAD.encode(payload.to_string());
    let jwt = format!("{h}.{p}.");
    let result = &developer_suggestions(&jwt, current, &[], now)[0];
    assert_eq!(
        result.label,
        "JWT · alg none · sub räksmörgås · expires in 1m"
    );
    let SuggestionAction::Copy(ref output) = result.action else {
        panic!("expected a copy action")
    };
    assert_eq!(
        serde_json::from_str::<Value>(output).unwrap(),
        json!({ "header": header, "payload": payload })
    );
    assert!(!suggestable(&jwt));
    let malformed = URL_SAFE_NO_PAD.encode(b"{\"sub\":\"\xff\"}");
    assert!(developer_suggestions(&format!("{h}.{malformed}."), current, &[], now).is_empty());
    for (query, expected) in [
        ("1700000000", "2023-11-14T22:13:20.000Z"),
        ("1700000000123", "2023-11-14T22:13:20.123Z"),
    ] {
        assert_eq!(
            developer_suggestions(query, current, &[], now)[0].action,
            SuggestionAction::Copy(expected.into())
        );
    }
}

#[test]
fn environment_switches_keep_the_location_and_follow_target_order() {
    use EnvironmentTone::{Local, Production, Staging};
    let input = "prod https://staging.example.com\nhttp://app.localhost:3030\nhttps://flecha.dev\nhttps://latest.example.com\nhttp://[::1]:8080\nhttp://0.0.0.0:8000\nhttps://staging2.example.com\nhttps://qa.appspot.com\nhttps://qa.project.appspot.com";
    let environments = [Environment {
        id: "project".into(),
        name: "Project".into(),
        targets: parse_targets(input),
    }];
    assert_eq!(format_targets(&environments[0].targets), input);
    let tones: Vec<_> = environments[0]
        .targets
        .iter()
        .map(|target| {
            describe_environment(&target.origin, &environments)
                .unwrap()
                .tone
        })
        .collect();
    assert_eq!(
        tones,
        [
            Production, Local, Production, Production, Local, Local, Staging, Production, Staging
        ]
    );
    let results = developer_suggestions(
        "ENV",
        Some("https://flecha.dev/docs?q=example#section"),
        &environments,
        0,
    );
    assert_eq!(
        results.first().unwrap().action,
        SuggestionAction::Open("https://latest.example.com/docs?q=example#section".into())
    );
    assert_eq!(
        results.last().unwrap().action,
        SuggestionAction::Open("http://app.localhost:3030/docs?q=example#section".into())
    );
    assert_eq!(
        parse_targets("203.0.113.9:3000\n192.168.1.010:3000\ntel:1234\nssh:22\nInternal intranet")
            .into_iter()
            .map(|target| target.origin)
            .collect::<Vec<_>>(),
        ["https://203.0.113.9:3000", "https://intranet"]
    );
}

#[test]
fn match_quality_follows_command_bar_order() {
    for (query, expected) in [
        ("georg", MatchQuality::Start),
        ("okee", MatchQuality::Word),
        ("effe", MatchQuality::Contains),
    ] {
        assert_eq!(match_quality(query, &["Georgia Okeeffe"]), Some(expected));
    }
    assert_eq!(
        match_quality("pin geo", &["Pin to Georgia"]),
        Some(MatchQuality::Word)
    );
}
