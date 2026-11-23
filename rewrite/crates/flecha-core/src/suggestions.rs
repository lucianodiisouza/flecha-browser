//! Local command-bar suggestions and the search engine's response format.

use std::collections::BTreeSet;

use base64::{Engine as _, engine::general_purpose};
use chrono::{DateTime, SecondsFormat};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;
use url::{Host, Url};

use crate::{Environment, EnvironmentTarget, EpochMillis, SearchEngine};

macro_rules! re {
    ($pattern:literal) => {{
        static REGEX: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
        &*REGEX
    }};
}

mod address;

pub use address::{pinnable_address, rejected_address, resolve_input, web_address};

/// Chromium's default minimum interval between suggestion requests.
pub const SUGGEST_INTERVAL_MS: EpochMillis = 100;
/// Chromium's desktop popup holds eight rows, one for the typed search.
pub const MAX_SUGGESTIONS: usize = 7;

const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn encode_component(text: &str) -> String {
    utf8_percent_encode(text, URI_COMPONENT).to_string()
}

impl SearchEngine {
    pub fn name(self) -> &'static str {
        match self {
            Self::Google => "Google",
            Self::DuckDuckGo => "DuckDuckGo",
            Self::Bing => "Bing",
            Self::Brave => "Brave Search",
            Self::Kagi => "Kagi",
            Self::Ecosia => "Ecosia",
        }
    }

    pub fn search_url(self, terms: &str) -> String {
        let prefix = match self {
            Self::Google => "https://www.google.com/search?q=",
            Self::DuckDuckGo => "https://duckduckgo.com/?q=",
            Self::Bing => "https://www.bing.com/search?q=",
            Self::Brave => "https://search.brave.com/search?q=",
            Self::Kagi => "https://kagi.com/search?q=",
            Self::Ecosia => "https://www.ecosia.org/search?q=",
        };
        format!("{prefix}{}", encode_component(terms))
    }

    pub fn suggestion_url(self, input: &str) -> Option<String> {
        let query = input.trim();
        if !suggestable(query) {
            return None;
        }
        let (prefix, suffix) = match self {
            Self::Google => (
                "https://www.google.com/complete/search?client=chrome-omni&q=",
                "",
            ),
            Self::DuckDuckGo => ("https://duckduckgo.com/ac/?q=", "&type=list"),
            Self::Bing => ("https://www.bing.com/osjson.aspx?query=", ""),
            Self::Brave => ("https://search.brave.com/api/suggest?q=", ""),
            Self::Kagi => ("https://kagisuggest.com/api/autosuggest?q=", ""),
            Self::Ecosia => ("https://ac.ecosia.org/?q=", "&type=list"),
        };
        Some(format!("{prefix}{}{suffix}", encode_component(query)))
    }
}

pub fn parse_suggestions(body: &str, query: &str) -> Vec<String> {
    let body = if body.starts_with(")]}'") {
        body.split_once('\n').map_or("", |(_, json)| json)
    } else {
        body
    };
    let Ok(Value::Array(root)) = serde_json::from_str(body) else {
        return Vec::new();
    };
    if root.first().and_then(Value::as_str) != Some(query) {
        return Vec::new();
    }
    let Some(entries) = root.get(1).and_then(Value::as_array) else {
        return Vec::new();
    };
    let types = root
        .get(4)
        .and_then(|meta| meta.get("google:suggesttype"))
        .and_then(Value::as_array);
    let mut seen = BTreeSet::from([query.to_lowercase()]);
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            if matches!(
                types
                    .and_then(|types| types.get(index))
                    .and_then(Value::as_str),
                Some("NAVIGATION" | "CALCULATOR")
            ) {
                return None;
            }
            let text = entry.as_str()?.trim();
            (!text.is_empty() && seen.insert(text.to_lowercase())).then(|| text.to_owned())
        })
        .take(MAX_SUGGESTIONS)
        .collect()
}

