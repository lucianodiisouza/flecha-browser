/**
 * Search suggestions for the command bar, asked for and read the way Chromium's omnibox does
 * (components/omnibox/browser/search_provider.cc and search_suggestion_parser.cc).
 */
import type { SearchEngineId } from '../../shared/types';
import { looksLikeRejectedAddress, searchEngine, spacedQuestion, webAddress } from './url';

/** Chromium's kDefaultMinimumTimeBetweenSuggestQueriesMs (omnibox_field_trial.cc), measured from the last request sent. */
export const SUGGEST_INTERVAL_MS = 100;

/** Chromium's desktop popup holds 8 matches (AutocompleteResult::GetMaxMatches); the typed search is one of them. */
export const MAX_SUGGESTIONS = 7;

/** A host the browser would open, in any spelling it accepts: `127.1`, `example.com.`, `example。com`, `[::1]`. */
function isHost(word: string): boolean {
  if (!/[.\[。．｡]|localhost/i.test(word)) return false;
  try {
    const { hostname } = new URL(`http://${word}`);
    return hostname.includes('.') || hostname.startsWith('[') || hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * An IPv4 address typed in four parts, which Chromium's omnibox always takes for one
 * (autocomplete_input.cc). A trailing dot, in any spelling, isn't a fifth part: `127。0。0。1。`.
 */
function isDottedQuad(word: string): boolean {
  if (word.replace(/[.。．｡]$/, '').split(/[.。．｡]/).length !== 4) return false;
  try {
    return /^\d+\.\d+\.\d+\.\d+$/.test(new URL(`http://${word}`).hostname);
  } catch {
    return false;
  }
}

/**
 * A word the browser reads as an IPv4 address it would open: first octet not zero, as Chromium's
 * omnibox requires (autocomplete_input.cc). 2130706433 and 0x7f000001 are 127.0.0.1; 1984 is 0.0.7.192.
 */
function opensAsIp(word: string): boolean {
  try {
    return /^[1-9]\d*\.\d+\.\d+\.\d+$/.test(new URL(`http://${word}`).hostname);
  } catch {
    return false;
  }
}

/**
 * A fraction, date or time (1/2, 1/2/2026, 10:30), not a host with a port or path: its first
 * number, read as an IP address, has first octet zero, which Chromium's omnibox never opens
 * (autocomplete_input.cc). 2130706433:80 is 127.0.0.1:80.
 */
function isNumberPair(word: string): boolean {
  const first = /^(\d+)(?:[/:]\d+)+$/.exec(word)?.[1];
  return first !== undefined && Number(first) < 2 ** 24;
}

/**
 * Schemes the browser opens rather than searches for: those it handles itself
 * (ProfileIOData::IsHandledProtocol, profile_io_data.cc), and others it opens or hands to an app
 * (url_constants.h files).
 */
const SCHEMES = new Set([
  ...['about', 'blob', 'chrome', 'chrome-distiller', 'chrome-extension', 'chrome-search', 'chrome-untrusted', 'data', 'devtools'],
  ...['file', 'filesystem', 'http', 'https', 'isolated-app', 'ws', 'wss'],
  ...['chrome-error', 'ftp', 'javascript', 'mailto', 'tel', 'view-source', 'webcal'],
]);

/**
 * Whether one word could carry part of an address. It is read as typed, not as parsed: parsing
 * drops a path like `/private/..` and a default port, which were still typed. `alone`: it is all
 * that was typed.
 */
function addressPart(word: string, alone: boolean): boolean {
  // A scheme: chrome:, javascript:…, user:password@host, https:host/…, site:…, C:\…; among other
  // words a bare one only if the browser opens it, so "re: notes" is a search.
  const scheme = /^([a-z][a-z0-9+.-]*):(\S?)/i.exec(word);
  if (scheme && (alone || scheme[2] || SCHEMES.has(scheme[1].toLowerCase()))) return true;
  // A path: /home/…, ~/…, ./…, \\server\…
  if (/^(~|\.{1,2})?[\\/]\S/.test(word)) return true;
  // A host with a login, port, path, query or fragment: `/ \ ? # @ :` between characters.
  if (/\S[/\\?#@:]\S/.test(word) && !isNumberPair(word)) return true;
  // A trailing slash makes a word an address, as in Chromium's omnibox; so does `?` or `#` after a host.
  if (/\S[/\\]$/.test(word) || (/\S[?#]$/.test(word) && (isHost(word.slice(0, -1)) || opensAsIp(word.slice(0, -1))))) return true;
  if (isDottedQuad(word)) return true;
  return alone && (isHost(word) || /[/\\]/.test(word));
}

/** The word with its percent escapes decoded, as the URL parser reads a host: `%65xample%2ecom`. */
function unescaped(word: string): string {
  try {
    return decodeURIComponent(word);
  } catch {
    return word;
  }
}

/**
 * Characters that end an address in text written without spaces: neither a letter, a digit nor
 * ASCII, other than the full stops the URL parser reads as dots and the invisible characters it
 * drops (`example.\u{200b}com` is example.com). `「127。0。0。1」、`, `🙂127.0.0.1`.
 */
const NOT_IN_ADDRESS = /[^\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}\x21-\x7e。．｡]+/u;

/**
 * The spellings of a word to check: as typed, decoded, each part between characters that can't be
 * in an address, and each of those without the punctuation of the sentence around it
 * ("(127.0.0.1).", "example.com/,", "127。0。0。1。"). Address delimiters `/ ? #` stay. Every
 * spelling is an extra check: none replaces another.
 */
function spellings(word: string): string[] {
  const forms = [word, unescaped(word).normalize('NFKC')];
  const parts = [...forms, ...forms.flatMap((form) => form.split(NOT_IN_ADDRESS))];
  return [...parts, ...parts.map((part) => part.replace(/^[("'“‘[]+/, '').replace(/[.。．｡,;:!)"'”’\]]+$/, ''))];
}

/**
 * Whether `query` may be sent to the search engine: nothing that could carry part of an address,
 * internal page or file path. Stricter than Chromium's IsQueryPotentiallyPrivate
 * (search_provider.cc), which holds back logins, ports, queries and https paths but sends a host:
 * here a host typed alone isn't sent either, and some searches aren't ("and/or", "site:x.com
 * cats"). A host among other words is ("example.com is down"), as are "re: notes", "C# generics",
 * "1/2 cup" and "10:30 meeting". A lone number is sent, as Chromium does: one number is "likely a
 * query" (AutocompleteInput::Parse, autocomplete_input.cc), even when it also spells an IPv4
 * address (2130706433, 0x7f000001); blocking those would block "1984", ISBNs and error codes.
 * Among other words, a number in two or three parts is too ("notes 127.1", "version 1.2.3"),
 * which Chromium calls "almost certainly a query"; one in four parts isn't.
 */
export function suggestable(query: string): boolean {
  const q = query.trim();
  if (!q || webAddress(q) || looksLikeRejectedAddress(q)) return false;
  const words = q.normalize('NFKC').split(/\s+/);
  const first = words[0];
  if (first.endsWith('?') && spacedQuestion(q.slice(q.indexOf('?'))) && isHost(first.slice(0, -1))) {
    words[0] = first.slice(0, -1);
  }
  // Text with no spaces is more than one word where something that can't be in an address splits it.
  const alone = words.flatMap((word) => word.split(NOT_IN_ADDRESS)).filter(Boolean).length === 1;
  return !words.some((word) => spellings(word).some((form) => form && addressPart(form, alone)));
}

/**
 * The query suggestions in an engine's answer to `query`, best first. Like Chromium, an answer
 * for another query counts as none, and Google's navigation and calculator entries are left out:
 * they aren't searches.
 */
export function parseSuggestions(body: string, query: string): string[] {
  let root: unknown;
  try {
    // Google's optional XSSI guard: )]}'
    root = JSON.parse(body.replace(/^\)\]\}'[^\n]*\n?/, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(root) || root[0] !== query || !Array.isArray(root[1])) return [];
  const metadata = root[4] && typeof root[4] === 'object' ? (root[4] as Record<string, unknown>) : {};
  const types = Array.isArray(metadata['google:suggesttype']) ? (metadata['google:suggesttype'] as unknown[]) : [];
  const seen = new Set([query.toLowerCase()]);
  const suggestions: string[] = [];
  root[1].forEach((entry: unknown, i) => {
    if (typeof entry !== 'string' || types[i] === 'NAVIGATION' || types[i] === 'CALCULATOR') return;
    const text = entry.trim();
    if (!text || seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    suggestions.push(text);
  });
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

/** Asks the engine for suggestions. Rejects when offline or aborted; a failed answer has none. */
export async function fetchSuggestions(
  engine: SearchEngineId | undefined,
  query: string,
  signal: AbortSignal,
  load: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<string[]> {
  // Without cookies: Chromium sends them but never stores what comes back
  // (LOAD_DO_NOT_SAVE_COOKIES), which fetch can't do, so none go either way.
  const response = await load(searchEngine(engine).suggest.replace('%s', encodeURIComponent(query)), { signal, credentials: 'omit' });
  if (!response.ok) return [];
  return parseSuggestions(decode(await response.arrayBuffer(), response.headers.get('content-type')), query);
}

/** Some engines answer in the charset their Content-Type names, not UTF-8 (SearchSuggestionParser::ExtractJsonData). */
function decode(bytes: ArrayBuffer, contentType: string | null) {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export interface SuggestClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SuggestClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Asks for suggestions as the query changes; call it with each new query, or with undefined to
 * stop. Only the latest query's suggestions reach `show`: a new call aborts the request in flight
 * and drops any answer still to come. Requests go at most every SUGGEST_INTERVAL_MS. A failure
 * shows no suggestions for its query, so none shown before stay.
 */
export function suggestionRequests(
  load: (query: string, signal: AbortSignal) => Promise<string[]>,
  show: (query: string, suggestions: string[]) => void,
  clock: SuggestClock = realClock,
) {
  let timer: unknown;
  let current: AbortController | undefined;
  let lastSent = -Infinity;
  return (query: string | undefined) => {
    clock.clearTimeout(timer);
    current?.abort();
    current = undefined;
    if (!query) return;
    const controller = (current = new AbortController());
    const send = () => {
      lastSent = clock.now();
      const latest = () => current === controller && !controller.signal.aborted;
      load(query, controller.signal).then(
        (suggestions) => latest() && show(query, suggestions),
        () => latest() && show(query, []),
      );
    };
    const wait = SUGGEST_INTERVAL_MS - (clock.now() - lastSent);
    if (wait > 0) timer = clock.setTimeout(send, wait);
    else send();
  };
}
