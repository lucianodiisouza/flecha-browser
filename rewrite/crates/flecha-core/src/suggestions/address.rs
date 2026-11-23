use url::{Host, Url};

use super::{decode_component, encode_component};
use crate::SearchEngine;

pub fn resolve_input(raw: &str, engine: SearchEngine) -> String {
    let input = raw.trim();
    if let Some(address) = web_address(input) {
        return address;
    }
    if input.is_empty() || rejected_address(input) {
        return "about:blank".into();
    }
    engine.search_url(input)
}

pub fn web_address(raw: &str) -> Option<String> {
    address(raw, false)
}

pub fn pinnable_address(raw: &str) -> Option<String> {
    let url = Url::parse(&web_address(raw)?).ok()?;
    (matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank").then(|| url.into())
}

fn has_credentials(input: &str) -> bool {
    let input = input.trim();
    let Some((userinfo, destination)) = input.split_once('@') else {
        return false;
    };
    if userinfo.is_empty() || destination.starts_with(char::is_whitespace) {
        return false;
    }
    let has_tail = re!(r"^[^\s/?#\\]+[/?#\\]").is_match(destination);
    match userinfo.split_once(':') {
        Some((name, password)) if !name.contains(['/', '?', '#']) => {
            has_tail
                || !password.starts_with(char::is_whitespace)
                || password.trim().contains(char::is_whitespace)
        }
        None => {
            !userinfo.contains(['/', '?', '#'])
                && (has_tail || !userinfo.contains(char::is_whitespace))
        }
        _ => false,
    }
}

pub fn rejected_address(raw: &str) -> bool {
    if has_credentials(raw) {
        return true;
    }
    let input = raw.replace('？', "?");
    let split = input.find(['/', '?', '#', '\\']).unwrap_or(input.len());
    let (typed, tail) = input.split_at(split);
    let decoded = decode_component(typed);
    let authority =
        re!(r"(?i)[。．｡]|%2e|%e3%80%82|%ef%bc%8e|%ef%bd%a1").replace_all(&decoded, ".");
    let authority = authority.trim();
    if has_credentials(&format!("{authority}{tail}"))
        || re!(r"^\[[^\s\[\]]*:[^\s\[\]]*(?:\]|$)").is_match(authority)
        || (re!(r"(?i)^[0-9a-f:.]+(?:%[a-z0-9_.-]+)?$").is_match(authority)
            && (authority.contains("::") || authority.matches(':').count() >= 3))
    {
        return true;
    }
    let (host, port) = authority
        .split_once(':')
        .map_or((authority, None), |(host, port)| {
            (host.trim(), Some(port.trim()))
        });
    let address_tail = re!(r"^[/\\?#]\S").is_match(tail) || tail.contains('=');
    let numeric_port = port.is_some_and(|port| {
        re!(r"^[+-]?[0-9]").is_match(port) && !port.contains(char::is_whitespace)
    });
    if re!(r"(?i)^localhost$|^[^\s.@]+\.[^\s@]+$").is_match(host) {
        if port.is_some() {
            return !typed.contains(char::is_whitespace) || address_tail || numeric_port;
        }
        let separated_question = typed.ends_with(char::is_whitespace)
            && re!(r"(?i)^\?\s+(?:\S+\s+\S|(?:who|what|when|where|why|which|how)\?$)")
                .is_match(tail)
            && !tail.contains('=');
        return !tail.is_empty() && !separated_question;
    }
    port.is_some()
        && !tail.is_empty()
        && (address_tail || numeric_port)
        && re!(r"(?i)^[a-z0-9-]*[a-z][a-z0-9-]*$").is_match(host)
}

pub(super) fn address(raw: &str, allow_bare_host: bool) -> Option<String> {
    let input = raw.trim();
    if re!(r"(?i)^(about|data):").is_match(input) {
        return Some(escape_controls(input));
    }
    if let Some(authority) = re!(r"(?i)^[a-z][a-z0-9+.-]*://[^/?#\\]*").find(input) {
        let authority = authority.as_str();
        return Some(format!(
            "{}{}",
            authority.replace(['\t', '\n', '\r'], ""),
            escape_controls(&input[authority.len()..])
        ));
    }
    if re!(r"(?i)^file:").is_match(input) {
        return Some(escape_controls(input));
    }
    if re!(r"(?i)^mailto:").is_match(input) {
        let recipient = input[7..].split('?').next().unwrap_or_default();
        return (!recipient.contains(char::is_whitespace)).then(|| input.into());
    }
    let end = input.find(['/', '?', '#']).unwrap_or(input.len());
    let (authority, tail) = input.split_at(end);
    let bare = re!(r"(?i)^(\[[0-9a-f:.]+\]|[^:\s\\@\[\]]+)(?::([0-9]+))?$").captures(authority)?;
    let host = &bare[1];
    if bare.get(2).is_some()
        && re!(r"(?i)^(blob|ftp|http|https|news|sms|ssh|tel|urn)$").is_match(host)
    {
        return None;
    }
    let endpoint = format!("{authority}{}", escape_controls(tail));
    let parsed = Url::parse(&format!("https://{endpoint}")).ok()?;
    let local = match parsed.host()? {
        Host::Ipv4(address) => {
            // WHATWG permits numeric shorthand and octal IPv4; Flecha accepts canonical quads.
            if address.to_string() != host.trim_end_matches('.') {
                return None;
            }
            address.is_loopback() || address.is_private() || address.is_unspecified()
        }
        Host::Ipv6(address) => address.is_loopback(),
        Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.');
            let local = re!(r"(?i)^(?:[a-z0-9.-]+\.)?localhost$").is_match(domain);
            let idn = re!(r"(?i)\.xn--[a-z0-9-]+$").is_match(domain)
                && re!(r"[.。．｡][\p{L}\p{M}\p{N}-]+[.。．｡]?$").is_match(host);
            if !local && !idn && !re!(r"(?i)\.[a-z]{2,}$").is_match(domain) && !allow_bare_host {
                return None;
            }
            local
        }
    };
    let scheme = if local { "http" } else { "https" };
    let result = format!("{scheme}://{endpoint}");
    if input.contains(char::is_whitespace) {
        Url::parse(&result).ok().map(Into::into)
    } else {
        Some(result)
    }
}

fn escape_controls(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    for character in text.chars() {
        if matches!(character, '\t' | '\n' | '\r') {
            result.push_str(&encode_component(character.encode_utf8(&mut [0; 4])));
        } else {
            result.push(character);
        }
    }
    result
}