/// Keep addresses, credentials, and private paths out of search suggestion requests.
pub fn suggestable(raw: &str) -> bool {
    let query = raw.trim();
    if query.is_empty()
        || web_address(query).is_some()
        || rejected_address(query)
        || jwt_parts(query).is_some()
    {
        return false;
    }
    let normalized: String = query.nfkc().collect();
    let separator = re!(r"[^\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}\x21-\x7e。．｡]+");
    let alone = normalized
        .split_whitespace()
        .flat_map(|word| separator.split(word))
        .filter(|part| !part.is_empty())
        .count()
        == 1;
    let punct_start = re!(r#"^[("'“‘\[]+"#);
    let punct_end = re!(r#"[.。．｡,;:!)"'”’\]]+$"#);
    for word in normalized.split_whitespace() {
        let decoded: String = decode_component(word).chars().nfkc().collect();
        for form in [word, decoded.as_str()] {
            for part in std::iter::once(form).chain(separator.split(form)) {
                let unwrapped = punct_start.replace(part, "");
                let unwrapped = punct_end.replace(&unwrapped, "");
                if address_part(part, alone) || address_part(&unwrapped, alone) {
                    return false;
                }
            }
        }
    }
    true
}

fn decode_component(word: &str) -> std::borrow::Cow<'_, str> {
    let escapes = word
        .as_bytes()
        .iter()
        .enumerate()
        .filter(|&(_, byte)| *byte == b'%');
    if escapes.into_iter().any(|(pos, _)| {
        !word
            .as_bytes()
            .get(pos + 1..pos + 3)
            .is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit))
    }) {
        return word.into();
    }
    percent_decode_str(word)
        .decode_utf8()
        .unwrap_or_else(|_| word.into())
}

fn address_part(word: &str, alone: bool) -> bool {
    const SCHEMES: &[&str] = &[
        "about",
        "blob",
        "chrome",
        "chrome-distiller",
        "chrome-extension",
        "chrome-search",
        "chrome-untrusted",
        "data",
        "devtools",
        "file",
        "filesystem",
        "http",
        "https",
        "isolated-app",
        "ws",
        "wss",
        "chrome-error",
        "ftp",
        "javascript",
        "mailto",
        "tel",
        "view-source",
        "webcal",
    ];
    if let Some(matched) = re!(r"(?i)^([a-z][a-z0-9+.-]*):(\S?)").captures(word)
        && (alone
            || !matched[2].is_empty()
            || SCHEMES.contains(&matched[1].to_ascii_lowercase().as_str()))
    {
        return true;
    }
    if re!(r"^(~|\.{1,2})?[\\/]\S").is_match(word) {
        return true;
    }
    if re!(r"\S[/\\?#@:]\S").is_match(word) {
        let numeric_pair = re!(r"^([0-9]+)(?:[/:][0-9]+)+$")
            .captures(word)
            .and_then(|parts| parts[1].parse::<u32>().ok())
            .is_some_and(|first| first < 2_u32.pow(24));
        if !numeric_pair {
            return true;
        }
    }
    if re!(r"\S[/\\]$").is_match(word)
        || word
            .strip_suffix(['?', '#'])
            .is_some_and(|host| is_host(host) || opens_as_ip(host))
    {
        return true;
    }
    let dots = ['.', '。', '．', '｡'];
    let dotted_quad = word.strip_suffix(dots).unwrap_or(word).split(dots).count() == 4
        && Url::parse(&format!("http://{word}"))
            .is_ok_and(|url| matches!(url.host(), Some(Host::Ipv4(_))));
    dotted_quad || (alone && (is_host(word) || word.contains(['/', '\\'])))
}

fn is_host(word: &str) -> bool {
    re!(r"(?i)[.\[。．｡]|localhost").is_match(word)
        && Url::parse(&format!("http://{word}")).is_ok_and(|url| match url.host() {
            Some(Host::Domain(host)) => host.contains('.') || host == "localhost",
            Some(Host::Ipv4(_) | Host::Ipv6(_)) => true,
            None => false,
        })
}

