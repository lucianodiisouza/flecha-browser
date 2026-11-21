/**
 * The built-in ad and tracker blocker, on declarativeNetRequest: EasyList and EasyPrivacy,
 * converted to static rulesets at build time (build-adblock.mjs), switched on and off with
 * Settings' "Block ads and trackers" (state.adBlock, on unless turned off), as in Electron.
 *
 * Generic element hiding from EasyList (`##.ad-banner`) is a stylesheet registered as a content
 * script while blocking is on, left out on the sites the lists exempt from it.
 *
 * The site panel's shield turns blocking off for one site (state.adBlockAllowed, adBlockSites.ts):
 * one dynamic allowAllRequests rule for those pages, and no element hiding on them.
 */
import type { BrowserState } from '../../shared/types';

export const RULESETS = ['easylist', 'easyprivacy'];
const COSMETIC_ID = 'flecha-adblock-cosmetic';
const COSMETIC_CSS = 'rules/cosmetic.css';
const COSMETIC_EXCLUDES = 'rules/cosmetic-exclude.json';
const ALLOW_RULE_ID = 1;
/** Above every static rule (build-adblock.mjs gives them 1 to 3), so nothing on an allowed page is blocked. */
const ALLOW_PRIORITY = 4;

let applied: string | undefined;
let applying = Promise.resolve();
let listExemptions: Promise<string[]> | undefined;

/** Applies state.adBlock and state.adBlockAllowed; resolves once Chromium has them. */
export function setAdBlocking(state: Pick<BrowserState, 'adBlock' | 'adBlockAllowed'>) {
  const enabled = state.adBlock !== false;
  const allowed = state.adBlockAllowed ?? [];
  const key = JSON.stringify([enabled, allowed]);
  applying = applying.then(async () => {
    if (applied === key) return;
    applied = key;
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets(enabled ? { enableRulesetIds: RULESETS } : { disableRulesetIds: RULESETS });
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ALLOW_RULE_ID],
        addRules: allowed.length
          ? [
              {
                id: ALLOW_RULE_ID,
                priority: ALLOW_PRIORITY,
                // A page on an allowed site, and everything it and its frames load.
                action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW_ALL_REQUESTS },
                condition: { requestDomains: [...allowed], resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME] },
              },
            ]
          : [],
      });
      await setCosmetic(enabled, allowed);
    } catch (err) {
      applied = undefined;
      console.error('Flecha: the ad blocker failed', err);
    }
  });
  return applying;
}

async function setCosmetic(enabled: boolean, allowed: readonly string[]) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [COSMETIC_ID] });
  if (!enabled) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [COSMETIC_ID] });
    return;
  }
  listExemptions ??= fetch(chrome.runtime.getURL(COSMETIC_EXCLUDES))
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .catch(() => [] as string[]);
  const excludeMatches = [...new Set([...(await listExemptions), ...allowed.flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`])])];
  const script: chrome.scripting.RegisteredContentScript = {
    id: COSMETIC_ID,
    matches: ['http://*/*', 'https://*/*'],
    excludeMatches,
    css: [COSMETIC_CSS],
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true,
  };
  // Updated even when unchanged here: the script persists across sessions, from an older list too.
  await (existing.length ? chrome.scripting.updateContentScripts([script]) : chrome.scripting.registerContentScripts([script]));
}