fn opens_as_ip(word: &str) -> bool {
    Url::parse(&format!("http://{word}"))
        .is_ok_and(|url| matches!(url.host(), Some(Host::Ipv4(host)) if host.octets()[0] != 0))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SuggestionAction {
    Open(String),
    Copy(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeveloperSuggestion {
    pub label: String,
    pub detail: String,
    pub action: SuggestionAction,
}

pub fn developer_suggestions(
    query: &str,
    current_url: Option<&str>,
    environments: &[Environment],
    now: EpochMillis,
) -> Vec<DeveloperSuggestion> {
    let query = query.trim();
    if re!(r"(?i-u)^env\b").is_match(query) {
        let Some(env) = current_url.and_then(|url| describe_environment(url, environments)) else {
            return Vec::new();
        };
        return env
            .switches
            .into_iter()
            .map(|switch| DeveloperSuggestion {
                label: format!("Switch to {}", switch.label),
                detail: Url::parse(&switch.url)
                    .map_or_else(|_| String::new(), |url| host_and_port(&url)),
                action: SuggestionAction::Open(switch.url),
            })
            .collect();
    }
    let mut words = query.split_whitespace();
    if let Some(alias) = words.next() {
        let arg = words.collect::<Vec<_>>().join(" ");
        if !arg.is_empty()
            && let Some(suggestion) = developer_alias(alias, &arg, current_url)
        {
            return vec![suggestion];
        }
    }
    decode_jwt(query, now)
        .or_else(|| decode_timestamp(query, now))
        .into_iter()
        .collect()
}

fn developer_alias(
    alias: &str,
    arg: &str,
    current_url: Option<&str>,
) -> Option<DeveloperSuggestion> {
    if alias == "gh" {
        return Some(github(arg, current_url));
    }
    let (name, url) = match alias.to_ascii_lowercase().as_str() {
        "npm" if !arg.contains(' ') => ("npm", format!("https://www.npmjs.com/package/{arg}")),
        "npm" => (
            "npm",
            format!("https://www.npmjs.com/search?q={}", encode_component(arg)),
        ),
        "mdn" => (
            "MDN",
            format!(
                "https://developer.mozilla.org/en-US/search?q={}",
                encode_component(arg)
            ),
        ),
        "caniuse" => (
            "Can I use",
            format!("https://caniuse.com/?search={}", encode_component(arg)),
        ),
        "so" => (
            "Stack Overflow",
            format!(
                "https://stackoverflow.com/search?q={}",
                encode_component(arg)
            ),
        ),
        _ => return None,
    };
    Some(DeveloperSuggestion {
        label: arg.into(),
        detail: format!("Open in {name}"),
        action: SuggestionAction::Open(url),
    })
}

fn github(arg: &str, current_url: Option<&str>) -> DeveloperSuggestion {
    let (label, detail, url) = if re!(r"^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$").is_match(arg) {
        (
            arg.into(),
            "Open on GitHub",
            format!("https://github.com/{arg}"),
        )
    } else if let Some(number) = re!(r"^#?([0-9]+)$").captures(arg).and_then(|m| m.get(1))
        && let Some(repo) = current_url
            .and_then(|url| {
                re!(r"^https://github\.com/([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)").captures(url)
            })
            .and_then(|m| m.get(1))
    {
        let (repo, number) = (repo.as_str(), number.as_str());
        (
            format!("{repo}#{number}"),
            "Open pull request or issue",
            format!("https://github.com/{repo}/pull/{number}"),
        )
    } else {
        (
            arg.into(),
            "Search GitHub",
            format!("https://github.com/search?q={}", encode_component(arg)),
        )
    };
    DeveloperSuggestion {
        label,
        detail: detail.into(),
        action: SuggestionAction::Open(url),
    }
}

fn jwt_parts(text: &str) -> Option<(&str, &str)> {
    let (header, rest) = text
        .strip_prefix("eyJ")
        .is_some()
        .then(|| text.split_once('.'))??;
    let (payload, signature) = rest.split_once('.')?;
    (!signature.contains('.')).then_some((header, payload))
}

fn decode_jwt(text: &str, now: EpochMillis) -> Option<DeveloperSuggestion> {
    let (header, payload) = jwt_parts(text)?;
    let decode = |part: &str| {
        let part = part.replace('-', "+").replace('_', "/");
        let part = part.trim_matches([' ', '\t', '\r', '\n', '\x0c']);
        let bytes = general_purpose::STANDARD_NO_PAD
            .decode(part)
            .or_else(|_| general_purpose::STANDARD.decode(part))
            .ok()?;
        serde_json::from_slice::<Value>(&bytes).ok()
    };
    let header = decode(header)?;
    let payload = decode(payload)?;
    if payload.is_null() {
        return None;
    }
    let mut facts = Vec::new();
    for (key, value) in [("alg", header.get("alg")), ("sub", payload.get("sub"))] {
        if let Some(value) = value
            && !matches!(value, Value::Null | Value::Bool(false))
            && value.as_str() != Some("")
            && value.as_f64() != Some(0.0)
        {
            facts.push(format!(
                "{key} {}",
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_owned)
            ));
        }
    }
    if let Some(expiry) = payload.get("exp").and_then(Value::as_f64) {
        let expiry = (expiry * 1000.0) as EpochMillis;
        let age = relative(expiry.abs_diff(now));
        facts.push(if expiry < now {
            format!("expired {age} ago")
        } else {
            format!("expires in {age}")
        });
    }
    let description = if facts.is_empty() {
        "decoded".into()
    } else {
        facts.join(" · ")
    };
    let copy =
        serde_json::to_string_pretty(&json!({ "header": header, "payload": payload })).ok()?;
    Some(DeveloperSuggestion {
        label: format!("JWT · {description}"),
        detail: "Copy decoded JSON".into(),
        action: SuggestionAction::Copy(copy),
    })
}

fn decode_timestamp(text: &str, now: EpochMillis) -> Option<DeveloperSuggestion> {
    if !re!(r"^[0-9]{10}(?:[0-9]{3})?$").is_match(text) {
        return None;
    }
    let value = text.parse::<EpochMillis>().ok()?;
    let millis = if text.len() == 10 {
        value * 1000
    } else {
        value
    };
    let date = DateTime::from_timestamp_millis(millis)?;
    let offset = i128::from(millis) - i128::from(now);
    let age = relative(millis.abs_diff(now));
    let age = if offset < 0 {
        format!("{age} ago")
    } else {
        format!("in {age}")
    };
    Some(DeveloperSuggestion {
        label: format!("{} · {age}", date.format("%Y-%m-%d %H:%M:%S UTC")),
        detail: "Copy ISO date".into(),
        action: SuggestionAction::Copy(date.to_rfc3339_opts(SecondsFormat::Millis, true)),
    })
}

fn relative(millis: u64) -> String {
    for (size, unit) in [(86_400_000, 'd'), (3_600_000, 'h'), (60_000, 'm')] {
        if millis >= size {
            return format!("{}{unit}", millis / size);
        }
    }
    format!("{}s", millis / 1000)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentTone {
    Local,
    Staging,
    Production,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentSwitch {
    pub label: String,
    pub tone: EnvironmentTone,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveEnvironment {
    pub name: String,
    pub label: String,
    pub tone: EnvironmentTone,
    pub switches: Vec<EnvironmentSwitch>,
}

pub fn describe_environment(url: &str, environments: &[Environment]) -> Option<ActiveEnvironment> {
    let current = Url::parse(url).ok()?;
    let origin = current.origin().ascii_serialization();
    let (env, index) = environments.iter().find_map(|env| {
        Some((
            env,
            env.targets
                .iter()
                .position(|target| target.origin == origin)?,
        ))
    })?;
    let target = &env.targets[index];
    let switches = env.targets[index + 1..]
        .iter()
        .chain(&env.targets[..index])
        .filter_map(|target| {
            let url = Url::parse(&target.origin).ok()?;
            if !matches!(url.scheme(), "http" | "https")
                || url.origin().ascii_serialization() != target.origin
            {
                return None;
            }
            let path = &current[url::Position::BeforePath..];
            Some(EnvironmentSwitch {
                label: target.label.clone(),
                tone: environment_tone(target),
                url: format!("{}{path}", target.origin),
            })
        })
        .collect();
    Some(ActiveEnvironment {
        name: env.name.clone(),
        label: target.label.clone(),
        tone: environment_tone(target),
        switches,
    })
}

pub fn parse_targets(text: &str) -> Vec<EnvironmentTarget> {
    text.lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            let (raw, label) = parts.split_last()?;
            let url = Url::parse(&address::address(raw, true)?).ok()?;
            if !matches!(url.scheme(), "http" | "https") {
                return None;
            }
            let auto_label = label.is_empty();
            let label = if auto_label {
                host_and_port(&url)
            } else {
                label.join(" ")
            };
            Some(EnvironmentTarget {
                label,
                origin: url.origin().ascii_serialization(),
                auto_label: Some(auto_label),
            })
        })
        .collect()
}

pub fn format_targets(targets: &[EnvironmentTarget]) -> String {
    targets
        .iter()
        .map(|target| {
            if auto_label(target) {
                target.origin.clone()
            } else {
                format!("{} {}", target.label, target.origin)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn auto_label(target: &EnvironmentTarget) -> bool {
    target
        .auto_label
        .unwrap_or_else(|| target.label == without_scheme(&target.origin))
}

fn without_scheme(url: &str) -> &str {
    re!(r"(?i)^[a-z]+://")
        .find(url)
        .map_or(url, |scheme| &url[scheme.end()..])
}

fn host_and_port(url: &Url) -> String {
    url[url::Position::BeforeHost..url::Position::AfterPort].into()
}

fn environment_tone(target: &EnvironmentTarget) -> EnvironmentTone {
    use EnvironmentTone::{Local, Production, Staging};
    let label = if auto_label(target) {
        String::new()
    } else {
        target.label.to_lowercase().replace('_', " ")
    };
    let staging = re!(
        r"(?-u:\b)(?:stag(?:e|ing)|preview|qa|test(?:ing)?|dev(?:elop(?:ment)?)?|sandbox|uat)[0-9]*(?-u:\b)"
    );
    if re!(r"(?-u:\b)prod(?:uction)?(?-u:\b)").is_match(&label) {
        return Production;
    }
    if re!(r"(?-u:\b)local(?-u:\b)").is_match(&label) {
        return Local;
    }
    if staging.is_match(&label) {
        return Staging;
    }
    let Ok(url) = Url::parse(&target.origin) else {
        return Production;
    };
    if matches!(url.host(), Some(Host::Ipv4(ip)) if ip.is_loopback() || ip.is_unspecified())
        || matches!(url.host(), Some(Host::Ipv6(ip)) if ip.is_loopback())
    {
        return Local;
    }
    let hostname = url.host_str().unwrap_or_default().trim_end_matches('.');
    if matches!(hostname, "local" | "localhost")
        || [".localhost", ".test", ".local"]
            .iter()
            .any(|suffix| hostname.ends_with(suffix))
    {
        return Local;
    }
    let subdomains = if hostname.contains('.') {
        psl::domain_str(hostname)
            .and_then(|domain| hostname.strip_suffix(domain))
            .unwrap_or("")
    } else {
        hostname
    };
    if staging.is_match(subdomains) {
        Staging
    } else {
        Production
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MatchQuality {
    Contains,
    Word,
    Start,
}

pub fn match_quality(query: &str, texts: &[&str]) -> Option<MatchQuality> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return None;
    }
    let texts: Vec<_> = texts.iter().map(|text| text.to_lowercase()).collect();
    if texts.iter().any(|text| text.starts_with(&query)) {
        return Some(MatchQuality::Start);
    }
    let separator = re!(r"[^\p{L}\p{N}]+");
    let words: Vec<_> = separator
        .split(&query)
        .filter(|word| !word.is_empty())
        .collect();
    let candidates: Vec<_> = texts
        .iter()
        .flat_map(|text| separator.split(text))
        .collect();
    if !words.is_empty()
        && words.iter().all(|word| {
            candidates
                .iter()
                .any(|candidate| candidate.starts_with(word))
        })
    {
        return Some(MatchQuality::Word);
    }
    texts
        .iter()
        .any(|text| text.contains(&query))
        .then_some(MatchQuality::Contains)
}

pub fn display_url(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return url.into();
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return url.into();
    }
    let address = &parsed[url::Position::BeforeHost..url::Position::AfterQuery];
    let address = address.strip_prefix("www.").unwrap_or(address);
    address.strip_suffix('/').unwrap_or(address).into()
}
